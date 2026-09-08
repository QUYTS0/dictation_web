// Deterministic construction-expansion stage — runs after source candidate
// generation (candidates.ts) and before scoring. Produces additional
// candidates for reusable verb/adjective-complement patterns, idiom-plus-
// complement-marker extensions, optional-internal-modifier idioms,
// comparative frames, and quantifier constructions, none of which the raw
// WordNet/EFLLex data reliably covers as *complete* learning units.
//
// Every matcher here works purely off tokens/lemmas/POS/offsets from
// winkPipeline's analysis (or, for the idiom-marker matcher, off an
// already-generated candidate's span) — never off arbitrary adjacency of
// words. A construction is only produced when its specific, named pattern
// actually matches; this must not become a generic "attach the next
// preposition" rule.
import type { WinkSegmentAnalysis, WinkToken } from "./winkPipeline";
import type { HighlightCandidate } from "./types";

function isGluedToPrecedingHyphen(tokens: WinkToken[], index: number): boolean {
  const prev = tokens[index - 1];
  const cur = tokens[index];
  return !!prev && prev.text === "-" && prev.end === cur.start;
}

// ---- 1 & 3: verb/adjective complement constructions, with an optional
// internal modifier phrase (e.g. "thanks (in part) to") ----

interface ComplementConstruction {
  headLemma: string;
  headPos?: string[];
  /** Multi-word optional infixes, longest first, tried before the direct
   *  (no-infix) form. Space-joined, lowercase, matched against token text. */
  optionalInfixes?: string[];
  complements: string[];
  canonicalForm: string;
  learningPattern?: string;
  kind: "phrasal_verb" | "idiom";
}

// Verified, curated collocations absent from the local WordNet/EFLLex
// indexes (checked directly against the derived datasets) but common
// enough in educational transcripts to matter generally, not just for one
// sentence. Passive/inflected forms are handled automatically since
// matching is by LEMMA, not surface form (e.g. "paired"/"pairs"/"pairing"
// all lemmatize to "pair").
const COMPLEMENT_CONSTRUCTIONS: ComplementConstruction[] = [
  {
    headLemma: "pair",
    headPos: ["VERB"],
    complements: ["with"],
    canonicalForm: "pair with",
    learningPattern: "pair A with B / be paired with something",
    kind: "phrasal_verb",
  },
  { headLemma: "responsible", headPos: ["ADJ"], complements: ["for"], canonicalForm: "responsible for", kind: "phrasal_verb" },
  { headLemma: "base", headPos: ["VERB", "ADJ"], complements: ["on"], canonicalForm: "base on", kind: "phrasal_verb" },
  { headLemma: "relate", headPos: ["VERB", "ADJ"], complements: ["to"], canonicalForm: "relate to", kind: "phrasal_verb" },
  { headLemma: "consist", headPos: ["VERB"], complements: ["of"], canonicalForm: "consist of", kind: "phrasal_verb" },
  { headLemma: "contribute", headPos: ["VERB"], complements: ["to"], canonicalForm: "contribute to", kind: "phrasal_verb" },
  { headLemma: "result", headPos: ["VERB"], complements: ["in", "from"], canonicalForm: "result in", kind: "phrasal_verb" },
  { headLemma: "depend", headPos: ["VERB"], complements: ["on", "upon"], canonicalForm: "depend on", kind: "phrasal_verb" },
  { headLemma: "associate", headPos: ["VERB", "ADJ"], complements: ["with"], canonicalForm: "associate with", kind: "phrasal_verb" },
  { headLemma: "compose", headPos: ["VERB", "ADJ"], complements: ["of"], canonicalForm: "composed of", kind: "phrasal_verb" },
  { headLemma: "capable", headPos: ["ADJ"], complements: ["of"], canonicalForm: "capable of", kind: "phrasal_verb" },
  { headLemma: "aware", headPos: ["ADJ"], complements: ["of"], canonicalForm: "aware of", kind: "phrasal_verb" },
  { headLemma: "similar", headPos: ["ADJ"], complements: ["to"], canonicalForm: "similar to", kind: "phrasal_verb" },
  { headLemma: "different", headPos: ["ADJ"], complements: ["from", "to"], canonicalForm: "different from", kind: "phrasal_verb" },
  {
    headLemma: "thanks",
    headPos: ["NOUN"],
    optionalInfixes: ["in no small part", "in large part", "in part"],
    complements: ["to"],
    canonicalForm: "thanks to",
    learningPattern: "thanks to + noun",
    kind: "phrasal_verb",
  },
];

