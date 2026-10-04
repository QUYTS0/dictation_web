/**
 * The Shadowing summary of ONE practice round — pure, deterministic, no
 * React, no network. Used by the practice page (live state, via its adapter)
 * and by every round report (the saved round results, via fromRoundResults)
 * so all surfaces apply the same rules to the same evidence.
 *
 * Evidence rules (application rules — configurable product thresholds, not
 * validated diagnoses):
 *  - One representative Azure result per sentence: its latest SAVED
 *    successful evaluation (by recording time, then attempt id). Supplied by
 *    the caller; never the best score.
 *  - Azure metrics: pronunciation/accuracy/completeness weighted by the
 *    sentence's word count, fluency/prosody by recording duration; a metric
 *    Azure didn't return is excluded from its own average (never 0, never a
 *    Word Match number). Word Match is a separate browser-recognition result.
 *  - Word evidence comes only from representative results, occurrence by
 *    occurrence: a word repeated in a sentence is two occurrences.
 *  - Each occurrence is classified by Azure's error type BEFORE any score
 *    threshold: Omission → "not recognized", Insertion → "extra recognized
 *    word", break/monotone types → rhythm; only Mispronunciation (with or
 *    without a score) and ordinary scored words (flagged below
 *    LOW_WORD_SCORE) are pronunciation evidence. Unknown types and missing
 *    scores stay "uncertain" — never a diagnosis, never a success.
 *  - Improvement is claimed only on comparable evidence: the same sentence,
 *    two different saved recordings, and (for words) an unambiguous
 *    reference-word correspondence. Different sentences are never compared.
 */

// ---------------------------------------------------------------- rules

export const SHADOWING_SUMMARY_RULES = {
  /** A scored word (error type "None") below this is flagged as low-scoring. */
  LOW_WORD_SCORE: 60,
  /** A phoneme observation below this is a low-scoring sound observation. */
  LOW_PHONEME_SCORE: 60,
  /** Every scored occurrence at/above this (and nothing flagged) → "well pronounced". */
  WELL_PRONOUNCED_SCORE: 90,
  /** A word/sound is "recurring" when affected in at least this many distinct sentences. */
  RECURRING_MIN_SENTENCES: 2,
  /** Practice priorities shown before "Show more". */
  INITIAL_PRIORITIES: 5,
  MAX_PRIORITIES: 12,
  MAX_SOUNDS: 8,
  MAX_EXAMPLES: 3,
  MAX_WELL_PRONOUNCED: 5,
  MAX_WEAKEST_SENTENCES: 5,
  /** The saved round results carry at most this many successful results per
   *  sentence (fn_shadowing_round_results). A history this long may be
   *  truncated, so comparisons over it are "recent", not "since the first". */
  HISTORY_LIMIT: 5,
  /** Improvement levels (score points): ≥10 improving, ≥20 nice, ≥30 and latest ≥70 great. */
  MASTERED_SCORE: 85,
} as const;

const R = SHADOWING_SUMMARY_RULES;

/** Azure word error types that describe rhythm/intonation, not a sound error. */
const RHYTHM_ERROR_TYPES = new Set(["UnexpectedBreak", "MissingBreak", "Monotone"]);

// ---------------------------------------------------------------- input

export interface SummaryWordInput {
  word: string;
  accuracyScore: number | null;
  errorType: string;
  phonemes?: Array<{ phoneme: string; accuracyScore: number | null }>;
  prosodyFeedback?: { breakErrorType?: string; intonationErrorType?: string };
}

export interface SummaryScores {
  pronunciation: number | null;
  accuracy: number | null;
  fluency: number | null;
  completeness: number | null;
  prosody: number | null;
}

export interface SummaryResultInput {
  attemptId: string | null;
  /** When the scored recording was saved (the server's created_at). Unknown for a just-finished live result. */
  recordingCreatedAt: string | null;
  evaluatedAt: string | null;
  scores: SummaryScores;
  /** Azure's ordered word list; null = no usable word detail was saved. */
  words: SummaryWordInput[] | null;
}

export interface SummaryHistoryInput {
  attemptId: string | null;
  recordingCreatedAt: string | null;
  evaluatedAt: string | null;
  pronunciationScore: number | null;
  /** Compact word list (no sub-word detail); null = not available. */
  words: Array<{ word: string; accuracyScore: number | null; errorType: string }> | null;
}

