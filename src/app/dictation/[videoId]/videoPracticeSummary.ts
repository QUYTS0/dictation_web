import { countWords, type ShadowingSummaryInput, type SummaryWordInput } from "@/lib/practice/shadowingSummary";
import type { ShadowingEvaluationMap } from "./shadowingEvaluationPersistence";
import type { SentenceEvaluation, SentenceEvaluationAttempt, TrueEvaluationResult, WordMatchResult } from "./types";

/**
 * The practice page's adapter from its live per-sentence map to the shared
 * Shadowing summary (src/lib/practice/shadowingSummary.ts). The aggregation
 * itself lives there, shared with every round report; this file only decides
 * which of the page's results are SAVED evidence and reshapes them.
 */

/**
 * The pronunciation result a sentence contributes to the summary: its latest
 * successful Azure evaluation (chronological — never the best score), and
 * only when it is saved. A new, unevaluated / pending / failed take never
 * removes it (it lives in `trueEvaluation`, not here); a result shown but not
 * stored ("unsaved", "superseded", "conflict") never counts. Word Match is a
 * separate browser-recognition result and never counts as an evaluation.
 */
export function savedAzureEvaluationFor(entry: SentenceEvaluation): TrueEvaluationResult | undefined {
  const te = entry.lastSuccessfulTrueEvaluation;
  if (!te || te.status !== "completed") return undefined;
  if (te.persistence === "unsaved" || te.persistence === "superseded" || te.persistence === "conflict") return undefined;
  return te;
}

/** A Word Match result that is stored (or a visitor's local-only one) — never one the server refused. */
function savedWordMatchFor(entry: SentenceEvaluation): WordMatchResult | undefined {
  const wm = entry.wordMatch;
  if (!wm || wm.status !== "completed" || wm.persisted === false) return undefined;
  return wm;
}

/** Converts a full completed TrueEvaluationResult into the compact shape
 *  stored on SentenceEvaluation.attempts — also used to synthesize a
 *  single-point history for older records that predate the attempts field. */
export function toAttempt(result: TrueEvaluationResult): SentenceEvaluationAttempt {
  return {
    evaluatedAt: result.evaluatedAt ?? new Date(0).toISOString(),
    ...(result.recordingCreatedAt ? { createdAt: result.recordingCreatedAt } : {}),
    clipId: result.clipId,
    attemptId: result.attemptId,
    pronunciationScore: result.pronunciationScore,
    accuracyScore: result.accuracyScore,
    fluencyScore: result.fluencyScore,
    completenessScore: result.completenessScore,
    prosodyScore: result.prosodyScore,
    words: (result.words ?? []).map((w) => ({ word: w.word, accuracyScore: w.accuracyScore, errorType: w.errorType })),
  };
}

/** Every retained attempt for a sentence — falls back to a single point from
 *  the saved result for older records that predate the attempts field. */
function attemptsFor(entry: SentenceEvaluation): SentenceEvaluationAttempt[] {
  if (entry.attempts && entry.attempts.length > 0) return entry.attempts;
  const saved = savedAzureEvaluationFor(entry);
  return saved ? [toAttempt(saved)] : [];
}

const n = (v: number | null | undefined): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function summaryWords(words: TrueEvaluationResult["words"]): SummaryWordInput[] | null {
  if (!words || words.length === 0) return null;
  return words.map((w) => ({
    word: w.word,
    accuracyScore: n(w.accuracyScore),
    errorType: w.errorType ?? "None",
    ...(w.phonemes ? { phonemes: w.phonemes.map((p) => ({ phoneme: p.phoneme, accuracyScore: n(p.accuracyScore) })) } : {}),
    ...(w.prosodyFeedback
      ? { prosodyFeedback: { breakErrorType: w.prosodyFeedback.breakErrorType, intonationErrorType: w.prosodyFeedback.intonationErrorType } }
      : {}),
  }));
}

export function summaryInputFromEvaluations(
  evaluations: ShadowingEvaluationMap,
  counts: { eligibleSentences: number | null; recordedSentences: number | null }
): ShadowingSummaryInput {
  return {
    eligibleSentences: counts.eligibleSentences,
    recordedSentences: counts.recordedSentences,
    sentences: Object.values(evaluations).map((entry) => {
      const te = savedAzureEvaluationFor(entry);
      const wm = savedWordMatchFor(entry);
      return {
        segmentIndex: entry.segmentIndex,
        referenceText: entry.referenceText,
        wordCount: countWords(entry.referenceText),
        audioDurationSec: Number(entry.audioDuration ?? 0),
        representative: te
          ? {
              attemptId: te.attemptId ?? null,
              recordingCreatedAt: te.recordingCreatedAt ?? null,
              evaluatedAt: te.evaluatedAt ?? null,
              scores: {
                pronunciation: n(te.pronunciationScore),
                accuracy: n(te.accuracyScore),
                fluency: n(te.fluencyScore),
                completeness: n(te.completenessScore),
                prosody: n(te.prosodyScore),
              },
              words: summaryWords(te.words),
            }
          : null,
        history: te
          ? attemptsFor(entry).map((a) => ({
              attemptId: a.attemptId ?? null,
              recordingCreatedAt: a.createdAt ?? null,
              evaluatedAt: a.evaluatedAt ?? null,
              pronunciationScore: n(a.pronunciationScore),
              words: a.words && a.words.length > 0 ? a.words.map((w) => ({ word: w.word, accuracyScore: n(w.accuracyScore), errorType: w.errorType })) : null,
            }))
          : [],
        wordMatch: wm ? { accuracy: n(wm.accuracy), completeness: n(wm.completeness) } : null,
      };
    }),
  };
}
