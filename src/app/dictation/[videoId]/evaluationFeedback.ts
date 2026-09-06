import { stripEdgePunctuation } from "./helpers";
import type { TrueEvaluationResult, TrueEvaluationWord } from "./types";

/**
 * Deterministic, template-based scoring/feedback rules for the Pronunciation
 * Assessment card — no network calls, no LLM, nothing that varies run to
 * run. Every threshold used across the Evaluation tab (headline tier,
 * semantic bar color, "low" metric detection, word-level threshold) lives
 * here as the single source of truth so the same number always means the
 * same thing everywhere it's shown. See "Shadowing Evaluation Improvement
 * Plan" §7/§8.
 */

export type ScoreTier = "excellent" | "great" | "good" | "keep-practicing";

/** Headline tier boundaries — drives the "Excellent"/"Great"/"Good"/"Keep
 *  practicing" word shown next to the main /100 score. */
export function scoreTierFor(pronScore: number): ScoreTier {
  if (pronScore >= 90) return "excellent";
  if (pronScore >= 75) return "great";
  if (pronScore >= 60) return "good";
  return "keep-practicing";
}

const TIER_LABELS: Record<ScoreTier, string> = {
  excellent: "Excellent",
  great: "Great",
  good: "Good",
  "keep-practicing": "Keep practicing",
};

export function tierLabel(tier: ScoreTier): string {
  return TIER_LABELS[tier];
}

export type SemanticTier = "strong" | "moderate" | "weak";

/** Shared strong/moderate/weak coloring scale — used for metric bars, the
 *  headline score, problem words, and session-summary bars alike, so one
 *  number always maps to one color everywhere in the tab. Distinct from
 *  (slightly stricter than) the "low metric" feedback threshold below,
 *  which is intentionally a bit more lenient before it starts telling the
 *  user to fix something. */
export function semanticTierFor(value: number): SemanticTier {
  if (value >= 80) return "strong";
  if (value >= 60) return "moderate";
  return "weak";
}

/** A metric counts as "low" for feedback purposes below this — distinct
 *  from the (stricter) coloring threshold above, so a "moderate" 65-79
 *  score doesn't also trigger a nagging feedback line. */
const LOW_METRIC_THRESHOLD = 70;
/** Current-sentence "words to improve" threshold — a word's Azure
 *  accuracyScore below this is shown; 0 is a valid, included score, only
 *  null/undefined (no score at all) is excluded. */
export const PROBLEM_WORD_THRESHOLD = 70;
/** "Needs practice" sentence-grouping threshold — same number family as the
 *  metric/word thresholds, one number to remember across the feature. */
export const NEEDS_PRACTICE_THRESHOLD = 70;

export type MetricKey = "accuracy" | "fluency" | "completeness" | "prosody";

/** Fixed display order used everywhere in the Evaluation tab — current
 *  sentence, session summary, and any future surface. */
export const METRIC_ORDER: MetricKey[] = ["accuracy", "fluency", "completeness", "prosody"];

export interface MetricScores {
  accuracy?: number | null;
  fluency?: number | null;
  completeness?: number | null;
  prosody?: number | null;
}

export interface WeakestMetric {
  key: MetricKey;
  value: number;
}

/** Picks the lowest of the available (non-null/undefined) metrics. Ties
 *  resolve to the fixed METRIC_ORDER so the choice is deterministic. A
 *  metric with no value is excluded entirely — never treated as 0. Returns
 *  null when no metric has a value at all. */
export function weakestMetric(scores: MetricScores): WeakestMetric | null {
  let weakest: WeakestMetric | null = null;
  for (const key of METRIC_ORDER) {
    const value = scores[key];
    if (value === null || value === undefined) continue;
    if (weakest === null || value < weakest.value) {
      weakest = { key, value };
    }
  }
  return weakest;
}

export interface FeedbackMessage {
  title: string;
  body: string;
}

const METRIC_LABELS: Record<MetricKey, string> = {
  accuracy: "accuracy",
  fluency: "fluency",
  completeness: "completeness",
  prosody: "prosody",
};