export interface SummarySentenceInput {
  segmentIndex: number;
  /** The sentence of the round's pinned revision. */
  referenceText: string;
  wordCount: number;
  audioDurationSec: number;
  /** The representative (latest saved successful) Azure result, if any. */
  representative: SummaryResultInput | null;
  /** Saved successful results of this sentence, any order (includes the representative). */
  history: SummaryHistoryInput[];
  /** The latest saved Word Match result, if any. */
  wordMatch: { accuracy: number | null; completeness: number | null } | null;
}

export interface ShadowingSummaryInput {
  /** Eligible sentences of the round's pinned revision; null = unknown (count only). */
  eligibleSentences: number | null;
  /** Eligible sentences with a practice-valid Shadowing recording (server coverage); null = unknown. */
  recordedSentences: number | null;
  sentences: SummarySentenceInput[];
}

// ---------------------------------------------------------------- output

export type MetricKey = "accuracy" | "fluency" | "completeness" | "prosody";
export const METRIC_KEYS: MetricKey[] = ["accuracy", "fluency", "completeness", "prosody"];

export interface MetricSummary {
  /** Unrounded weighted mean — format with formatAggregateScore. */
  value: number;
  /** Sentences contributing to this metric. */
  sentences: number;
}

export interface OccurrenceRef {
  segmentIndex: number;
  /** Index in the representative result's word list. */
  position: number;
  attemptId: string | null;
  word: string;
  score: number | null;
}

export interface WordPriority {
  key: string;
  label: string;
  occurrences: number;
  affectedOccurrences: number;
  sentences: number;
  affectedSentences: number;
  mispronouncedOccurrences: number;
  lowScoreOccurrences: number;
  /** Mean score over this word's scored occurrences (flagged or not); null when none had a score. */
  averageScore: number | null;
  recurring: boolean;
  focusPhoneme: string | null;
  /** Affected occurrences, in sentence/position order (≤ MAX_EXAMPLES). */
  examples: OccurrenceRef[];
  priority: number;
}

export interface SoundObservation {
  phoneme: string;
  /** Scored observations of this phoneme in the evidence. */
  observations: number;
  lowObservations: number;
  /** Mean of the LOW observations only — not an overall accuracy of the sound. */
  averageLowScore: number;
  lowestScore: number;
  affectedSentences: number;
  exampleWords: string[];
}

export interface WordObservationGroup {
  key: string;
  label: string;
  occurrences: number;
  sentences: number;
  examples: OccurrenceRef[];
}

export interface RhythmObservation {
  type: "UnexpectedBreak" | "MissingBreak" | "Monotone";
  occurrences: number;
  sentences: number;
  examples: OccurrenceRef[];
}

export type ImprovementLevel = "improving" | "nice" | "great";

interface ImprovementBase {
  segmentIndex: number;
  referenceText: string;
  fromScore: number;
  toScore: number;
  delta: number;
  level: ImprovementLevel;
  mastered: boolean;
  /** Saved results compared (the earliest and latest of them). */
  resultsCompared: number;
  /** false = the earliest available result may not be the first ever (history is capped). */
  sinceFirstResult: boolean;
}

export interface SentenceImprovement extends ImprovementBase {
  kind: "sentence";
}

export interface WordImprovement extends ImprovementBase {
  kind: "word";
  word: string;
  /** Index in the sentence's reference words (unambiguous: the word occurs once). */
  position: number;
}

export interface WeakestSentence {
  segmentIndex: number;
  referenceText: string;
  /** Azure PronScore, or its accuracy when PronScore is missing (usedFallbackScore). */
  score: number;
  usedFallbackScore: boolean;
  flaggedWords: number;
}

export type WordCategory =
  | "ok"
  | "mispronounced"
  | "low_score"
  | "not_recognized"
  | "extra"
  | "rhythm"
  | "uncertain";

export interface SentenceRow {
  segmentIndex: number;
  referenceText: string;
  pronunciationScore: number | null;
  wordMatchAccuracy: number | null;
  hasWordDetail: boolean;
  words: Array<{ word: string; score: number | null; category: WordCategory }>;
}

export type DetailAvailability = "no_scores" | "none" | "partial" | "full";