function matchesTokenText(token: WinkToken, words: string[]): boolean {
  const lower = token.text.toLowerCase();
  return words.some((w) => w === lower || w === token.lemma.toLowerCase());
}

function tryInfix(tokens: WinkToken[], headIndex: number, infixPhrase: string): number | null {
  const infixWords = infixPhrase.split(" ");
  let cursor = headIndex + 1;
  for (const word of infixWords) {
    const t = tokens[cursor];
    if (!t || t.isPunctuation || t.text.toLowerCase() !== word) return null;
    cursor++;
  }
  return cursor;
}

function generateComplementConstructions(analysis: WinkSegmentAnalysis): HighlightCandidate[] {
  const { tokens, segmentIndex, text } = analysis;
  const results: HighlightCandidate[] = [];

  tokens.forEach((head, i) => {
    if (head.isPunctuation || isGluedToPrecedingHyphen(tokens, i)) return;
    const headLemma = head.lemma.toLowerCase();

    for (const entry of COMPLEMENT_CONSTRUCTIONS) {
      if (headLemma !== entry.headLemma) continue;
      if (entry.headPos && !entry.headPos.includes(head.pos)) continue;

      let complementIndex: number | null = null;

      for (const infix of entry.optionalInfixes ?? []) {
        const afterInfix = tryInfix(tokens, i, infix);
        if (afterInfix !== null && tokens[afterInfix] && !tokens[afterInfix].isPunctuation && matchesTokenText(tokens[afterInfix], entry.complements)) {
          complementIndex = afterInfix;
          break;
        }
      }

      if (complementIndex === null) {
        const direct = tokens[i + 1];
        if (direct && !direct.isPunctuation && matchesTokenText(direct, entry.complements)) {
          complementIndex = i + 1;
        }
      }

      if (complementIndex === null) continue;

      const start = head.start;
      const end = tokens[complementIndex].end;
      results.push({
        segmentIndex,
        start,
        end,
        originalText: text.slice(start, end),
        lemma: entry.canonicalForm,
        kind: entry.kind,
        sources: ["construction"],
        canonicalForm: entry.canonicalForm,
        learningPattern: entry.learningPattern,
        score: 0,
        reasons: [],
      });
      break; // one construction match per head token is enough
    }
  });

  return results;
}

// ---- 2: idiom + complement marker (e.g. "go a long way" + "toward(s)") ----

interface IdiomMarkerConstruction {
  idiomLemmaPhrase: string;
  markers: string[];
  learningPattern?: string;
}

const IDIOM_COMPLEMENT_MARKERS: IdiomMarkerConstruction[] = [
  { idiomLemmaPhrase: "go a long way", markers: ["toward", "towards"], learningPattern: "go a long way toward(s) + noun/V-ing" },
];

function generateIdiomMarkerExpansions(analysis: WinkSegmentAnalysis, candidates: HighlightCandidate[]): HighlightCandidate[] {
  const { tokens, segmentIndex, text } = analysis;
  const results: HighlightCandidate[] = [];

  for (const candidate of candidates) {
    if (candidate.kind === "word" || !candidate.lemma) continue;
    const entry = IDIOM_COMPLEMENT_MARKERS.find((e) => e.idiomLemmaPhrase === candidate.lemma!.toLowerCase());
    if (!entry) continue;

    const lastTokenIndex = tokens.findIndex((t) => t.end === candidate.end);
    if (lastTokenIndex === -1 || !tokens[lastTokenIndex + 1]) continue;
    const markerToken = tokens[lastTokenIndex + 1];
    if (markerToken.isPunctuation || !entry.markers.includes(markerToken.text.toLowerCase())) continue;

    const start = candidate.start;
    const end = markerToken.end;
    results.push({
      segmentIndex,
      start,
      end,
      originalText: text.slice(start, end),
      lemma: candidate.lemma,
      kind: "phrasal_verb",
      sources: ["construction"],
      canonicalForm: candidate.lemma,
      learningPattern: entry.learningPattern,
      score: 0,
      reasons: [],
    });
  }

  return results;
}

// ---- 4: comparative frames ("[N times] as much/many as") ----

const NUMBER_WORDS = new Set(["dozen", "dozens", "couple", "score"]);

function isNumberLike(token: WinkToken): boolean {
  return token.pos === "NUM" || NUMBER_WORDS.has(token.lemma.toLowerCase());
}

