// Server-only: central configuration for the deterministic vocab-highlight
// pipeline. Never import this from a client component/hook — see
// publicConfig.ts for the small client-safe subset (LearningLevel/default).
import type { LearningLevel } from "./publicConfig";

export { LEARNING_LEVELS, DEFAULT_LEARNING_LEVEL, type LearningLevel } from "./publicConfig";

/**
 * Bumped whenever any contributing input changes: scoring/overlap/selection
 * logic, wink model version, or any of the EFLLex/SUBTLEX/WordNet dataset
 * artifacts. This is the *only* field that gates the highlight cache
 * (alongside transcript/segment/level identity) — dataset_versions in
 * data/manifest.json is stored for observability only and does not
 * independently invalidate anything.
 */
export const PIPELINE_VERSION = "vocab-pipeline-v3";

/** Legacy Gemini-era rows are backfilled with this value by the migration. */
export const LEGACY_GEMINI_PIPELINE_VERSION = "gemini-legacy-v1";

// ---- EFLLex difficulty formula ----

/**
 * estimatedLevel = first CEFR level whose *cumulative* (running-total, not
 * per-level) normalized frequency crosses this threshold. Cumulative rather
 * than raw per-level frequency is deliberate: EFLLex's per-level frequency
 * is not guaranteed to increase monotonically with level, and a cumulative
 * running total is monotonically non-decreasing by construction, so a
 * single noisy level no longer flips the estimate.
 *
 * This value is a starting point pending calibration against the fixture in
 * __fixtures__/calibration-sentences.json (see the plan's §8/rollout
 * Phase 3) — not asserted as final/authoritative.
 */
export const EFLLEX_LEVEL_THRESHOLD_PMW = 0.5;

/** A lemma whose cumulative frequency never crosses the threshold at any
 *  level is treated as harder than the hardest tracked level. */
export const BEYOND_C1: LearningLevel = "C1";

// ---- SUBTLEX frequency bands ----

export type SubtlexFrequencyBand = "very_common" | "common" | "uncommon" | "rare" | "unknown";

/** Ordered thresholds, frequency-per-million, descending. A word at or above
 *  a threshold falls in that band; below the lowest threshold is "rare".
 *  "unknown" is assigned separately, for lemmas absent from the dataset. */
export const SUBTLEX_FREQUENCY_BANDS: Array<{ band: SubtlexFrequencyBand; minPerMillion: number }> = [
  { band: "very_common", minPerMillion: 100 },
  { band: "common", minPerMillion: 10 },
  { band: "uncommon", minPerMillion: 1 },
  { band: "rare", minPerMillion: 0 },
];

// ---- Scoring weights (all centralized, never inline magic numbers) ----

export const SCORING = {
  /** Per CEFR-level step the candidate is estimated above the learner's
   *  own level (estimatedLevel index minus learningLevel index, clamped >=0). */
  LEVEL_GAP_WEIGHT: 15,
  /** SUBTLEX-only fallback bonus per band, when no EFLLex evidence exists. */
  SUBTLEX_BAND_SCORE: { very_common: 0, common: 5, uncommon: 20, rare: 35, unknown: 25 } as Record<SubtlexFrequencyBand, number>,
  MULTIWORD_BONUS: 20,
  PHRASAL_VERB_BONUS: 25,
  AZURE_TOPIC_PHRASE_BONUS: 10,
  NAMED_ENTITY_PENALTY: -30,
  TRANSCRIPT_ERROR_PENALTY: -50,
  /** Extra credit for a candidate the construction-expansion stage produced
   *  or extended (canonicalForm is set) — reflects that it represents a
   *  verified, complete learning unit rather than an arbitrary n-gram. */
  CONSTRUCTION_BONUS: 15,
  /** A hyphenated compound (e.g. "meat-eating") rarely has its own
   *  EFLLex/SUBTLEX entry — this keeps it from scoring as if it were
   *  worthless just because the compound-as-a-whole is unattested. */
  HYPHEN_COMPOUND_BONUS: 20,
};

// ---- Overlap resolution ----

export const KIND_TIER: Record<string, number> = {
  phrasal_verb: 3,
  idiom: 3,
  multiword_expression: 2,
  topic_phrase: 1,
  word: 0,
};

/** A lower-tier candidate only overrides a higher-tier candidate it overlaps
 *  when its score exceeds the higher-tier candidate's score by more than
 *  this margin — otherwise the higher tier (e.g. a phrasal verb) wins. */
export const DOMINANCE_OVERRIDE_MARGIN = 15;

// ---- Final selection density ----

export const SELECTION = {
  MAX_HIGHLIGHTS_PER_SENTENCE: 3,
  MAX_HIGHLIGHT_TOKEN_PERCENTAGE: 0.3,
  MIN_SCORE_THRESHOLD: 10,
  MIN_TOKEN_DISTANCE_BETWEEN_HIGHLIGHTS: 1,
};

