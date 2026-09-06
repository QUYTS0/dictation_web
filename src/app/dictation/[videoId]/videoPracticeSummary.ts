import { stripEdgePunctuation } from "./helpers";
import { type MetricKey, METRIC_ORDER, weakestSoundFor } from "./evaluationFeedback";
import type { ShadowingEvaluationMap } from "./shadowingEvaluationPersistence";
import type {
  AttemptWordScore,
  SentenceEvaluation,
  SentenceEvaluationAttempt,
  TrueEvaluationResult,
  TrueEvaluationWord,
} from "./types";

/**
 * All cross-sentence / video-level derived learning state — word and
 * phoneme aggregation across every evaluated sentence, improvement/trend
 * detection across attempt history, and the single ShadowingEvaluationSummary
 * consumed by both the compact Session panel and the full Video Summary
 * modal. Pure functions only, no React — see useShadowingEvaluations.ts,
 * which owns the actual state and just calls buildShadowingEvaluationSummary.
 *
 * Two distinct passes are used throughout, deliberately never mixed:
 *  - "current state" (retry-unbiased): reads only each sentence's LATEST
 *    completed attempt (lastSuccessfulTrueEvaluation) — one value per
 *    sentence no matter how many times it was retried. Drives every
 *    "how am I doing right now" number (session averages, Words to
 *    practice's scores, Sounds to practice, strengths).
 *  - "history" (retry-inclusive): reads every retained attempt
 *    (SentenceEvaluation.attempts) to build a chronological timeline, used
 *    ONLY for trend/improvement detection — never for current ability.
 */

const MAX_WORDS_TO_PRACTICE = 12;
const MAX_SOUNDS_TO_PRACTICE = 8;
const MAX_WEAKEST_SENTENCES = 5;
const MAX_IMPROVEMENTS = 8;
const MAX_WELL_PRONOUNCED_WORDS = 5;

/** A phoneme instance below this score counts as a meaningful problem for
 *  cross-word phoneme aggregation — reuses the same numeric boundary
 *  semanticTierFor already uses for its "weak" tier, so this doesn't
 *  introduce a new/conflicting score band. */
const PHONEME_PROBLEM_THRESHOLD = 60;
/** A word/sentence score at or above this, after genuine improvement, counts
 *  as "mastered" — reuses scoreTierFor's own "excellent" boundary. */
const MASTERED_SCORE_THRESHOLD = 85;
/** A word scoring at or above this on its current attempt is "well
 *  pronounced" — reuses scoreTierFor's "excellent" boundary. */
const WELL_PRONOUNCED_SCORE_THRESHOLD = 90;

export type ImprovementLevel = "improving" | "nice" | "great";
export type WordTrend = "improving" | "stable" | "declining" | "insufficient-data";

export interface WordTimelinePoint {
  score: number;
  evaluatedAt: string;
  segmentIndex: number;
}

export interface WordPracticeStat {
  word: string;
  segmentIndexes: number[];
  /** Distinct sentences currently containing this word (latest attempt only). */
  evaluatedOccurrences: number;
  /** Of those, how many are currently flagged with a non-"None" error type. */
  mispronunciationCount: number;
  averageLatestScore: number;
  /** Most recent attempt chronologically, across every sentence containing this word. */
  latestScore: number;
  bestScore: number;
  lowestScore: number;
  errorRate: number;
  practicePriority: number;
  focusPhoneme?: string;
  trend: WordTrend;
  timeline: WordTimelinePoint[];
}

export interface PhonemePracticeStat {
  phoneme: string;
  occurrenceCount: number;
  weakOccurrenceCount: number;
  averageScore: number;
  lowestScore: number;
  exampleWords: string[];
}

export interface ImprovementEvent {
  type: "word" | "sentence";
  label: string;
  fromScore: number;
  toScore: number;
  delta: number;
  attemptCount: number;
  level: ImprovementLevel;
  mastered: boolean;
  segmentIndex: number;
}

