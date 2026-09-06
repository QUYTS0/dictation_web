import { formatErrorTypeLabel, stripEdgePunctuation } from "./helpers";
import type { TrueEvaluationPhoneme, TrueEvaluationResult, TrueEvaluationSyllable, TrueEvaluationWord } from "./types";

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

/** Single strong/moderate/weak → color map shared by MetricGrid and the
 *  Pronunciation card's headline score, so a color always means the same
 *  thing everywhere it's used as a secondary (never sole) signal alongside
 *  the /100 number. */
export const SEMANTIC_TEXT_CLASS: Record<SemanticTier, string> = {
  strong: "text-[var(--green)]",
  moderate: "text-[var(--text)]",
  weak: "text-[var(--red)]",
};

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
  // Reached only when accuracy itself is the weakest metric but no
  // individual word was flagged with a low enough score to explain why
  // (focusFor's word-level check already wins otherwise) — so this can't
  // point at "the words flagged below" the way it used to.
  accuracy: {
    title: "Focus on accuracy",
    body: "Repeat the lowest-scoring word more carefully.",
  },
  fluency: {
    title: "Focus on fluency",
    body: "Try the sentence again with smoother connections and fewer pauses.",
  },
  completeness: {
    title: "Focus on completeness",
    body: "Part of the sentence wasn't picked up. Make sure you say every word out loud, including short ones at the start or end.",
  },
  // Deliberately not "match the speaker's rhythm" — that phrasing implied a
  // specific rhythm problem even when Azure's actual prosody feedback (see
  // ProsodyFeedback) gave no such evidence; focusFor already prefers the
  // real Break/Monotone diagnosis when one exists and only falls back to
  // this generic line when it doesn't.
  prosody: {
    title: "Focus on prosody",
    body: "Use more natural stress and intonation.",
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
  | { kind: "word"; word: string; errorType: string; score?: number; weakestSound?: WeakestSound; coaching?: string }
  | { kind: "metric"; key: MetricKey; title: string; body: string }
  | { kind: "strong"; message: string }
  | null;

const WORD_ERROR_COACHING: Record<string, string> = {
  Mispronunciation: "Say it again with clearer pronunciation.",
  Omission: "Don't skip this word. Say the full phrase.",
  Insertion: "Avoid adding an extra word here.",
};

const BREAK_COACHING: Record<"UnexpectedBreak" | "MissingBreak", string> = {
  UnexpectedBreak: "Keep these words connected. Avoid pausing here.",
  MissingBreak: "Add a short pause here.",
};

const MONOTONE_COACHING = "Use more pitch variation and stress the key words.";

/** The single weakest-scoring phoneme in a word (ties keep the first/
 *  earliest one) — null when the word has no phoneme data or every
 *  phoneme's score is missing. */
function weakestPhoneme(
  phonemes: TrueEvaluationPhoneme[] | undefined
): { phoneme: TrueEvaluationPhoneme; index: number; score: number } | null {
  if (!phonemes) return null;
  let weakest: { phoneme: TrueEvaluationPhoneme; index: number; score: number } | null = null;
  phonemes.forEach((phoneme, index) => {
    if (phoneme.accuracyScore === null || phoneme.accuracyScore === undefined) return;
    if (!weakest || phoneme.accuracyScore < weakest.score) {
      weakest = { phoneme, index, score: phoneme.accuracyScore };
    }
  });
  return weakest;
}

export interface WeakestSound {
  phoneme: string;
  score: number;
  /** Azure's OWN top-ranked NBestPhonemes candidate, but ONLY when it
   *  actually differs from the phoneme itself. A low AccuracyScore does not
   *  mean Azure heard something else — NBestPhonemes[0] is very often the
   *  expected phoneme itself (Azure is just marking it as poorly executed),
   *  and picking a lower-ranked candidate as "heard" in that case would be
   *  a fabricated claim. See the doc comment on weakestSoundFor(). */
  heardAs?: string;
}

/**
 * The one weakest-scoring phoneme in a word, for every learner-facing
 * surface (Focus, Word details, Detailed Report) to render identically.
 *
 * IMPORTANT — the Expected/Heard rule: `heardAs` is set only when Azure's
 * own top NBest candidate (`nBestPhonemes[0]`, unfiltered) differs from the
 * phoneme itself. Earlier logic filtered the phoneme OUT of the candidate
 * list first and then picked the best remaining alternative above a score
 * threshold — which fabricated a "heard" phoneme even when Azure's actual
 * top guess matched the expected phoneme all along (e.g. expected /ɪ/,
 * AccuracyScore 4, NBestPhonemes [/ɪ/ 100, /z/ 45, ...] — a low score is
 * not evidence of hearing something else). There is no score-threshold
 * heuristic here; Azure's own ranking is the only signal used.
 */
export function weakestSoundFor(phonemes: TrueEvaluationPhoneme[] | undefined): WeakestSound | null {
  const weakest = weakestPhoneme(phonemes);
  if (!weakest) return null;
  const topCandidate = weakest.phoneme.nBestPhonemes?.[0];
  const heardAs = topCandidate && topCandidate.phoneme !== weakest.phoneme.phoneme ? topCandidate.phoneme : undefined;
  return { phoneme: weakest.phoneme.phoneme, score: weakest.score, heardAs };
}

export interface WeakestSyllable {
  syllable: string;
  grapheme?: string;
  score: number;
}

/** The one weakest-scoring syllable in a word — same "ties keep first,
 *  missing scores excluded" rule as weakestPhoneme, exposed for the
 *  Detailed Report's Word analysis (Word details in the right panel does
 *  not surface a weakest syllable, only a weakest sound). */
export function weakestSyllableFor(syllables: TrueEvaluationSyllable[] | undefined): WeakestSyllable | null {
  if (!syllables) return null;
  let weakest: WeakestSyllable | null = null;
  for (const s of syllables) {
    if (s.accuracyScore === null || s.accuracyScore === undefined) continue;
    if (!weakest || s.accuracyScore < weakest.score) {
      weakest = { syllable: s.syllable, grapheme: s.grapheme, score: s.accuracyScore };
    }
  }
  return weakest;
}

export function formatWeakestSoundLabel(sound: WeakestSound): string {
  return `Weakest sound: /${sound.phoneme}/ · ${Math.round(sound.score)}/100`;
}

export function formatWeakestSyllableLabel(syllable: WeakestSyllable): string {
  const grapheme = syllable.grapheme ? `${syllable.grapheme} · ` : "";
  return `Weakest part: ${grapheme}/${syllable.syllable}/ · ${Math.round(syllable.score)}/100`;
}

/** Null when Azure's top candidate matches the expected phoneme — never
 *  fabricates an Expected/Heard claim from a lower-ranked candidate. */
export function formatExpectedHeardLabel(sound: WeakestSound): string | null {
  if (!sound.heardAs) return null;
  return `Expected /${sound.phoneme}/ → Heard /${sound.heardAs}/`;
}

/** Looks up a word by its display text (edge punctuation stripped,
 *  case-insensitive) — the same normalization currentSentenceProblemWords
 *  already applies internally, needed here to go from a ProblemWordDisplay
 *  back to the full TrueEvaluationWord (for its phonemes/syllables). */
export function findWord(words: TrueEvaluationWord[] | undefined, displayName: string): TrueEvaluationWord | undefined {
  return words?.find((w) => stripEdgePunctuation(w.word).toLowerCase() === displayName.toLowerCase());
}

/**
 * The single deterministic "what should the learner do next" block,
 * replacing three separate (and sometimes contradictory) surfaces —
 * "Strong result" / "Words to improve" / "Word-level detail" — with one.
 * Priority is fixed and structural: phoneme-level evidence on the weakest
 * flagged word > that word's own error type > a sentence-wide break/
 * monotone problem (only reached when no word was flagged at all) > a
 * single weak metric > a positive message. Never fabricates a phoneme or
 * rhythm claim Azure didn't actually provide — see weakestSoundFor() and
 * the ProsodyFeedback fields on TrueEvaluationWord.
 */
export function focusFor(scores: MetricScores, words: TrueEvaluationWord[] | undefined): FocusResult {
  const problemWords = currentSentenceProblemWords(words);

  if (problemWords.length > 0) {
    const weakest = problemWords[0];
    const wordObj = findWord(words, weakest.word);
    const rawErrorType = wordObj?.errorType && wordObj.errorType !== "None" ? wordObj.errorType : "Mispronunciation";
    const weakestSound = weakestSoundFor(wordObj?.phonemes) ?? undefined;
    return {
      kind: "word",
      word: weakest.word,
      errorType: formatErrorTypeLabel(rawErrorType),
      score: weakest.score,
      weakestSound,
      // The structured weakest-sound/Expected-Heard lines replace this
      // prose entirely when phoneme data is available — only used as a
      // fallback for older records or words Azure returned no phoneme
      // breakdown for.
      coaching: weakestSound ? undefined : WORD_ERROR_COACHING[rawErrorType],
    };
  }

  // No word was flagged on accuracy — check for a sentence-wide prosody
  // problem before falling back to generic metric-level copy.
  const breakWord = words?.find((w) => w.prosodyFeedback?.breakErrorType);
  const breakType = breakWord?.prosodyFeedback?.breakErrorType;
  if (breakWord && breakType) {
    return {
      kind: "word",
      word: breakWord.word,
      errorType: formatErrorTypeLabel(breakType),
      coaching: BREAK_COACHING[breakType],
    };
  }

  const monotoneWord = words?.find((w) => w.prosodyFeedback?.intonationErrorType === "Monotone");
  if (monotoneWord) {
    return {
      kind: "word",
      word: monotoneWord.word,
      errorType: formatErrorTypeLabel("Monotone"),
      coaching: MONOTONE_COACHING,
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
