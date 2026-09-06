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

/** The single "should the learner act on this" threshold — below this, a
 *  metric triggers a Focus feedback line, a word counts as a problem word,
 *  and a sentence would count as "needs practice." Previously three
 *  separately-named constants independently hard-coded to the same value
 *  (LOW_METRIC_THRESHOLD, PROBLEM_WORD_THRESHOLD, NEEDS_PRACTICE_THRESHOLD)
 *  — consolidated into one so a future change can't drift between them.
 *  Deliberately a different scale from scoreTierFor (90/75/60, "how good in
 *  words") and semanticTierFor (80/60, "what color") — those answer
 *  different questions and merging them would lose real functionality
 *  (a 78 should read as a solid "Great" while still not being urgent
 *  enough to trigger a Focus callout). */
export const FOCUS_THRESHOLD = 70;

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
    return value !== null && value !== undefined && value < FOCUS_THRESHOLD;
  });

  if (lowMetrics.length >= 2) {
    const names = lowMetrics.map((key) => METRIC_LABELS[key]).join(", ");
    return {
      title: "A few areas to work on",
      body: `Your ${names} scores were all below ${FOCUS_THRESHOLD}. Try recording a slower, more deliberate take of this sentence.`,
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

/** Current-sentence problem words (surfaced via the Focus block): Azure
 *  word-level accuracy scores below FOCUS_THRESHOLD, deduped (case-insensitive) and with
 *  punctuation-only tokens excluded, sorted weakest first. A score of
 *  exactly 0 is included; a missing score (null/undefined) is excluded
 *  since there's nothing to rank. */
export function currentSentenceProblemWords(
  words: TrueEvaluationWord[] | undefined,
  threshold: number = FOCUS_THRESHOLD
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

export type FocusResult =
  | { kind: "word"; word: string; score: number; message: string }
  | { kind: "metric"; key: MetricKey; title: string; body: string }
  | { kind: "strong"; message: string }
  | null;

/**
 * The single deterministic "what should the learner do next" block,
 * replacing three separate (and sometimes contradictory) surfaces —
 * "Strong result" / "Words to improve" / "Word-level detail" — with one.
 * Priority is fixed and structural, not a special case: a weak word always
 * wins over a weak metric, which always wins over a positive message, so
 * "Strong result" can never be shown while a flagged word or metric exists.
 */
export function focusFor(scores: MetricScores, problemWords: ProblemWordDisplay[]): FocusResult {
  if (problemWords.length > 0) {
    const weakest = problemWords[0];
    return {
      kind: "word",
      word: weakest.word,
      score: weakest.score,
      message: `Practice "${weakest.word}" and match the speaker's rhythm.`,
    };
  }

  const weakestMetricResult = weakestMetric(scores);
  const feedback = feedbackFor(scores, weakestMetricResult);
  if (!feedback) return null;
  if (feedback.title === "Strong result") return { kind: "strong", message: feedback.body };
  if (!weakestMetricResult) return null;
  return { kind: "metric", key: weakestMetricResult.key, title: feedback.title, body: feedback.body };
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