export interface WeakestSentence {
  segmentIndex: number;
  referenceText: string;
  /** Azure's own PronScore when available, else a fallback accuracy score —
   *  see rankingScoreFor(). This is always the number displayed/sorted by. */
  score: number;
  usedFallbackScore: boolean;
  problemWordCount: number;
}

export interface ShadowingEvaluationSummary {
  evaluatedCount: number;
  totalCount: number;
  notEvaluatedCount: number;
  isComplete: boolean;
  weightedPronunciation: number | null;
  weightedAccuracy: number | null;
  weightedFluency: number | null;
  weightedCompleteness: number | null;
  weightedProsody: number | null;
  wordsToPractice: WordPracticeStat[];
  soundsToPractice: PhonemePracticeStat[];
  weakestSentences: WeakestSentence[];
  improvements: ImprovementEvent[];
  strengths: { metric: MetricKey; value: number } | null;
  needsMostWork: { metric: MetricKey; value: number } | null;
  wellPronouncedWords: { word: string; score: number }[];
}

function weightedAverage(entries: Array<{ value: number; weight: number }>): number | null {
  const totalWeight = entries.reduce((sum, e) => sum + e.weight, 0);
  if (totalWeight <= 0) return null;
  const weightedSum = entries.reduce((sum, e) => sum + e.value * e.weight, 0);
  return weightedSum / totalWeight;
}

/** Prefers the last *successful* True Evaluation's real scores — never the
 *  in-flight/failed `trueEvaluation` attempt — falling back to Word Match's
 *  diff-derived accuracy/completeness stand-in only when no True Evaluation
 *  has ever succeeded for this sentence. Fluency/Prosody only ever come
 *  from True Evaluation — Word Match has no equivalent. */
function scoresFor(entry: SentenceEvaluation) {
  const te = entry.lastSuccessfulTrueEvaluation;
  const wm = entry.wordMatch?.status === "completed" ? entry.wordMatch : undefined;
  return {
    pronunciation: te?.pronunciationScore,
    accuracy: te?.accuracyScore ?? wm?.accuracy,
    completeness: te?.completenessScore ?? wm?.completeness,
    fluency: te?.fluencyScore,
    prosody: te?.prosodyScore,
  };
}

/** The score used to rank/display a sentence in "lowest-scoring sentences" —
 *  Azure's own PronScore when available, falling back to the accuracy
 *  sub-metric (True Eval or Word Match) when PronScore wasn't returned. */
function rankingScoreFor(entry: SentenceEvaluation): { score: number; usedFallback: boolean } | null {
  const pronScore = entry.lastSuccessfulTrueEvaluation?.pronunciationScore;
  if (pronScore !== undefined) return { score: pronScore, usedFallback: false };
  const accuracy = scoresFor(entry).accuracy;
  if (accuracy !== undefined) return { score: accuracy, usedFallback: true };
  return null;
}

/** Normalizes a raw Azure word for cross-sentence aggregation: lowercase,
 *  edge punctuation stripped, empty/punctuation-only tokens dropped. */
function normalizePracticeWord(rawWord: string): string | null {
  const stripped = stripEdgePunctuation(rawWord).toLowerCase();
  return stripped.length > 0 ? stripped : null;
}

/** Converts a full completed TrueEvaluationResult into the compact shape
 *  stored on SentenceEvaluation.attempts — also used to synthesize a
 *  single-point history for older records that predate the attempts field. */
export function toAttempt(result: TrueEvaluationResult): SentenceEvaluationAttempt {
  return {
    evaluatedAt: result.evaluatedAt ?? new Date(0).toISOString(),
    clipId: result.clipId,
    pronunciationScore: result.pronunciationScore,
    accuracyScore: result.accuracyScore,
    fluencyScore: result.fluencyScore,
    completenessScore: result.completenessScore,
    prosodyScore: result.prosodyScore,
    words: (result.words ?? []).map((w) => ({ word: w.word, accuracyScore: w.accuracyScore, errorType: w.errorType })),
  };
}