const LOW_METRIC_FEEDBACK: Record<MetricKey, FeedbackMessage> = {
  accuracy: {
    title: "Focus on accuracy",
    body: "Several sounds didn't quite match the target. Try slowing down and repeating just the words flagged below.",
  },
  fluency: {
    title: "Focus on fluency",
    body: "Your pronunciation was on target, but the pacing had noticeable pauses or hesitation. Try reading the sentence a few times before recording.",
  },
  completeness: {
    title: "Focus on completeness",
    body: "Part of the sentence wasn't picked up. Make sure you say every word out loud, including short ones at the start or end.",
  },
  prosody: {
    title: "Focus on prosody",
    body: "Your pronunciation was clear, but try matching the speaker's rhythm and sentence stress more closely.",
  },
};

/**
 * Deterministic feedback templates selected by a plain lookup on the
 * weakest metric (or "multiple weak" / "strong"). Never composed from
 * arbitrary text and never phrased as an assistant's opinion ("I think...",
 * "AI noticed...") — copy stays factual ("Your X score was the lowest of
 * the four...") so it reads as a rule-based hint, not generated advice.
 */
export function feedbackFor(scores: MetricScores, weakest: WeakestMetric | null): FeedbackMessage | null {
  if (!weakest) return null;

  const lowMetrics = METRIC_ORDER.filter((key) => {
    const value = scores[key];
    return value !== null && value !== undefined && value < LOW_METRIC_THRESHOLD;
  });

  if (lowMetrics.length >= 2) {
    const names = lowMetrics.map((key) => METRIC_LABELS[key]).join(", ");
    return {
      title: "A few areas to work on",
      body: `Your ${names} scores were all below ${LOW_METRIC_THRESHOLD}. Try recording a slower, more deliberate take of this sentence.`,
    };
  }

  if (lowMetrics.length === 1) {
    return LOW_METRIC_FEEDBACK[lowMetrics[0]];
  }

  return {
    title: "Strong result",
    body: "No major issues detected — great work on this sentence.",
  };
}

export interface ProblemWordDisplay {
  word: string;
  score: number;
}

/** Current-sentence "words to improve": Azure word-level accuracy scores
 *  below PROBLEM_WORD_THRESHOLD, deduped (case-insensitive) and with
 *  punctuation-only tokens excluded, sorted weakest first. A score of
 *  exactly 0 is included; a missing score (null/undefined) is excluded
 *  since there's nothing to rank. */
export function currentSentenceProblemWords(
  words: TrueEvaluationWord[] | undefined,
  threshold: number = PROBLEM_WORD_THRESHOLD
): ProblemWordDisplay[] {
  if (!words || words.length === 0) return [];
  const seen = new Set<string>();
  const result: ProblemWordDisplay[] = [];
  for (const w of words) {
    if (w.accuracyScore === null || w.accuracyScore === undefined) continue;
    if (w.accuracyScore >= threshold) continue;
    const stripped = stripEdgePunctuation(w.word);
    if (!stripped) continue;
    const key = stripped.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ word: stripped, score: w.accuracyScore });
  }
  return result.sort((a, b) => a.score - b.score);
}

export type EvaluationUiState =
  | "no-recording"
  | "recording-ready"
  | "new-recording-not-evaluated"
  | "evaluating"
  | "success"
  | "error";

/**
 * Derives what the Pronunciation Assessment card should show from the raw
 * SentenceEvaluation + the live recording clip's identity. A "stale" score
 * (one that belongs to a discarded take) is detected by comparing the
 * current clip's id against the last successful evaluation's own clipId —
 * see "Shadowing Evaluation Improvement Plan" §5/§6.2.
 */
export function deriveEvaluationUiState(params: {
  hasClip: boolean;
  recordingClipId: string | null;
  trueEvaluation: TrueEvaluationResult | undefined;
  lastSuccessful: TrueEvaluationResult | undefined;
}): EvaluationUiState {
  const { hasClip, recordingClipId, trueEvaluation, lastSuccessful } = params;
  if (!hasClip) return "no-recording";
  if (trueEvaluation?.status === "processing") return "evaluating";
  if (trueEvaluation?.status === "failed" || trueEvaluation?.status === "unavailable") return "error";
  if (lastSuccessful && lastSuccessful.clipId !== recordingClipId) return "new-recording-not-evaluated";
  if (lastSuccessful) return "success";
  return "recording-ready";
}