// ---- Named-entity handling ----

/** winkNLP's wink-eng-lite-web-model NER is pattern-based (EMAIL, URL, DATE,
 *  TIME, MONEY, PERCENT, CARDINAL, ORDINAL, HASHTAG, EMOTICON, EMOJI) — it
 *  does NOT detect PERSON/ORG/GPE names. Those categories are hard-excluded
 *  outright (never educational vocabulary). Proper-noun suspicion instead
 *  comes from the POS tagger's PROPN tag, which is soft-penalized rather
 *  than hard-excluded because the tagger itself can mistag a sentence-
 *  initial common noun as PROPN (see winkPipeline.ts's corroboration check). */
export const HARD_EXCLUDED_ENTITY_TYPES = new Set([
  "EMAIL", "URL", "DATE", "TIME", "MONEY", "PERCENT", "CARDINAL", "ORDINAL", "HASHTAG", "EMOTICON", "EMOJI",
]);

/** Universal POS tags with no independent vocabulary value on their own —
 *  a defensive boundary-validation net (validation.ts) for any single-token
 *  "word" candidate that reaches that stage, on top of winkNLP's own
 *  stopWordFlag already filtering most of these at generation time. */
export const FUNCTION_WORD_POS = new Set(["DET", "ADP", "CCONJ", "SCONJ", "PRON", "AUX", "PART"]);

/** POS tags that make a candidate's trailing token "just a preposition/
 *  particle with nothing construction-verified following it" — used only
 *  for Azure-sourced topic phrases (validation.ts), which have no lexicon
 *  backing at all, unlike local WordNet/EFLLex/construction candidates. */
export const TRAILING_PREPOSITION_POS = new Set(["ADP", "PART", "SCONJ"]);

// ---- Azure Key Phrase Extraction (optional enrichment) ----

export const AZURE_KEY_PHRASE = {
  /** Verified against learn.microsoft.com/.../language-service/concepts/data-limits
   *  on 2026-09-08. Re-verify before changing. */
  MAX_CHARS_PER_DOCUMENT: 5120,
  MAX_DOCUMENTS_PER_REQUEST: 10,
  MAX_REQUEST_BYTES: 1_000_000,
  /** Pin the current stable Analyze Text API version here once confirmed
   *  directly from https://learn.microsoft.com/en-us/rest/api/language/ —
   *  not resolved during planning; do not ship the placeholder below. */
  API_VERSION: process.env.AZURE_LANGUAGE_API_VERSION ?? "UNSET_VERIFY_BEFORE_ENABLING",
  REQUEST_TIMEOUT_MS: 10_000,
  MAX_TRANSIENT_RETRIES: 1,
  RETRY_BACKOFF_MS: 400,
  MIN_SEGMENT_TOKENS: 4,
  MAX_PHRASE_WORDS: 6,
  /** Skip Azure entirely for a transcript whose local phrase coverage
   *  (fraction of segments with >=1 multiword/phrasal/idiom candidate) is
   *  already at or above this threshold. */
  MIN_COVERAGE_THRESHOLD: 0.6,
  /** Segment-join delimiter for grouped documents — not load-bearing for
   *  correctness (see azureKeyPhrase.ts's per-segment validation), only
   *  keeps segments visually separated within the combined text. */
  SEGMENT_DELIMITER: "\n\n",
};

export const AZURE_KEY_PHRASE_ENABLED = process.env.AZURE_KEY_PHRASE_ENABLED === "true";

/** Conservative internal application budget — NOT an authoritative mirror
 *  of Azure Portal's own usage metering, which remains the source of truth
 *  for actual billing. Comfortably under the shared 5,000/month F0 pool
 *  (verified: shared across sentiment analysis, key phrase extraction,
 *  language detection, NER, question answering, and CLU on one resource). */
export const AZURE_KEY_PHRASE_MONTHLY_RECORD_BUDGET = Number(
  process.env.AZURE_KEY_PHRASE_MONTHLY_RECORD_BUDGET ?? 4000
);

// ---- Global request deadline ----

/** Comfortably under Vercel Hobby's hard 60s maxDuration ceiling, leaving
 *  margin for DB reads/writes and response serialization — same rationale
 *  the legacy Gemini route already used for its own 45s timeout. */
export const ROUTE_TIME_BUDGET_MS = 45_000;

/** Azure enrichment's slice of the remaining global budget, never its own
 *  independent timeout sequence that could sum past ROUTE_TIME_BUDGET_MS. */
export const AZURE_PHASE_MAX_MS = 15_000;

// ---- Debug ----

export const VOCAB_HIGHLIGHT_DEBUG = process.env.VOCAB_HIGHLIGHT_DEBUG === "true";