/** Every retained attempt for a sentence, oldest first — falls back to a
 *  synthesized single-point history from lastSuccessfulTrueEvaluation for
 *  older records that predate the attempts field. Never crashes/returns
 *  undefined on old data. */
function attemptsFor(entry: SentenceEvaluation): SentenceEvaluationAttempt[] {
  if (entry.attempts && entry.attempts.length > 0) return entry.attempts;
  return entry.lastSuccessfulTrueEvaluation ? [toAttempt(entry.lastSuccessfulTrueEvaluation)] : [];
}

/** Every word in one attempt with a real score, deduped by normalized word
 *  (first occurrence in the sentence wins) — mirrors the per-sentence
 *  dedupe rule used elsewhere in this file. */
function dedupedAttemptWords(words: AttemptWordScore[]): Array<{ word: string; score: number; errorType: string }> {
  const seen = new Set<string>();
  const result: Array<{ word: string; score: number; errorType: string }> = [];
  for (const w of words) {
    if (w.accuracyScore === null || w.accuracyScore === undefined) continue;
    const key = normalizePracticeWord(w.word);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push({ word: key, score: w.accuracyScore, errorType: w.errorType });
  }
  return result;
}

/** Every word in a sentence's LATEST attempt with a real score, deduped by
 *  normalized word, plus its full phoneme detail (only ever available on
 *  the latest attempt). Distinct from dedupedAttemptWords, which works over
 *  the compact historical shape and has no phoneme data. */
function currentWordOccurrences(
  entry: SentenceEvaluation
): Array<{ word: string; score: number; errorType: string; phonemes: TrueEvaluationWord["phonemes"] }> {
  const words = entry.lastSuccessfulTrueEvaluation?.words ?? [];
  const seen = new Set<string>();
  const result: Array<{ word: string; score: number; errorType: string; phonemes: TrueEvaluationWord["phonemes"] }> = [];
  for (const w of words) {
    if (w.accuracyScore === null || w.accuracyScore === undefined) continue;
    const key = normalizePracticeWord(w.word);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push({ word: key, score: w.accuracyScore, errorType: w.errorType, phonemes: w.phonemes });
  }
  return result;
}

/** severity*0.55 + errorRate(0-100)*0.30 + frequencyFactor(0-100)*0.15 — a
 *  word that's very weak in one sentence can still outrank a mildly weak
 *  word that recurs often, but recurrence still matters via both errorRate
 *  and frequencyFactor. Centralized here so it's the one place to tune. */
export function practicePriorityFor(input: {
  averageLatestScore: number;
  errorRate: number;
  evaluatedOccurrences: number;
}): number {
  const severity = 100 - input.averageLatestScore;
  const frequencyFactor = Math.min(input.evaluatedOccurrences / 3, 1);
  return severity * 0.55 + input.errorRate * 100 * 0.3 + frequencyFactor * 100 * 0.15;
}

/** delta >= 30 AND latest >= 70 -> great; delta >= 20 -> nice; delta >= 10 ->
 *  improving; otherwise no event. Deliberately does NOT gate "nice"/
 *  "improving" on the latest score — a 10 -> 35 climb is real progress
 *  worth "Nice improvement" even though the word still needs practice; only
 *  "great" additionally requires a genuinely strong current result, so a
 *  still-very-weak word is never over-celebrated. */
export function improvementLevelFor(delta: number, latestScore: number): ImprovementLevel | null {
  if (delta >= 30 && latestScore >= 70) return "great";
  if (delta >= 20) return "nice";
  if (delta >= 10) return "improving";
  return null;
}

/** Trend across a word's full score timeline — undecided ("insufficient-
 *  data") below 3 points, since a single retry isn't a trend. Compares the
 *  average of the first half vs. the second half of the sequence (the two
 *  halves overlap at the midpoint for an odd-length sequence) rather than
 *  just first-vs-last, so one noisy endpoint can't flip the verdict. */
