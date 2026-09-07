import type { WinkSegmentAnalysis, WinkToken } from "./winkPipeline";
import { isConfidentProperNoun } from "./winkPipeline";
import { lookupEfllexWord, getEfllexMultiwordEntries } from "./efllex";
import { lookupSubtlex, subtlexUnknownBand } from "./subtlex";
import { lookupWordnetMultiword } from "./wordnet";
import type { HighlightCandidate, CandidateSource } from "./types";

const MWE_WINDOW_LENGTHS = [4, 3, 2] as const;

function isTranscriptArtifact(text: string): boolean {
  if (text.length < 2) return true;
  if (/^\d+$/.test(text)) return true;
  if (/^(.)\1+$/.test(text)) return true;
  return false;
}

function overlapsHardExcludedSpan(token: WinkToken, analysis: WinkSegmentAnalysis): boolean {
  return analysis.hardExcludedSpans.some((s) => token.start < s.end && token.end > s.start);
}

let cachedEfllexMultiwordIndex: Map<string, { pos: string }> | null = null;
function efllexMultiwordIndex(): Map<string, { pos: string }> {
  if (!cachedEfllexMultiwordIndex) {
    cachedEfllexMultiwordIndex = new Map(getEfllexMultiwordEntries().map((e) => [e.lemma, { pos: e.pos }]));
  }
  return cachedEfllexMultiwordIndex;
}

/** Greedy longest-match MWE scan (WordNet + EFLLex multiword entries,
 *  independently — neither blocks the other) over the segment's non-
 *  punctuation tokens, matched by joined LEMMA (not surface form), so
 *  inflected phrasal verbs like "gave up"/"giving up" still match "give
 *  up". Consumes tokens greedily only for the purpose of finding further
 *  MWE start positions — it does NOT prevent word.ts from generating
 *  word-level EFLLex/SUBTLEX candidates for the same tokens; that
 *  coexistence is resolved later by overlap.ts, not here. */
function generateMultiwordCandidates(analysis: WinkSegmentAnalysis): HighlightCandidate[] {
  const { tokens, segmentIndex, text } = analysis;
  const candidates: HighlightCandidate[] = [];
  const efllexMwe = efllexMultiwordIndex();

  let i = 0;
  while (i < tokens.length) {
    if (tokens[i].isPunctuation) {
      i++;
      continue;
    }

    let matched = false;
    for (const len of MWE_WINDOW_LENGTHS) {
      if (i + len > tokens.length) continue;
      const window = tokens.slice(i, i + len);
      if (window.some((t) => t.isPunctuation)) continue;

      const lemmaPhrase = window.map((t) => t.lemma.toLowerCase()).join(" ");
      const wordnetMatch = lookupWordnetMultiword(lemmaPhrase);
      const efllexMatch = efllexMwe.get(lemmaPhrase);
      if (!wordnetMatch && !efllexMatch) continue;

      const sources: CandidateSource[] = [];
      if (wordnetMatch) sources.push("wordnet");
      if (efllexMatch) sources.push("efllex");

      const start = window[0].start;
      const end = window[window.length - 1].end;
      candidates.push({
        segmentIndex,
        start,
        end,
        originalText: text.slice(start, end),
        lemma: lemmaPhrase,
        kind: wordnetMatch?.kind ?? "multiword_expression",
        sources,
        score: 0,
        reasons: [],
      });

      i += len;
      matched = true;
      break;
    }

    if (!matched) i++;
  }

  return candidates;
}

/** Word-level candidates: every non-punctuation, non-stopword token gets
 *  EFLLex and/or SUBTLEX evidence attached to ONE candidate (not two
 *  competing candidates) — SUBTLEX contributes even when EFLLex also has
 *  data for the same word. A token with neither source's evidence still
 *  becomes a candidate (tagged with SUBTLEX's "unknown" band) so it can be
 *  rejected or accepted by validation/scoring rather than being silently
 *  dropped at generation time. */
function generateWordCandidates(
  analysis: WinkSegmentAnalysis,
  corroboratedPropnLemmas: Set<string>
): HighlightCandidate[] {
  const { tokens, segmentIndex, text } = analysis;
  const candidates: HighlightCandidate[] = [];
  const firstNonPunctIdx = tokens.findIndex((t) => !t.isPunctuation);

  tokens.forEach((token, idx) => {
    if (token.isPunctuation || token.isStopWord) return;
    if (overlapsHardExcludedSpan(token, analysis)) return;
    if (isTranscriptArtifact(token.text)) return;

    const isSentenceInitial = idx === firstNonPunctIdx;
    const isConfidentProper = isConfidentProperNoun(token, isSentenceInitial, corroboratedPropnLemmas);

    const efllex = lookupEfllexWord(token.lemma, token.pos);
    const subtlex = lookupSubtlex(token.lemma) ?? subtlexUnknownBand();

    const sources: CandidateSource[] = [];
    if (efllex) sources.push("efllex");
    sources.push("subtlex");

    candidates.push({
      segmentIndex,
      start: token.start,
      end: token.end,
      originalText: text.slice(token.start, token.end),
      lemma: token.lemma,
      pos: token.pos,
      kind: "word",
      sources,
      evidence: {
        ...(efllex ? { efllex: { estimatedLevel: efllex.estimatedLevel, pos: efllex.pos } } : {}),
        subtlex,
      },
      estimatedLevel: efllex?.estimatedLevel ?? undefined,
      score: 0,
      reasons: isConfidentProper ? ["named-entity-suspected"] : [],
    });
  });

  return candidates;
}

/** Merged candidate list for one segment — WordNet/EFLLex MWE candidates
 *  and EFLLex/SUBTLEX word candidates coexist unresolved; scoring.ts scores
 *  each independently, and overlap.ts (not this module) decides which ones
 *  actually get shown. */
export function generateSegmentCandidates(
  analysis: WinkSegmentAnalysis,
  corroboratedPropnLemmas: Set<string>
): HighlightCandidate[] {
  return [...generateMultiwordCandidates(analysis), ...generateWordCandidates(analysis, corroboratedPropnLemmas)];
}