export interface ShadowingRoundSummary {
  coverage: {
    eligibleSentences: number | null;
    recordedSentences: number | null;
    scoredSentences: number;
    wordMatchSentences: number;
    /** Every eligible sentence has a practice-valid recording (says nothing about scores). */
    allRecorded: boolean;
    /** Every eligible sentence has a saved Azure score. Never true for an unknown/zero denominator. */
    allScored: boolean;
  };
  detail: {
    availability: DetailAvailability;
    scoredWithWordDetail: number;
    scoredWithoutWordDetail: number;
    /** Scored sentences whose words carry phoneme detail. */
    scoredWithPhonemeDetail: number;
    /** Occurrences with an unknown error type or no score — kept as uncertain. */
    uncertainOccurrences: number;
  };
  metrics: Record<"pronunciation" | MetricKey, MetricSummary | null>;
  wordMatchAccuracy: MetricSummary | null;
  strongestMetric: { metric: MetricKey; value: number } | null;
  weakestMetric: { metric: MetricKey; value: number } | null;
  /** Ranked, ≤ MAX_PRIORITIES; show INITIAL_PRIORITIES first. */
  priorities: WordPriority[];
  sounds: SoundObservation[];
  rhythm: RhythmObservation[];
  notRecognized: WordObservationGroup[];
  extraWords: WordObservationGroup[];
  wellPronounced: Array<{ word: string; averageScore: number; occurrences: number }>;
  sentenceImprovements: SentenceImprovement[];
  wordImprovements: WordImprovement[];
  weakestSentences: WeakestSentence[];
  sentences: SentenceRow[];
}

// ---------------------------------------------------------------- helpers

const LEADING = /^[^\p{L}\p{N}]+/u;
const TRAILING = /[^\p{L}\p{N}]+$/u;

/**
 * Word key used to group occurrences: lowercase, typographic apostrophes as
 * "'", leading/trailing punctuation removed; internal apostrophes and
 * hyphens kept ("don't", "well-known"). No stemming: "cat"/"cats" differ.
 */
export function normalizeWordKey(raw: string): string | null {
  const key = raw.normalize("NFC").replace(/[’‘]/g, "'").toLowerCase().replace(LEADING, "").replace(TRAILING, "");
  return key.length > 0 ? key : null;
}