export function trendFor(scores: number[]): WordTrend {
  if (scores.length < 3) return "insufficient-data";
  const halfLen = Math.ceil(scores.length / 2);
  const firstHalf = scores.slice(0, halfLen);
  const secondHalf = scores.slice(scores.length - halfLen);
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const delta = avg(secondHalf) - avg(firstHalf);
  if (delta >= 10) return "improving";
  if (delta <= -10) return "declining";
  return "stable";
}

const IMPROVEMENT_LEVEL_RANK: Record<ImprovementLevel, number> = { great: 3, nice: 2, improving: 1 };

export function buildShadowingEvaluationSummary(
  evaluations: ShadowingEvaluationMap,
  totalCount: number
): ShadowingEvaluationSummary {
  // A sentence counts as "evaluated" once it has a completed Word Match OR a
  // True Evaluation that has ever succeeded — a currently-failed/processing
  // attempt does not un-count a sentence that previously succeeded.
  const entries = Object.values(evaluations).filter(
    (e) => e.wordMatch?.status === "completed" || !!e.lastSuccessfulTrueEvaluation
  );
  const evaluatedCount = entries.length;

  const pronunciationEntries: Array<{ value: number; weight: number }> = [];
  const accuracyEntries: Array<{ value: number; weight: number }> = [];
  const completenessEntries: Array<{ value: number; weight: number }> = [];
  const fluencyEntries: Array<{ value: number; weight: number }> = [];
  const prosodyEntries: Array<{ value: number; weight: number }> = [];
  const weakestSentences: WeakestSentence[] = [];

  // word -> current-state occurrences (one per distinct segment, latest attempt only)
  const currentByWord = new Map<
    string,
    Array<{ segmentIndex: number; score: number; errorType: string; phonemes: TrueEvaluationWord["phonemes"] }>
  >();
  // word -> full chronological timeline across every retained attempt of every sentence
  const timelineByWord = new Map<string, WordTimelinePoint[]>();
  // phoneme -> every current-state occurrence's score + which word it came from
  const phonemeOccurrences = new Map<string, Array<{ score: number; word: string }>>();

  const improvements: ImprovementEvent[] = [];

  for (const entry of entries) {
    const scores = scoresFor(entry);
    if (scores.pronunciation !== undefined) pronunciationEntries.push({ value: scores.pronunciation, weight: entry.wordCount });
    if (scores.accuracy !== undefined) accuracyEntries.push({ value: scores.accuracy, weight: entry.wordCount });
    if (scores.completeness !== undefined) completenessEntries.push({ value: scores.completeness, weight: entry.wordCount });
    if (scores.fluency !== undefined) fluencyEntries.push({ value: scores.fluency, weight: entry.audioDuration });
    if (scores.prosody !== undefined) prosodyEntries.push({ value: scores.prosody, weight: entry.audioDuration });

    const ranking = rankingScoreFor(entry);
    const currentOccurrences = currentWordOccurrences(entry);
    if (ranking) {
      weakestSentences.push({
        segmentIndex: entry.segmentIndex,
        referenceText: entry.referenceText,
        score: ranking.score,
        usedFallbackScore: ranking.usedFallback,
        problemWordCount: currentOccurrences.filter((o) => o.errorType !== "None").length,
      });
    }

    // ---- current-state word/phoneme aggregation ----
    for (const occ of currentOccurrences) {
      const bucket = currentByWord.get(occ.word) ?? [];
      bucket.push({ segmentIndex: entry.segmentIndex, score: occ.score, errorType: occ.errorType, phonemes: occ.phonemes });
      currentByWord.set(occ.word, bucket);

      for (const p of occ.phonemes ?? []) {
        if (p.accuracyScore === null || p.accuracyScore === undefined) continue;
        const bucket2 = phonemeOccurrences.get(p.phoneme) ?? [];
        bucket2.push({ score: p.accuracyScore, word: occ.word });
        phonemeOccurrences.set(p.phoneme, bucket2);
      }
    }

    // ---- history timeline for trend/improvement (word + sentence level) ----
    const attempts = attemptsFor(entry);
    for (const attempt of attempts) {
      for (const w of dedupedAttemptWords(attempt.words)) {
        const timeline = timelineByWord.get(w.word) ?? [];
        timeline.push({ score: w.score, evaluatedAt: attempt.evaluatedAt, segmentIndex: entry.segmentIndex });
        timelineByWord.set(w.word, timeline);
      }
    }

    if (attempts.length >= 2) {
      const sentenceTimeline = attempts
        .map((a) => ({ score: a.pronunciationScore ?? a.accuracyScore, evaluatedAt: a.evaluatedAt }))
        .filter((p): p is { score: number; evaluatedAt: string } => p.score !== undefined)
        .sort((a, b) => a.evaluatedAt.localeCompare(b.evaluatedAt));
      if (sentenceTimeline.length >= 2) {
        const fromScore = sentenceTimeline[0].score;
        const toScore = sentenceTimeline[sentenceTimeline.length - 1].score;
        const delta = toScore - fromScore;
        const level = improvementLevelFor(delta, toScore);
        if (level) {
          improvements.push({
            type: "sentence",
            label: entry.referenceText,
            fromScore,
            toScore,
            delta,
            attemptCount: sentenceTimeline.length,
            level,
            mastered: toScore >= MASTERED_SCORE_THRESHOLD && sentenceTimeline.length >= 2 && fromScore < 70,
            segmentIndex: entry.segmentIndex,
          });
        }
      }
    }
  }

  // ---- finalize word stats ----
  const wordsToPractice: WordPracticeStat[] = [];
  const wellPronouncedWords: { word: string; score: number }[] = [];

  for (const [word, occurrences] of currentByWord.entries()) {
    const evaluatedOccurrences = occurrences.length;
    const mispronunciationCount = occurrences.filter((o) => o.errorType !== "None").length;
    const averageLatestScore = occurrences.reduce((sum, o) => sum + o.score, 0) / evaluatedOccurrences;

    if (averageLatestScore >= WELL_PRONOUNCED_SCORE_THRESHOLD && mispronunciationCount === 0) {
      wellPronouncedWords.push({ word, score: averageLatestScore });
    }

    // The timeline/improvement-event pass runs for EVERY word that has ever
    // been flagged at least once historically, even one no longer currently
    // flagged (e.g. 32 -> 86, now pronounced correctly) — improvement
    // recognition must not depend on the word still being a current
    // problem. Only the wordsToPractice entry itself is gated below.
    const timeline = (timelineByWord.get(word) ?? []).sort((a, b) => a.evaluatedAt.localeCompare(b.evaluatedAt));
    const timelineScores = timeline.map((t) => t.score);

    if (timeline.length >= 2) {
      const fromScore = timeline[0].score;
      const toScore = timeline[timeline.length - 1].score;
      const delta = toScore - fromScore;
      const level = improvementLevelFor(delta, toScore);
      if (level) {
        improvements.push({
          type: "word",
          label: word,
          fromScore,
          toScore,
          delta,
          attemptCount: timeline.length,
          level,
          mastered: toScore >= MASTERED_SCORE_THRESHOLD && timeline.length >= 2 && fromScore < 70,
          segmentIndex: timeline[timeline.length - 1].segmentIndex,
        });
      }
    }

    if (mispronunciationCount === 0) continue;

    const latestScore = timelineScores.length > 0 ? timelineScores[timelineScores.length - 1] : averageLatestScore;
    const bestScore = timelineScores.length > 0 ? Math.max(...timelineScores) : averageLatestScore;
    const lowestScore = timelineScores.length > 0 ? Math.min(...timelineScores) : averageLatestScore;
    const errorRate = mispronunciationCount / evaluatedOccurrences;

    let focusPhoneme: string | undefined;
    let focusPhonemeScore = Infinity;
    for (const occ of occurrences) {
      if (occ.errorType === "None") continue;
      const weakest = weakestSoundFor(occ.phonemes);
      if (weakest && weakest.score < focusPhonemeScore) {
        focusPhonemeScore = weakest.score;
        focusPhoneme = weakest.phoneme;
      }
    }

    wordsToPractice.push({
      word,
      segmentIndexes: occurrences.map((o) => o.segmentIndex).sort((a, b) => a - b),
      evaluatedOccurrences,
      mispronunciationCount,
      averageLatestScore,
      latestScore,
      bestScore,
      lowestScore,
      errorRate,
      practicePriority: practicePriorityFor({ averageLatestScore, errorRate, evaluatedOccurrences }),
      focusPhoneme,
      trend: trendFor(timelineScores),
      timeline,
    });
  }

  wordsToPractice.sort((a, b) => b.practicePriority - a.practicePriority);

  // ---- finalize phoneme stats ----
  const soundsToPractice: PhonemePracticeStat[] = [];
  for (const [phoneme, occurrences] of phonemeOccurrences.entries()) {
    const weak = occurrences.filter((o) => o.score < PHONEME_PROBLEM_THRESHOLD);
    if (weak.length === 0) continue;
    soundsToPractice.push({
      phoneme,
      occurrenceCount: occurrences.length,
      weakOccurrenceCount: weak.length,
      averageScore: weak.reduce((sum, o) => sum + o.score, 0) / weak.length,
      lowestScore: Math.min(...weak.map((o) => o.score)),
      exampleWords: Array.from(new Set(weak.map((o) => o.word))),
    });
  }
  soundsToPractice.sort((a, b) => a.averageScore - b.averageScore || b.weakOccurrenceCount - a.weakOccurrenceCount);

  // ---- finalize improvements: word events before sentence events within the same level ----
  improvements.sort((a, b) => {
    const levelDiff = IMPROVEMENT_LEVEL_RANK[b.level] - IMPROVEMENT_LEVEL_RANK[a.level];
    if (levelDiff !== 0) return levelDiff;
    if (a.type !== b.type) return a.type === "word" ? -1 : 1;
    return b.delta - a.delta;
  });

  weakestSentences.sort((a, b) => a.score - b.score || b.problemWordCount - a.problemWordCount);

  const weightedPronunciation = weightedAverage(pronunciationEntries);
  const weightedAccuracy = weightedAverage(accuracyEntries);
  const weightedFluency = weightedAverage(fluencyEntries);
  const weightedCompleteness = weightedAverage(completenessEntries);
  const weightedProsody = weightedAverage(prosodyEntries);

  const metricValues: Partial<Record<MetricKey, number>> = {
    accuracy: weightedAccuracy ?? undefined,
    fluency: weightedFluency ?? undefined,
    completeness: weightedCompleteness ?? undefined,
    prosody: weightedProsody ?? undefined,
  };
  let strengths: { metric: MetricKey; value: number } | null = null;
  let needsMostWork: { metric: MetricKey; value: number } | null = null;
  for (const key of METRIC_ORDER) {
    const value = metricValues[key];
    if (value === undefined) continue;
    if (!strengths || value > strengths.value) strengths = { metric: key, value };
    if (!needsMostWork || value < needsMostWork.value) needsMostWork = { metric: key, value };
  }

  return {
    evaluatedCount,
    totalCount,
    notEvaluatedCount: Math.max(0, totalCount - evaluatedCount),
    isComplete: totalCount > 0 && evaluatedCount >= totalCount,
    weightedPronunciation,
    weightedAccuracy,
    weightedFluency,
    weightedCompleteness,
    weightedProsody,
    wordsToPractice: wordsToPractice.slice(0, MAX_WORDS_TO_PRACTICE),
    soundsToPractice: soundsToPractice.slice(0, MAX_SOUNDS_TO_PRACTICE),
    weakestSentences: weakestSentences.slice(0, MAX_WEAKEST_SENTENCES),
    improvements: improvements.slice(0, MAX_IMPROVEMENTS),
    strengths,
    needsMostWork,
    wellPronouncedWords: wellPronouncedWords
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_WELL_PRONOUNCED_WORDS),
  };
}
