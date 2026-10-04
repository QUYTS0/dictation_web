/**
 * Adapter: the saved round results (GET /api/practice/attempts?roundId= →
 * fn_shadowing_round_results, migration 038) → ShadowingSummaryInput. Used by
 * every round report. The practice page adapts its live map with
 * app/dictation/[videoId]/shadowingSummaryLive.ts; a parity test keeps the
 * two equal for the same saved data.
 */
import type { ShadowingRoundResults, StoredAzureWord } from "./shadowingTypes";
import { countWords, type ShadowingSummaryInput, type SummaryWordInput } from "./shadowingSummary";

const n = (v: number | string | null | undefined): number | null => (v === null || v === undefined ? null : Number(v));

/** A stored word list in the summary's shape; null when no usable word detail exists. */
export function summaryWordsFrom(words: unknown): SummaryWordInput[] | null {
  if (!Array.isArray(words) || words.length === 0) return null;
  return (words as StoredAzureWord[]).map((w) => {
    const phonemes = Array.isArray(w.phonemes)
      ? (w.phonemes as Array<{ phoneme: string; accuracyScore: number | null }>).map((p) => ({ phoneme: p.phoneme, accuracyScore: n(p.accuracyScore) }))
      : undefined;
    const pf = w.prosodyFeedback as SummaryWordInput["prosodyFeedback"] | undefined;
    return {
      word: String(w.word ?? ""),
      accuracyScore: n(w.accuracyScore),
      errorType: typeof w.errorType === "string" ? w.errorType : "None",
      ...(phonemes ? { phonemes } : {}),
      ...(pf ? { prosodyFeedback: { breakErrorType: pf.breakErrorType, intonationErrorType: pf.intonationErrorType } } : {}),
    };
  });
}

export function fromRoundResults(
  results: ShadowingRoundResults,
  referenceTextFor: (segmentIndex: number) => string,
  counts: { eligibleSentences: number | null; recordedSentences: number | null }
): ShadowingSummaryInput {
  return {
    eligibleSentences: counts.eligibleSentences,
    recordedSentences: counts.recordedSentences,
    sentences: results.segments.map((seg) => {
      const referenceText = referenceTextFor(seg.segmentIndex);
      const rep = seg.latestSuccessfulAzureAttempt;
      const wm = seg.latestWordMatchAttempt;
      return {
        segmentIndex: seg.segmentIndex,
        referenceText,
        wordCount: countWords(referenceText),
        audioDurationSec: Number(rep?.recordingDurationSec ?? seg.latestAttempt?.recordingDurationSec ?? 0),
        representative: rep
          ? {
              attemptId: rep.attemptId,
              recordingCreatedAt: rep.createdAt,
              evaluatedAt: rep.azure.evaluatedAt ?? rep.createdAt,
              scores: {
                pronunciation: n(rep.azure.pronunciationScore),
                accuracy: n(rep.azure.accuracyScore),
                fluency: n(rep.azure.fluencyScore),
                completeness: n(rep.azure.completenessScore),
                prosody: n(rep.azure.prosodyScore),
              },
              words: summaryWordsFrom(rep.azure.detail?.words),
            }
          : null,
        history: seg.azureHistory.map((h) => ({
          attemptId: h.attemptId,
          recordingCreatedAt: h.createdAt,
          evaluatedAt: h.evaluatedAt ?? h.createdAt,
          pronunciationScore: n(h.pronunciationScore),
          words: Array.isArray(h.words) && h.words.length > 0 ? h.words.map((w) => ({ word: String(w.word ?? ""), accuracyScore: n(w.accuracyScore), errorType: w.errorType ?? "None" })) : null,
        })),
        wordMatch: wm ? { accuracy: n(wm.wordMatch.accuracy), completeness: n(wm.wordMatch.completeness) } : null,
      };
    }),
  };
}