/** Whitespace tokens — the same tokenization as fn_word_count (migration 040). */
export function countWords(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

const num = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

/** severity·0.55 + error rate·0.30 + recurrence·0.15 (all 0–100). */
export function practicePriorityFor(input: { averageScore: number; errorRate: number; affectedSentences: number }): number {
  const severity = 100 - input.averageScore;
  const recurrence = Math.min(input.affectedSentences / 3, 1);
  return severity * 0.55 + input.errorRate * 100 * 0.3 + recurrence * 100 * 0.15;
}

/** delta ≥ 30 and latest ≥ 70 → great; ≥ 20 → nice; ≥ 10 → improving; else none (incl. declines). */
export function improvementLevelFor(delta: number, latestScore: number): ImprovementLevel | null {
  if (delta >= 30 && latestScore >= 70) return "great";
  if (delta >= 20) return "nice";
  if (delta >= 10) return "improving";
  return null;
}

/** The canonical order of saved results: recording time, then attempt id (fn_shadowing_round_results). */
export function compareResultOrder(
  a: { recordingCreatedAt: string | null; evaluatedAt: string | null; attemptId: string | null },
  b: { recordingCreatedAt: string | null; evaluatedAt: string | null; attemptId: string | null }
): number {
  const ta = a.recordingCreatedAt ?? a.evaluatedAt ?? "";
  const tb = b.recordingCreatedAt ?? b.evaluatedAt ?? "";
  const byTime = Date.parse(ta) - Date.parse(tb);
  if (Number.isFinite(byTime) && byTime !== 0) return byTime;
  if (ta !== tb) return ta < tb ? -1 : 1;
  // Ordinal, like Postgres uuid ordering (`order by created_at, id`) — never a locale collation.
  const ia = a.attemptId ?? "";
  const ib = b.attemptId ?? "";
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

function classify(w: SummaryWordInput): WordCategory {
  const t = w.errorType;
  if (t === "Omission") return "not_recognized";
  if (t === "Insertion") return "extra";
  if (RHYTHM_ERROR_TYPES.has(t)) return "rhythm";
  if (t === "Mispronunciation") return "mispronounced";
  if (t === "None") {
    if (!num(w.accuracyScore)) return "uncertain";
    return w.accuracyScore < R.LOW_WORD_SCORE ? "low_score" : "ok";
  }
  return "uncertain";
}

function weightedMean(entries: Array<{ value: number | null; weight: number }>): MetricSummary | null {
  let sum = 0;
  let weight = 0;
  let sentences = 0;
  for (const e of entries) {
    if (!num(e.value) || !(e.weight > 0)) continue;
    sum += e.value * e.weight;
    weight += e.weight;
    sentences += 1;
  }
  return weight > 0 ? { value: sum / weight, sentences } : null;
}

function rhythmTypesOf(w: SummaryWordInput): RhythmObservation["type"][] {
  const out = new Set<RhythmObservation["type"]>();
  if (RHYTHM_ERROR_TYPES.has(w.errorType)) out.add(w.errorType as RhythmObservation["type"]);
  const b = w.prosodyFeedback?.breakErrorType;
  if (b === "UnexpectedBreak" || b === "MissingBreak") out.add(b);
  if (w.prosodyFeedback?.intonationErrorType === "Monotone") out.add("Monotone");
  return [...out];
}

function displayWord(raw: string): string {
  return raw.replace(LEADING, "").replace(TRAILING, "") || raw;
}

interface Occ extends OccurrenceRef {
  key: string;
  category: WordCategory;
  phonemes: SummaryWordInput["phonemes"];
}

// ---------------------------------------------------------------- builder

export function buildShadowingRoundSummary(input: ShadowingSummaryInput): ShadowingRoundSummary {
  const eligible = input.eligibleSentences;
  const sentences = [...input.sentences].sort((a, b) => a.segmentIndex - b.segmentIndex);
  const scored = sentences.filter((s) => s.representative !== null);

  // ---- coverage ----
  const wordMatchSentences = sentences.filter((s) => s.wordMatch && num(s.wordMatch.accuracy)).length;
  const coverage = {
    eligibleSentences: eligible,
    recordedSentences: input.recordedSentences,
    scoredSentences: scored.length,
    wordMatchSentences,
    allRecorded: eligible !== null && eligible > 0 && input.recordedSentences !== null && input.recordedSentences >= eligible,
    allScored: eligible !== null && eligible > 0 && scored.length >= eligible,
  };

  // ---- metrics ----
  const metric = (pick: (s: SummaryScores) => number | null, byDuration: boolean) =>
    weightedMean(scored.map((s) => ({ value: pick(s.representative!.scores), weight: byDuration ? s.audioDurationSec : s.wordCount })));
  const metrics = {
    pronunciation: metric((s) => s.pronunciation, false),
    accuracy: metric((s) => s.accuracy, false),
    completeness: metric((s) => s.completeness, false),
    fluency: metric((s) => s.fluency, true),
    prosody: metric((s) => s.prosody, true),
  };
  const wordMatchAccuracy = weightedMean(sentences.map((s) => ({ value: s.wordMatch?.accuracy ?? null, weight: s.wordCount })));
  let strongestMetric: ShadowingRoundSummary["strongestMetric"] = null;
  let weakestMetric: ShadowingRoundSummary["weakestMetric"] = null;
  for (const key of METRIC_KEYS) {
    const m = metrics[key];
    if (!m) continue;
    if (!strongestMetric || m.value > strongestMetric.value) strongestMetric = { metric: key, value: m.value };
    if (!weakestMetric || m.value < weakestMetric.value) weakestMetric = { metric: key, value: m.value };
  }

  // ---- occurrences ----
  const occs: Occ[] = [];
  let withDetail = 0;
  let withPhonemes = 0;
  const rows: SentenceRow[] = [];
  const weakestSentences: WeakestSentence[] = [];
  for (const s of sentences) {
    const rep = s.representative;
    const words = rep?.words ?? null;
    const rowWords: SentenceRow["words"] = [];
    if (rep && words) {
      withDetail += 1;
      if (words.some((w) => (w.phonemes?.length ?? 0) > 0)) withPhonemes += 1;
      words.forEach((w, position) => {
        const category = classify(w);
        rowWords.push({ word: w.word, score: num(w.accuracyScore) ? w.accuracyScore : null, category });
        const key = normalizeWordKey(w.word);
        if (!key) return;
        occs.push({
          key,
          category,
          phonemes: w.phonemes,
          segmentIndex: s.segmentIndex,
          position,
          attemptId: rep.attemptId,
          word: displayWord(w.word),
          score: num(w.accuracyScore) ? w.accuracyScore : null,
        });
      });
    }
    if (rep || s.wordMatch) {
      rows.push({
        segmentIndex: s.segmentIndex,
        referenceText: s.referenceText,
        pronunciationScore: rep?.scores.pronunciation ?? null,
        wordMatchAccuracy: s.wordMatch?.accuracy ?? null,
        hasWordDetail: !!words,
        words: rowWords,
      });
    }
    if (rep) {
      const pron = rep.scores.pronunciation;
      const acc = rep.scores.accuracy;
      const score = num(pron) ? pron : num(acc) ? acc : null;
      if (score !== null) {
        weakestSentences.push({
          segmentIndex: s.segmentIndex,
          referenceText: s.referenceText,
          score,
          usedFallbackScore: !num(pron),
          flaggedWords: rowWords.filter((w) => w.category === "mispronounced" || w.category === "low_score").length,
        });
      }
    }
  }
  // Sound/rhythm lines also attach to rhythm-flagged words of other categories.
  const rhythmOccs: Array<{ type: RhythmObservation["type"]; occ: Occ }> = [];
  for (const s of sentences) {
    const words = s.representative?.words;
    if (!words) continue;
    words.forEach((w, position) => {
      const cat = classify(w);
      if (cat === "not_recognized" || cat === "extra") return;
      for (const type of rhythmTypesOf(w)) {
        const o = occs.find((x) => x.segmentIndex === s.segmentIndex && x.position === position);
        if (o) rhythmOccs.push({ type, occ: o });
      }
    });
  }

  // Any flag — including rhythm on an otherwise fine word — rules out "well pronounced".
  const flaggedKeys = new Set([...occs.filter((o) => o.category !== "ok").map((o) => o.key), ...rhythmOccs.map((r) => r.occ.key)]);
  const uncertainOccurrences = occs.filter((o) => o.category === "uncertain").length;

  // ---- word priorities (pronunciation evidence only) ----
  const byKey = new Map<string, Occ[]>();
  for (const o of occs) {
    if (o.category !== "ok" && o.category !== "mispronounced" && o.category !== "low_score") continue;
    const list = byKey.get(o.key) ?? [];
    list.push(o);
    byKey.set(o.key, list);
  }
  const priorities: WordPriority[] = [];
  const wellPronounced: ShadowingRoundSummary["wellPronounced"] = [];
  for (const [key, list] of byKey) {
    const affected = list.filter((o) => o.category !== "ok");
    const scoredOcc = list.filter((o) => num(o.score));
    const averageScore = scoredOcc.length ? scoredOcc.reduce((a, o) => a + (o.score as number), 0) / scoredOcc.length : null;
    const sentencesOf = (xs: Occ[]) => new Set(xs.map((o) => o.segmentIndex)).size;
    if (affected.length === 0) {
      if (!flaggedKeys.has(key) && averageScore !== null && scoredOcc.length === list.length && averageScore >= R.WELL_PRONOUNCED_SCORE) {
        wellPronounced.push({ word: labelOf(list), averageScore, occurrences: list.length });
      }
      continue;
    }
    let focusPhoneme: string | null = null;
    let focusScore = Infinity;
    for (const o of affected) {
      for (const p of o.phonemes ?? []) {
        if (num(p.accuracyScore) && p.accuracyScore < focusScore) {
          focusScore = p.accuracyScore;
          focusPhoneme = p.phoneme;
        }
      }
    }
    const affectedSentences = sentencesOf(affected);
    priorities.push({
      key,
      label: labelOf(list),
      occurrences: list.length,
      affectedOccurrences: affected.length,
      sentences: sentencesOf(list),
      affectedSentences,
      mispronouncedOccurrences: affected.filter((o) => o.category === "mispronounced").length,
      lowScoreOccurrences: affected.filter((o) => o.category === "low_score").length,
      averageScore,
      recurring: affectedSentences >= R.RECURRING_MIN_SENTENCES,
      focusPhoneme,
      examples: affected.slice(0, R.MAX_EXAMPLES).map(toRef),
      // An unscored mispronunciation is ranked as if it sat at the low-score threshold.
      priority: practicePriorityFor({
        averageScore: averageScore ?? R.LOW_WORD_SCORE,
        errorRate: affected.length / list.length,
        affectedSentences,
      }),
    });
  }
  priorities.sort(
    (a, b) =>
      Number(b.recurring) - Number(a.recurring) ||
      b.priority - a.priority ||
      b.affectedOccurrences - a.affectedOccurrences ||
      a.key.localeCompare(b.key)
  );
  wellPronounced.sort((a, b) => b.averageScore - a.averageScore || a.word.localeCompare(b.word));

  // ---- sounds (phonemes of pronunciation-evidence words) ----
  const phon = new Map<string, Array<{ score: number; key: string; segmentIndex: number }>>();
  for (const o of occs) {
    if (o.category !== "ok" && o.category !== "mispronounced" && o.category !== "low_score") continue;
    for (const p of o.phonemes ?? []) {
      if (!num(p.accuracyScore)) continue;
      const list = phon.get(p.phoneme) ?? [];
      list.push({ score: p.accuracyScore, key: o.word, segmentIndex: o.segmentIndex });
      phon.set(p.phoneme, list);
    }
  }
  const sounds: SoundObservation[] = [];
  for (const [phoneme, list] of phon) {
    const low = list.filter((x) => x.score < R.LOW_PHONEME_SCORE);
    if (low.length === 0) continue;
    sounds.push({
      phoneme,
      observations: list.length,
      lowObservations: low.length,
      averageLowScore: low.reduce((a, x) => a + x.score, 0) / low.length,
      lowestScore: Math.min(...low.map((x) => x.score)),
      affectedSentences: new Set(low.map((x) => x.segmentIndex)).size,
      exampleWords: [...new Set(low.map((x) => x.key))].slice(0, R.MAX_EXAMPLES),
    });
  }
  sounds.sort(
    (a, b) =>
      Number(b.affectedSentences >= R.RECURRING_MIN_SENTENCES) - Number(a.affectedSentences >= R.RECURRING_MIN_SENTENCES) ||
      a.averageLowScore - b.averageLowScore ||
      b.lowObservations - a.lowObservations ||
      a.phoneme.localeCompare(b.phoneme)
  );

  // ---- rhythm / not recognized / extra ----
  const rhythmMap = new Map<RhythmObservation["type"], Occ[]>();
  for (const { type, occ } of rhythmOccs) rhythmMap.set(type, [...(rhythmMap.get(type) ?? []), occ]);
  const rhythm: RhythmObservation[] = [...rhythmMap].map(([type, list]) => ({
    type,
    occurrences: list.length,
    sentences: new Set(list.map((o) => o.segmentIndex)).size,
    examples: list.slice(0, R.MAX_EXAMPLES).map(toRef),
  }));
  rhythm.sort((a, b) => b.occurrences - a.occurrences || a.type.localeCompare(b.type));
  const groupOf = (category: WordCategory): WordObservationGroup[] => {
    const m = new Map<string, Occ[]>();
    for (const o of occs) if (o.category === category) m.set(o.key, [...(m.get(o.key) ?? []), o]);
    return [...m]
      .map(([key, list]) => ({
        key,
        label: labelOf(list),
        occurrences: list.length,
        sentences: new Set(list.map((o) => o.segmentIndex)).size,
        examples: list.slice(0, R.MAX_EXAMPLES).map(toRef),
      }))
      .sort((a, b) => b.sentences - a.sentences || b.occurrences - a.occurrences || a.key.localeCompare(b.key));
  };

  // ---- comparable improvement ----
  const sentenceImprovements: SentenceImprovement[] = [];
  const wordImprovements: WordImprovement[] = [];
  for (const s of sentences) {
    const history = dedupeHistory(s.history).sort(compareResultOrder);
    if (history.length < 2) continue;
    const first = history[0];
    const last = history[history.length - 1];
    const sinceFirstResult = history.length < R.HISTORY_LIMIT;
    if (num(first.pronunciationScore) && num(last.pronunciationScore)) {
      const delta = last.pronunciationScore - first.pronunciationScore;
      const level = improvementLevelFor(delta, last.pronunciationScore);
      if (level) {
        sentenceImprovements.push({
          kind: "sentence",
          segmentIndex: s.segmentIndex,
          referenceText: s.referenceText,
          fromScore: first.pronunciationScore,
          toScore: last.pronunciationScore,
          delta,
          level,
          mastered: last.pronunciationScore >= R.MASTERED_SCORE && first.pronunciationScore < 70,
          resultsCompared: history.length,
          sinceFirstResult,
        });
      }
    }
    // Word level: only when both results align one-to-one with the reference
    // sentence (no omissions/insertions/unknown types, identical word keys in
    // order) and the word occurs once in the sentence — otherwise the
    // correspondence is ambiguous and no word-level claim is made.
    const refKeys = s.referenceText.split(/\s+/).map(normalizeWordKey).filter((k): k is string => !!k);
    const aligned = (h: SummaryHistoryInput) =>
      !!h.words &&
      h.words.length === refKeys.length &&
      h.words.every((w, i) => normalizeWordKey(w.word) === refKeys[i] && (w.errorType === "None" || w.errorType === "Mispronunciation"));
    if (!aligned(first) || !aligned(last)) continue;
    refKeys.forEach((key, position) => {
      if (refKeys.indexOf(key) !== refKeys.lastIndexOf(key)) return; // repeated word → ambiguous
      const from = first.words![position].accuracyScore;
      const to = last.words![position].accuracyScore;
      if (!num(from) || !num(to)) return;
      const level = improvementLevelFor(to - from, to);
      if (!level) return;
      wordImprovements.push({
        kind: "word",
        segmentIndex: s.segmentIndex,
        referenceText: s.referenceText,
        word: displayWord(first.words![position].word),
        position,
        fromScore: from,
        toScore: to,
        delta: to - from,
        level,
        mastered: to >= R.MASTERED_SCORE && from < 70,
        resultsCompared: history.length,
        sinceFirstResult,
      });
    });
  }
  const levelRank = { great: 3, nice: 2, improving: 1 } as const;
  const byImprovement = (a: ImprovementBase, b: ImprovementBase) =>
    levelRank[b.level] - levelRank[a.level] || b.delta - a.delta || a.segmentIndex - b.segmentIndex;
  sentenceImprovements.sort(byImprovement);
  wordImprovements.sort((a, b) => byImprovement(a, b) || a.position - b.position);

  weakestSentences.sort((a, b) => a.score - b.score || b.flaggedWords - a.flaggedWords || a.segmentIndex - b.segmentIndex);

  const availability: DetailAvailability =
    scored.length === 0 ? "no_scores" : withDetail === 0 ? "none" : withDetail < scored.length ? "partial" : "full";

  return {
    coverage,
    detail: {
      availability,
      scoredWithWordDetail: withDetail,
      scoredWithoutWordDetail: scored.length - withDetail,
      scoredWithPhonemeDetail: withPhonemes,
      uncertainOccurrences,
    },
    metrics,
    wordMatchAccuracy,
    strongestMetric,
    weakestMetric,
    priorities: priorities.slice(0, R.MAX_PRIORITIES),
    sounds: sounds.slice(0, R.MAX_SOUNDS),
    rhythm,
    notRecognized: groupOf("not_recognized"),
    extraWords: groupOf("extra"),
    wellPronounced: wellPronounced.slice(0, R.MAX_WELL_PRONOUNCED),
    sentenceImprovements,
    wordImprovements,
    weakestSentences: weakestSentences.slice(0, R.MAX_WEAKEST_SENTENCES),
    sentences: rows,
  };
}

/** The occurrences' shared spelling ("London"), or the lowercase key when they differ ("The"/"the" → "the"). */
function labelOf(list: Occ[]): string {
  return list.every((o) => o.word === list[0].word) ? list[0].word : list[0].key;
}

function toRef(o: Occ): OccurrenceRef {
  return { segmentIndex: o.segmentIndex, position: o.position, attemptId: o.attemptId, word: o.word, score: o.score };
}

/** One history point per saved recording (the live map can carry a result twice). */
function dedupeHistory(history: SummaryHistoryInput[]): SummaryHistoryInput[] {
  const seen = new Set<string>();
  const out: SummaryHistoryInput[] = [];
  for (const h of history) {
    const id = h.attemptId ?? `${h.evaluatedAt}|${h.pronunciationScore}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(h);
  }
  return out;
}
