import winkNLP from "wink-nlp";
import type { ItemEntity } from "wink-nlp";
import model from "wink-eng-lite-web-model";
import { HARD_EXCLUDED_ENTITY_TYPES } from "./config";

// Lazily instantiated once per warm server process — created on first use
// within a warm serverless container (persists across invocations of that
// same warm container; recreated on cold start), not at module-import time,
// so routes that don't touch vocab highlighting pay zero cost.
let instance: ReturnType<typeof winkNLP> | null = null;
function getWink() {
  instance ??= winkNLP(model);
  return instance;
}

export interface WinkToken {
  /** Exact original surface form — always text.slice(start, end). */
  text: string;
  start: number;
  end: number;
  lemma: string;
  pos: string;
  isStopWord: boolean;
  isPunctuation: boolean;
  /** true only for a token winkNLP's POS tagger tagged PROPN. This is a
   *  suspicion signal, not proof — see WinkSegmentAnalysis.properNounFlags
   *  for the corroboration-adjusted version actually used for scoring. */
  isTaggedPropn: boolean;
}

export interface WinkHardExcludedSpan {
  start: number;
  end: number;
  type: string;
}

export interface WinkSegmentAnalysis {
  segmentIndex: number;
  text: string;
  tokens: WinkToken[];
  /** wink-eng-lite-web-model's entity recognition is pattern-based only
   *  (EMAIL, URL, DATE, TIME, MONEY, PERCENT, CARDINAL, ORDINAL, HASHTAG,
   *  EMOTICON, EMOJI) — it does NOT detect PERSON/ORG/GPE names. These are
   *  the spans to hard-exclude from candidate generation outright. */
  hardExcludedSpans: WinkHardExcludedSpan[];
}

/**
 * Reconstructs exact UTF-16 offsets for every token by walking
 * precedingSpaces + token length — verified to exactly reproduce contractions,
 * possessives, hyphenated terms, curly quotes, em dashes, and accented
 * characters against the original text_raw.
 */
// wink-eng-lite-web-model's lemma dictionary conflates a small number of
// closed-class words with an informal spelling variant that shares the same
// lemma entry — verified directly against the installed model (1.8.1):
// tokenOut(its.lemma) for the surface "through" returns "thru", while every
// other common particle/preposition tested (up, down, off, along, onto,
// across, over, into, about, around, forward) round-trips to itself. Left
// uncorrected, this silently breaks lemma-based MWE matching for any
// lexicon entry ending in "through" (e.g. WordNet's "go through" would never
// match the surface "went through"/"goes through"). This is a token-level
// lemma correction — applies to every occurrence of the word, not a
// phrase-specific exception — analogous to efllex.ts's existing
// NLP4J_TO_UNIVERSAL correction table.
const WINK_LEMMA_CORRECTIONS: Record<string, string> = {
  thru: "through",
};

function correctWinkLemma(lemma: string): string {
  return WINK_LEMMA_CORRECTIONS[lemma] ?? lemma;
}

function tokenizeWithOffsets(text: string): WinkToken[] {
  const nlp = getWink();
  const its = nlp.its;
  const doc = nlp.readDoc(text);
  const tokens = doc.tokens();
  const result: WinkToken[] = [];

  let offset = 0;
  for (let i = 0; i < tokens.length(); i++) {
    const t = tokens.itemAt(i);
    // wink-nlp's own shipped .d.ts has an internal inconsistency between the
    // `its.*` helper signatures and the `out()` overload it's passed to
    // (a 3-arg vs. 4-arg ItsFunction mismatch) that TypeScript rejects even
    // though the library works correctly at runtime — tokenOut sidesteps
    // that by calling through a loosely-typed signature once, here.
    const tokenOut = t.out as unknown as (itsf?: unknown) => string;
    const precedingSpaces = tokenOut(its.precedingSpaces);
    const surface = tokenOut();
    offset += precedingSpaces.length;
    const start = offset;
    const end = start + surface.length;
    offset = end;

    result.push({
      text: surface,
      start,
      end,
      lemma: correctWinkLemma(tokenOut(its.lemma) || surface),
      pos: tokenOut(its.pos) || "X",
      isStopWord: Boolean(tokenOut(its.stopWordFlag)),
      isPunctuation: tokenOut(its.type) === "punctuation",
      isTaggedPropn: tokenOut(its.pos) === "PROPN",
    });
  }
  return result;
}

