import type { LearningLevel } from "./publicConfig";
import {
  AZURE_KEY_PHRASE,
  AZURE_KEY_PHRASE_ENABLED,
  AZURE_KEY_PHRASE_MONTHLY_RECORD_BUDGET,
  AZURE_PHASE_MAX_MS,
  ROUTE_TIME_BUDGET_MS,
} from "./config";
import { analyzeTranscript } from "./winkPipeline";
import { generateSegmentCandidates } from "./candidates";
import { expandConstructions } from "./constructions";
import { validateLocalCandidates, isAzurePhraseBoundaryValid } from "./validation";
import { scoreCandidate, scoreCandidates } from "./scoring";
import { resolveOverlaps } from "./overlap";
import { selectFinalCandidates } from "./selection";
import { hashSegmentText } from "./textHash";
import { isAzureKeyPhraseConfigured, fetchKeyPhrasesForDocuments } from "./azureKeyPhrase";
import { checkAzureKeyPhraseQuota } from "@/lib/rateLimit";
import type { HighlightCandidate, PublicHighlightPhrase } from "./types";

export interface PipelineSegmentInput {
  segmentIndex: number;
  textRaw: string;
}

export interface PipelineSegmentResult {
  phrases: PublicHighlightPhrase[];
  status: "complete" | "empty";
  azureUsed: boolean;
  candidateCounts: Record<string, number>;
  transcriptTextHash: string;
}

export interface PipelineResult {
  bySegment: Map<number, PipelineSegmentResult>;
  /** Segments that could not be processed within the route's global time
   *  budget this run — never persisted, retried by a future request. */
  incompleteSegmentIndexes: number[];
}

function tallyCandidateCounts(candidates: HighlightCandidate[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const c of candidates) {
    for (const source of c.sources) {
      counts[source] = (counts[source] ?? 0) + 1;
    }
  }
  return counts;
}

function hasLocalPhraseCoverage(candidates: HighlightCandidate[]): boolean {
  return candidates.some((c) => c.kind === "phrasal_verb" || c.kind === "idiom" || c.kind === "multiword_expression");
}

interface AzureCandidateForSegment {
  segmentIndex: number;
  candidate: HighlightCandidate;
}

/** Chunks Azure-eligible segments into grouped documents (multiple
 *  consecutive segments joined by AZURE_KEY_PHRASE.SEGMENT_DELIMITER, up to
 *  MAX_CHARS_PER_DOCUMENT each), then into requests of up to
 *  MAX_DOCUMENTS_PER_REQUEST documents, honoring the quota budget and a
 *  dedicated slice of the global deadline. Every returned phrase is
 *  validated by case-insensitive substring containment against exactly one
 *  contributing segment's own text_raw — a phrase matching zero or more
 *  than one segment is rejected, which is what makes "never crosses a
 *  segment boundary" hold without needing Azure to return offsets (it
 *  doesn't). */
async function enrichWithAzure(
  eligibleSegments: PipelineSegmentInput[],
  deadline: number
): Promise<AzureCandidateForSegment[]> {
  if (!AZURE_KEY_PHRASE_ENABLED || !isAzureKeyPhraseConfigured() || eligibleSegments.length === 0) return [];

  const azurePhaseDeadline = Math.min(deadline, Date.now() + AZURE_PHASE_MAX_MS);

  // Group consecutive segments into documents up to the char limit.
  type Doc = { id: string; text: string; segments: PipelineSegmentInput[] };
  const documents: Doc[] = [];
  let current: Doc | null = null;
  for (const seg of eligibleSegments) {
    const candidateText = current ? `${current.text}${AZURE_KEY_PHRASE.SEGMENT_DELIMITER}${seg.textRaw}` : seg.textRaw;
    if (current && candidateText.length > AZURE_KEY_PHRASE.MAX_CHARS_PER_DOCUMENT) {
      documents.push(current);
      current = { id: String(documents.length), text: seg.textRaw, segments: [seg] };
    } else if (current) {
      current.text = candidateText;
      current.segments.push(seg);
    } else {
      current = { id: "0", text: seg.textRaw, segments: [seg] };
    }
  }
  if (current) documents.push(current);
  documents.forEach((d, i) => (d.id = String(i)));

  const results: AzureCandidateForSegment[] = [];

  for (let i = 0; i < documents.length; i += AZURE_KEY_PHRASE.MAX_DOCUMENTS_PER_REQUEST) {
    if (Date.now() >= azurePhaseDeadline) break;

    const batch = documents.slice(i, i + AZURE_KEY_PHRASE.MAX_DOCUMENTS_PER_REQUEST);
    const textRecordCost = batch.reduce((sum, d) => sum + Math.max(1, Math.ceil(d.text.length / 1000)), 0);

    const quota = await checkAzureKeyPhraseQuota(textRecordCost, AZURE_KEY_PHRASE_MONTHLY_RECORD_BUDGET);
    if (!quota.allowed) break;

    let keyPhrasesByDocId: Map<string, string[]>;
    try {
      keyPhrasesByDocId = await fetchKeyPhrasesForDocuments(batch.map((d) => ({ id: d.id, text: d.text })));
    } catch (err) {
      // Azure failure must never destroy already-computed local results —
      // just stop enriching for the rest of this run.
      console.error("[vocabHighlights/pipeline] Azure key phrase batch failed:", err);
      break;
    }

    for (const doc of batch) {
      const phrases = keyPhrasesByDocId.get(doc.id) ?? [];
      for (const rawPhrase of phrases) {
        const phrase = rawPhrase.trim();
        if (!phrase || phrase.split(/\s+/).length > AZURE_KEY_PHRASE.MAX_PHRASE_WORDS) continue;

        const matches = doc.segments
          .map((seg) => {
            const idx = seg.textRaw.toLowerCase().indexOf(phrase.toLowerCase());
            return idx === -1 ? null : { seg, start: idx, end: idx + phrase.length };
          })
          .filter((m): m is { seg: PipelineSegmentInput; start: number; end: number } => m !== null);

        if (matches.length !== 1) continue; // no match, or ambiguous across segments — reject
        const { seg, start, end } = matches[0];

        const surface = seg.textRaw.slice(start, end);
        results.push({
          segmentIndex: seg.segmentIndex,
          candidate: {
            segmentIndex: seg.segmentIndex,
            start,
            end,
            originalText: surface,
            kind: "topic_phrase",
            sources: ["azure_key_phrase"],
            score: 0,
            reasons: [],
          },
        });
      }
    }
  }

  return results;
}

