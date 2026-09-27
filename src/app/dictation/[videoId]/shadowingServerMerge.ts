// Builds the page's per-sentence Shadowing map from what the SERVER stored
// for a round, and reconciles it with the local cache. Pure functions.
//
// Rules (Phase 4):
//   * server truth wins — any saved result comes from the server response;
//   * the local cache may only ADD results that are not saved yet
//     (persistence "unsaved" / persisted:false) for a known attemptId the
//     server does not already have a result for — never overwrite one;
//   * local entries without an attemptId (pre-Phase-4 caches) or claiming
//     to be saved while the server doesn't have them are dropped, never
//     promoted to saved results.

import { splitSentenceIntoWords } from "./helpers";
import type { ShadowingAttemptDto, ShadowingRoundResults, ShadowingSegmentResults } from "@/lib/practice/shadowingTypes";
import type { ShadowingEvaluationMap } from "./shadowingEvaluationPersistence";
import type { SentenceEvaluation, TrueEvaluationResult, TrueEvaluationWord, WordMatchResult } from "./types";

const num = (v: number | string | null | undefined): number | undefined =>
  v === null || v === undefined ? undefined : Number(v);

function azureResultFrom(dto: ShadowingAttemptDto): TrueEvaluationResult {
  const a = dto.azure;
  return {
    status: "completed",
    pronunciationScore: num(a.pronunciationScore),
    accuracyScore: num(a.accuracyScore),
    fluencyScore: num(a.fluencyScore),
    completenessScore: num(a.completenessScore),
    prosodyScore: num(a.prosodyScore),
    recognizedText: a.detail?.recognizedText,
    words: (a.detail?.words ?? []) as unknown as TrueEvaluationWord[],
    evaluatedAt: a.evaluatedAt ?? dto.createdAt,
    attemptId: dto.attemptId,
    seq: a.seq,
    persistence: "saved",
    restored: true,
  };
}

function wordMatchFrom(dto: ShadowingAttemptDto): WordMatchResult {
  const w = dto.wordMatch;
  return {
    status: "completed",
    recognizedText: w.detail?.recognizedText ?? "",
    accuracy: num(w.accuracy),
    completeness: num(w.completeness),
    problemWords: w.detail?.problemWords ?? [],
    attemptId: dto.attemptId,
    persisted: true,
  };
}

function failureMessage(reason: string | null): string {
  if (reason === "expired") return "The evaluation of your latest recording didn't finish. Record again to evaluate.";
  if (reason === "quota_exceeded") return "Monthly free evaluation limit reached.";
  return reason || "The evaluation of your latest recording failed.";
}

export function entryFromServer(seg: ShadowingSegmentResults, referenceText: string): SentenceEvaluation {
  const latest = seg.latestAttempt;
  const lastSuccessful = seg.latestSuccessfulAzureAttempt ? azureResultFrom(seg.latestSuccessfulAzureAttempt) : undefined;
  let trueEvaluation: TrueEvaluationResult | undefined = lastSuccessful;
  if (latest && latest.azure.status === "failed" && latest.attemptId !== lastSuccessful?.attemptId) {
    trueEvaluation = { status: "failed", error: failureMessage(latest.azure.errorReason), attemptId: latest.attemptId, restored: true };
  }
  return {
    segmentIndex: seg.segmentIndex,
    referenceText,
    wordCount: splitSentenceIntoWords(referenceText).length,
    audioDuration: Number(seg.latestSuccessfulAzureAttempt?.recordingDurationSec ?? latest?.recordingDurationSec ?? 0),
    wordMatch: seg.latestWordMatchAttempt ? wordMatchFrom(seg.latestWordMatchAttempt) : undefined,
    trueEvaluation,
    lastSuccessfulTrueEvaluation: lastSuccessful,
    attempts: seg.azureHistory.map((h) => ({
      evaluatedAt: h.evaluatedAt ?? h.createdAt,
      attemptId: h.attemptId,
      pronunciationScore: num(h.pronunciationScore),
      accuracyScore: num(h.accuracyScore),
      fluencyScore: num(h.fluencyScore),
      completenessScore: num(h.completenessScore),
      prosodyScore: num(h.prosodyScore),
      words: h.words,
    })),
    latestRecording: latest
      ? {
          attemptId: latest.attemptId,
          createdAt: latest.createdAt,
          azureStatus: latest.azure.status,
          isPracticeValid: latest.isPracticeValid,
        }
      : undefined,
  };
}

export function mergeServerResults(
  local: ShadowingEvaluationMap,
  server: ShadowingRoundResults,
  referenceTextFor: (segmentIndex: number) => string
): ShadowingEvaluationMap {
  const out: ShadowingEvaluationMap = {};
  for (const seg of server.segments) {
    out[seg.segmentIndex] = entryFromServer(seg, referenceTextFor(seg.segmentIndex));
  }
  for (const [key, loc] of Object.entries(local)) {
    const i = Number(key);
    const srv = out[i];
    const te = loc.trueEvaluation;
    const keepTrue =
      te?.status === "completed" &&
      !!te.attemptId &&
      (te.persistence === "unsaved" || te.persistence === "superseded") &&
      srv?.lastSuccessfulTrueEvaluation?.attemptId !== te.attemptId;
    const wm = loc.wordMatch;
    const keepWordMatch =
      wm?.status === "completed" && !!wm.attemptId && wm.persisted === false && srv?.wordMatch?.attemptId !== wm.attemptId;
    if (!keepTrue && !keepWordMatch) continue;
    const base: SentenceEvaluation = srv ?? {
      segmentIndex: i,
      referenceText: loc.referenceText,
      wordCount: loc.wordCount,
      audioDuration: loc.audioDuration,
    };
    out[i] = {
      ...base,
      ...(keepTrue ? { trueEvaluation: te } : {}),
      ...(keepWordMatch ? { wordMatch: wm } : {}),
    };
  }
  return out;
}