function findHardExcludedSpans(text: string): WinkHardExcludedSpan[] {
  const nlp = getWink();
  const its = nlp.its;
  const doc = nlp.readDoc(text);
  const spans: WinkHardExcludedSpan[] = [];
  let searchFrom = 0;

  doc.entities().each((e: ItemEntity) => {
    const entityOut = e.out as unknown as (itsf?: unknown) => { value: string; type: string };
    const detail = entityOut(its.detail);
    if (!HARD_EXCLUDED_ENTITY_TYPES.has(detail.type)) return;
    const idx = text.indexOf(detail.value, searchFrom);
    if (idx === -1) return;
    spans.push({ start: idx, end: idx + detail.value.length, type: detail.type });
    searchFrom = idx + detail.value.length;
  });

  return spans;
}

/**
 * Analyzes every segment of a transcript and applies the proper-noun
 * corroboration check: a PROPN-tagged token that is the first non-
 * punctuation token of its segment (segments in this app are already one
 * sentence each — see src/lib/utils/segment.ts's mergeIntoSentences) is
 * suspected of being sentence-initial-capitalization confusion rather than
 * a genuine proper noun, UNLESS the same lemma is also tagged PROPN
 * elsewhere in the transcript at a non-initial position. Returns a Map
 * keyed by segmentIndex; each token gains no extra field here — callers
 * combine WinkSegmentAnalysis.tokens[i].isTaggedPropn with the returned
 * corroboratedLemmas set themselves (see candidates.ts).
 */
export function analyzeTranscript(
  segments: Array<{ segmentIndex: number; text: string }>
): { bySegment: Map<number, WinkSegmentAnalysis>; corroboratedPropnLemmas: Set<string> } {
  const bySegment = new Map<number, WinkSegmentAnalysis>();
  const propnLemmasAtNonInitialPosition = new Set<string>();

  for (const seg of segments) {
    const tokens = tokenizeWithOffsets(seg.text);
    const hardExcludedSpans = findHardExcludedSpans(seg.text);
    bySegment.set(seg.segmentIndex, { segmentIndex: seg.segmentIndex, text: seg.text, tokens, hardExcludedSpans });

    const firstNonPunctIdx = tokens.findIndex((t) => !t.isPunctuation);
    tokens.forEach((t, idx) => {
      if (t.isTaggedPropn && idx !== firstNonPunctIdx) {
        propnLemmasAtNonInitialPosition.add(t.lemma.toLowerCase());
      }
    });
  }

  return { bySegment, corroboratedPropnLemmas: propnLemmasAtNonInitialPosition };
}

/** True when a token should be treated as a confident proper noun for the
 *  named-entity soft-penalty (see config.ts's NAMED_ENTITY_PENALTY):
 *  tagged PROPN and either not sentence-initial, or corroborated elsewhere
 *  in the transcript. A sentence-initial PROPN with no corroboration is
 *  treated as ordinary vocabulary — this is the mitigation for the POS
 *  tagger's documented sentence-initial-capitalization confusion (observed
 *  directly: "Farm animals destined for food..." tags "Farm" as PROPN). */
export function isConfidentProperNoun(
  token: WinkToken,
  isSentenceInitial: boolean,
  corroboratedPropnLemmas: Set<string>
): boolean {
  if (!token.isTaggedPropn) return false;
  if (!isSentenceInitial) return true;
  return corroboratedPropnLemmas.has(token.lemma.toLowerCase());
}

/** Test-only escape hatch to reset the module-level singleton between
 *  jest test files if a test needs a fresh instance; production code never
 *  calls this. */
export function __resetWinkInstanceForTests() {
  instance = null;
}
