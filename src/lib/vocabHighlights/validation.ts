// Shared boundary-validation stage, applied to every local candidate after
// construction expansion and before scoring — and, via a narrower
// Azure-specific rule, to Azure topic-phrase candidates before they're
// merged into a segment's candidate list (pipeline.ts).
import { FUNCTION_WORD_POS, TRAILING_PREPOSITION_POS } from "./config";
import type { WinkSegmentAnalysis } from "./winkPipeline";
import type { HighlightCandidate } from "./types";

const POSSESSIVE_CLITIC = /^['’]s$|^s['’]$/i;

/** Shared with candidates.ts so a bare possessive clitic token ("'s"/"s'")
 *  is skipped at generation time too, not only rejected later here. */
export function isPossessiveCliticText(text: string): boolean {
  return POSSESSIVE_CLITIC.test(text);
}
const PUNCTUATION_ONLY = /^[^\p{L}\p{N}]+$/u;
const LEADING_OR_TRAILING_PUNCTUATION = /^[\s\p{P}]|[\s\p{P}]$/u;

function isStructurallyValid(candidate: HighlightCandidate, analysis: WinkSegmentAnalysis): boolean {
  const text = candidate.originalText;
  if (!text || !text.trim()) return false;
  if (candidate.start < 0 || candidate.end > analysis.text.length || candidate.start >= candidate.end) return false;
  if (PUNCTUATION_ONLY.test(text)) return false;
  if (POSSESSIVE_CLITIC.test(text)) return false;
  if (LEADING_OR_TRAILING_PUNCTUATION.test(text)) return false;

  // Defensive net: a single-token "word" candidate whose POS is a pure
  // function word has no independent vocabulary value. Construction/
  // supplementary/WordNet multi-word candidates are unaffected (this only
  // fires for kind "word", which is otherwise already filtered by
  // winkNLP's own stopWordFlag at generation time in candidates.ts).
  if (candidate.kind === "word" && candidate.pos && FUNCTION_WORD_POS.has(candidate.pos)) return false;

  return true;
}

/** Boundary validation for local (winkNLP/EFLLex/SUBTLEX/WordNet/
 *  construction) candidates. Named-entity suspicion is tagged at
 *  generation time (candidates.ts) and penalized by scoring.ts — this
 *  stage only rejects structurally invalid spans, never re-implements
 *  named-entity policy. */
export function validateLocalCandidates(candidates: HighlightCandidate[], analysis: WinkSegmentAnalysis): HighlightCandidate[] {
  const seen = new Set<string>();
  const result: HighlightCandidate[] = [];
  for (const candidate of candidates) {
    if (!isStructurallyValid(candidate, analysis)) continue;
    const key = `${candidate.start}:${candidate.end}:${candidate.originalText}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

/**
 * Azure-specific: a topic phrase has no lexicon backing at all (unlike a
 * local WordNet phrasal-verb entry or a construction-expansion match), so
 * a phrase ending in a bare preposition/particle here is very likely an
 * arbitrarily-cut NP+PP fragment ("meat-eating in") rather than a genuine
 * complete unit — reject it outright. This rule is intentionally scoped to
 * Azure only: a local WordNet-sourced phrasal verb ending in a particle
 * (e.g. "give up") is a verified dictionary entry and must not be rejected
 * by this same logic.
 */
export function isAzurePhraseBoundaryValid(candidate: HighlightCandidate, analysis: WinkSegmentAnalysis): boolean {
  if (!isStructurallyValid(candidate, analysis)) return false;

  const lastToken = [...analysis.tokens].reverse().find((t) => !t.isPunctuation && t.start < candidate.end && t.end <= candidate.end);
  if (lastToken && TRAILING_PREPOSITION_POS.has(lastToken.pos)) return false;

  return true;
}
