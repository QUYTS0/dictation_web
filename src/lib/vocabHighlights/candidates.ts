import type { WinkSegmentAnalysis, WinkToken } from "./winkPipeline";
import { isConfidentProperNoun } from "./winkPipeline";
import { lookupEfllexWord, getEfllexMultiwordEntries } from "./efllex";
import { lookupSubtlex, subtlexUnknownBand } from "./subtlex";
import { lookupWordnetMultiword } from "./wordnet";
import { lookupSupplementaryMultiword } from "./supplementaryPhrases";
import { isPossessiveCliticText } from "./validation";
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

/** A token functioning as the second half of a tightly-hyphenated compound
 *  (e.g. "eating" in "meat-eating") is almost never a genuine finite/
 *  phrasal verb in that position, even when winkNLP's POS tagger still
 *  calls it VERB — this is what stops WordNet's real "eat in" phrasal-verb
 *  entry from misfiring on "meat-eating in most countries" (the "in"
 *  there belongs to a separate PP, not to "eating"). */
function isGluedToPrecedingHyphen(tokens: WinkToken[], index: number): boolean {
  const prev = tokens[index - 1];
  const cur = tokens[index];
  return !!prev && prev.text === "-" && prev.end === cur.start;
}

let cachedEfllexMultiwordIndex: Map<string, { pos: string }> | null = null;
function efllexMultiwordIndex(): Map<string, { pos: string }> {
  if (!cachedEfllexMultiwordIndex) {
    cachedEfllexMultiwordIndex = new Map(getEfllexMultiwordEntries().map((e) => [e.lemma, { pos: e.pos }]));
  }
  return cachedEfllexMultiwordIndex;
}

/** True when every non-punctuation token in [start,end) is a confident
 *  proper noun — used to flag a whole WordNet/EFLLex/supplementary MWE
 *  span (e.g. "United States") as a suspected pure named entity, the same
 *  way individual word candidates already are. Construction-expansion
 *  candidates (constructions.ts) are never checked here — they come from a
 *  verified pattern lexicon, not from arbitrary dataset lookups. */
function isAllProperNounSpan(
  window: WinkToken[],
  tokens: WinkToken[],
  firstNonPunctIdx: number,
  corroboratedPropnLemmas: Set<string>
): boolean {
  return window.every((t) => {
    const idx = tokens.indexOf(t);
    return isConfidentProperNoun(t, idx === firstNonPunctIdx, corroboratedPropnLemmas);
  });
}

/**
 * Greedy longest-match MWE scan (WordNet + EFLLex + a small curated
 * supplementary lexicon, independently — none of the three blocks another)
 * over the segment's non-punctuation tokens, matched by joined LEMMA (not
 * surface form), so inflected phrasal verbs like "gave up"/"giving up"
 * still match "give up". Consumes tokens greedily only for the purpose of
 * finding further MWE start positions — it does NOT prevent word.ts from
 * generating word-level EFLLex/SUBTLEX candidates for the same tokens;
 * that coexistence is resolved later by overlap.ts, not here.
 */
function generateMultiwordCandidates(analysis: WinkSegmentAnalysis, corroboratedPropnLemmas: Set<string>): HighlightCandidate[] {
  const { tokens, segmentIndex, text } = analysis;
  const candidates: HighlightCandidate[] = [];
  const efllexMwe = efllexMultiwordIndex();
  const firstNonPunctIdx = tokens.findIndex((t) => !t.isPunctuation);

  let i = 0;
  while (i < tokens.length) {
    if (tokens[i].isPunctuation || isGluedToPrecedingHyphen(tokens, i)) {
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
      const supplementaryMatch = lookupSupplementaryMultiword(lemmaPhrase);
      if (!wordnetMatch && !efllexMatch && !supplementaryMatch) continue;

      const sources: CandidateSource[] = [];
      if (wordnetMatch) sources.push("wordnet");
      if (efllexMatch) sources.push("efllex");
      if (supplementaryMatch) sources.push("supplementary");

      const start = window[0].start;
      const end = window[window.length - 1].end;
      const isNamedEntitySpan = isAllProperNounSpan(window, tokens, firstNonPunctIdx, corroboratedPropnLemmas);

      candidates.push({
        segmentIndex,
        start,
        end,
        originalText: text.slice(start, end),
        lemma: lemmaPhrase,
        kind: wordnetMatch?.kind ?? supplementaryMatch?.kind ?? "multiword_expression",
        sources,
        score: 0,
        reasons: isNamedEntitySpan ? ["named-entity-suspected"] : [],
      });

      i += len;
      matched = true;
      break;
    }

    if (!matched) i++;
  }

  return candidates;
}