/**
 * Runs the full deterministic pipeline for the given (already cache-miss)
 * segments: winkNLP analysis -> independent EFLLex/SUBTLEX/WordNet
 * evidence -> scoring -> optional Azure enrichment -> overlap resolution ->
 * density selection. Respects one global deadline shared by every phase —
 * see config.ts's ROUTE_TIME_BUDGET_MS.
 */
export async function runPipeline(
  segments: PipelineSegmentInput[],
  learningLevel: LearningLevel
): Promise<PipelineResult> {
  const deadline = Date.now() + ROUTE_TIME_BUDGET_MS;
  const { bySegment: analysisBySegment, corroboratedPropnLemmas } = analyzeTranscript(
    segments.map((s) => ({ segmentIndex: s.segmentIndex, text: s.textRaw }))
  );

  const scoredBySegment = new Map<number, HighlightCandidate[]>();
  const incompleteSegmentIndexes: number[] = [];

  for (const seg of segments) {
    if (Date.now() >= deadline) {
      incompleteSegmentIndexes.push(seg.segmentIndex);
      continue;
    }
    const analysis = analysisBySegment.get(seg.segmentIndex);
    if (!analysis) {
      incompleteSegmentIndexes.push(seg.segmentIndex);
      continue;
    }
    const generated = generateSegmentCandidates(analysis, corroboratedPropnLemmas);
    const expanded = [...generated, ...expandConstructions(analysis, generated)];
    const validated = validateLocalCandidates(expanded, analysis);
    scoredBySegment.set(seg.segmentIndex, scoreCandidates(validated, learningLevel));
  }

  // Azure enrichment: only for segments the local pass actually completed
  // and which still lack phrase coverage, and only if overall transcript
  // coverage is below the configured threshold.
  const completedSegments = segments.filter((s) => scoredBySegment.has(s.segmentIndex));
  const withCoverage = completedSegments.filter((s) => hasLocalPhraseCoverage(scoredBySegment.get(s.segmentIndex)!));
  const coverageRatio = completedSegments.length > 0 ? withCoverage.length / completedSegments.length : 1;

  const azureUsedSegments = new Set<number>();
  if (coverageRatio < AZURE_KEY_PHRASE.MIN_COVERAGE_THRESHOLD) {
    const eligible = completedSegments.filter((s) => {
      const scored = scoredBySegment.get(s.segmentIndex)!;
      const tokenish = s.textRaw.trim().split(/\s+/).filter(Boolean).length;
      return !hasLocalPhraseCoverage(scored) && tokenish >= AZURE_KEY_PHRASE.MIN_SEGMENT_TOKENS;
    });

    const azureCandidates = await enrichWithAzure(eligible, deadline);
    for (const { segmentIndex, candidate } of azureCandidates) {
      const segmentAnalysis = analysisBySegment.get(segmentIndex);
      // Azure has no lexicon backing at all, unlike local WordNet/EFLLex/
      // construction candidates — a phrase ending in a bare preposition/
      // particle here (e.g. "meat-eating in") is rejected outright rather
      // than trusted merely for occurring as a substring.
      if (!segmentAnalysis || !isAzurePhraseBoundaryValid(candidate, segmentAnalysis)) continue;
      const scored = scoreCandidate(candidate, learningLevel);
      scoredBySegment.get(segmentIndex)?.push(scored);
      azureUsedSegments.add(segmentIndex);
    }
  }

  const bySegment = new Map<number, PipelineSegmentResult>();
  for (const seg of completedSegments) {
    const scored = scoredBySegment.get(seg.segmentIndex)!;
    const resolved = resolveOverlaps(scored);
    const final = selectFinalCandidates(resolved, seg.textRaw);

    const phrases: PublicHighlightPhrase[] = final.map((c) => ({
      phrase: c.originalText,
      translation: null,
      start: c.start,
      end: c.end,
      ...(c.canonicalForm ? { canonicalForm: c.canonicalForm } : {}),
      ...(c.learningPattern ? { learningPattern: c.learningPattern } : {}),
    }));

    bySegment.set(seg.segmentIndex, {
      phrases,
      status: phrases.length > 0 ? "complete" : "empty",
      azureUsed: azureUsedSegments.has(seg.segmentIndex),
      candidateCounts: tallyCandidateCounts(scored),
      transcriptTextHash: hashSegmentText(seg.textRaw),
    });
  }

  return { bySegment, incompleteSegmentIndexes };
}