function generateComparativeFrames(analysis: WinkSegmentAnalysis): HighlightCandidate[] {
  const { tokens, segmentIndex, text } = analysis;
  const results: HighlightCandidate[] = [];

  for (let j = 0; j < tokens.length - 2; j++) {
    const a1 = tokens[j];
    const quant = tokens[j + 1];
    const a2 = tokens[j + 2];
    if (a1.isPunctuation || quant.isPunctuation || a2.isPunctuation) continue;
    if (a1.text.toLowerCase() !== "as") continue;
    if (!["much", "many"].includes(quant.lemma.toLowerCase())) continue;
    if (a2.text.toLowerCase() !== "as") continue;

    let start = a1.start;
    // Look for an immediately preceding "<number> times" bigram — only then
    // is the "N times as much/many as" learning pattern actually instantiated
    // by this span; a bare "as much/many as" is a different (unquantified)
    // comparative and gets no pattern.
    const timesIndex = j - 1;
    const numIndex = j - 2;
    let hasQuantityPrefix = false;
    if (
      timesIndex >= 0 &&
      numIndex >= 0 &&
      !tokens[timesIndex].isPunctuation &&
      tokens[timesIndex].lemma.toLowerCase() === "time" &&
      !tokens[numIndex].isPunctuation &&
      isNumberLike(tokens[numIndex])
    ) {
      start = tokens[numIndex].start;
      hasQuantityPrefix = true;
    }

    const end = a2.end;
    const quantLemma = quant.lemma.toLowerCase();
    // "much" compares an uncountable noun, "many" a plural countable one —
    // the two frames take grammatically different complements.
    const nounType = quantLemma === "much" ? "uncountable noun" : "plural countable noun";
    results.push({
      segmentIndex,
      start,
      end,
      originalText: text.slice(start, end),
      lemma: `as ${quantLemma} as`,
      kind: "idiom",
      sources: ["construction"],
      canonicalForm: `as ${quantLemma} as`,
      learningPattern: hasQuantityPrefix ? `N times as ${quantLemma} as + ${nounType}` : undefined,
      score: 0,
      reasons: [],
    });
  }

  return results;
}

// ---- 5: quantifier constructions ("tens/hundreds of thousands/millions") ----

const QUANTIFIER_FIRST_WORDS = new Set(["tens", "hundreds", "dozens"]);
const QUANTIFIER_SECOND_LEMMAS = new Set(["thousand", "hundred", "million", "billion"]);

function generateQuantifierConstructions(analysis: WinkSegmentAnalysis): HighlightCandidate[] {
  const { tokens, segmentIndex, text } = analysis;
  const results: HighlightCandidate[] = [];

  for (let j = 0; j < tokens.length - 2; j++) {
    const first = tokens[j];
    const of = tokens[j + 1];
    const second = tokens[j + 2];
    if (first.isPunctuation || of.isPunctuation || second.isPunctuation) continue;
    if (!QUANTIFIER_FIRST_WORDS.has(first.text.toLowerCase())) continue;
    if (of.text.toLowerCase() !== "of") continue;
    if (!QUANTIFIER_SECOND_LEMMAS.has(second.lemma.toLowerCase())) continue;

    const start = first.start;
    const end = second.end;
    results.push({
      segmentIndex,
      start,
      end,
      originalText: text.slice(start, end),
      lemma: text.slice(start, end).toLowerCase(),
      kind: "idiom",
      sources: ["construction"],
      canonicalForm: `${first.text.toLowerCase()} of ${second.lemma.toLowerCase()}s`,
      score: 0,
      reasons: [],
    });
  }

  return results;
}

/**
 * Runs every construction matcher and returns only the NEW candidates they
 * produce — callers concatenate these with the source candidates already
 * generated by candidates.ts. Overlap resolution (not this stage) decides
 * whether an expanded construction wins over the shorter fragment it
 * contains; every construction-produced candidate is deliberately tier-3
 * ("phrasal_verb"/"idiom") so it dominates by kind-tier, not by score
 * tuning, over any lower-tier fragment it overlaps.
 */
export function expandConstructions(analysis: WinkSegmentAnalysis, candidates: HighlightCandidate[]): HighlightCandidate[] {
  return [
    ...generateComplementConstructions(analysis),
    ...generateIdiomMarkerExpansions(analysis, candidates),
    ...generateComparativeFrames(analysis),
    ...generateQuantifierConstructions(analysis),
  ];
}