/**
 * Merges a chain of tightly-hyphenated tokens (no whitespace on either
 * side of each "-") into one "word"-kind candidate spanning the whole
 * compound (e.g. "meat-eating", "24-hour", "state-of-the-art") — winkNLP
 * tokenizes each hyphen and word segment separately, so without this the
 * compound is never seen as a single unit at all. EFLLex/SUBTLEX are still
 * consulted (a common compound may well be attested), falling back to a
 * flat HYPHEN_COMPOUND_BONUS (scoring.ts) when neither has it, rather than
 * scoring an unattested-but-legitimate compound as worthless.
 */
function generateHyphenCompoundCandidates(analysis: WinkSegmentAnalysis): HighlightCandidate[] {
  const { tokens, segmentIndex, text } = analysis;
  const candidates: HighlightCandidate[] = [];

  let i = 0;
  while (i < tokens.length) {
    if (tokens[i].isPunctuation) {
      i++;
      continue;
    }
    let end = i;
    while (
      tokens[end + 1]?.text === "-" &&
      tokens[end + 1].end === tokens[end + 2]?.start &&
      tokens[end].end === tokens[end + 1].start &&
      !tokens[end + 2]?.isPunctuation
    ) {
      end += 2;
    }

    if (end > i) {
      const window = tokens.slice(i, end + 1);
      const start = window[0].start;
      const finish = window[window.length - 1].end;
      const surface = text.slice(start, finish);
      const lemma = window.map((t) => (t.text === "-" ? "-" : t.lemma.toLowerCase())).join("");
      const efllex = lookupEfllexWord(surface.toLowerCase());
      const subtlex = lookupSubtlex(surface.toLowerCase()) ?? subtlexUnknownBand();
      const sources: CandidateSource[] = [];
      if (efllex) sources.push("efllex");
      sources.push("subtlex");

      candidates.push({
        segmentIndex,
        start,
        end: finish,
        originalText: surface,
        lemma,
        kind: "word",
        sources,
        evidence: {
          ...(efllex ? { efllex: { estimatedLevel: efllex.estimatedLevel, pos: efllex.pos } } : {}),
          subtlex,
        },
        estimatedLevel: efllex?.estimatedLevel ?? undefined,
        isHyphenCompound: true,
        score: 0,
        reasons: [],
      });
      i = end + 1;
    } else {
      i++;
    }
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
    if (isPossessiveCliticText(token.text)) return;

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

/** Merged candidate list for one segment — WordNet/EFLLex/supplementary MWE
 *  candidates, hyphen-compound candidates, and EFLLex/SUBTLEX word
 *  candidates coexist unresolved; the construction-expansion stage
 *  (constructions.ts) runs next, then validation (validation.ts), then
 *  scoring scores each independently, and overlap.ts (not this module)
 *  decides which ones actually get shown. */
export function generateSegmentCandidates(
  analysis: WinkSegmentAnalysis,
  corroboratedPropnLemmas: Set<string>
): HighlightCandidate[] {
  return [
    ...generateMultiwordCandidates(analysis, corroboratedPropnLemmas),
    ...generateHyphenCompoundCandidates(analysis),
    ...generateWordCandidates(analysis, corroboratedPropnLemmas),
  ];
}
