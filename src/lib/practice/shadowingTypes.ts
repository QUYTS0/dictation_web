// Wire types for the Phase 4 Shadowing persistence endpoints (client-safe:
// no server imports). Mirrors fn_shadowing_attempt_dto in migration 038.

import type { RoundProgress } from "@/lib/types";

export type AzureEvalStatus = "not_evaluated" | "pending" | "completed" | "failed";
export type WordMatchStatus = "completed" | "failed" | "unsupported";

export interface StoredAzureWord {
  word: string;
  accuracyScore: number | null;
  errorType: string;
  [key: string]: unknown;
}

export interface StoredAzureDetail {
  recognizedText?: string;
  words?: StoredAzureWord[];
}

export interface StoredWordMatchDetail {
  recognizedText?: string;
  problemWords?: Array<{ word: string; errorType: string }>;
}

export interface ShadowingAttemptDto {
  attemptId: string;
  clientAttemptId: string;
  roundId: string;
  youtubeVideoId: string;
  transcriptId: string | null;
  segmentIndex: number;
  createdAt: string;
  recordingDurationSec: number;
  isPracticeValid: boolean;
  validityBasis: "client_reported" | "server_verified";
  studySessionId: string | null;
  azure: {
    status: AzureEvalStatus;
    seq: number;
    requestedAt: string | null;
    evaluatedAt: string | null;
    pronunciationScore: number | null;
    accuracyScore: number | null;
    fluencyScore: number | null;
    completenessScore: number | null;
    prosodyScore: number | null;
    errorReason: string | null;
    engineVersion: string | null;
    detail: StoredAzureDetail | null;
  };
  wordMatch: {
    status: WordMatchStatus | null;
    seq: number;
    accuracy: number | null;
    completeness: number | null;
    evaluatedAt: string | null;
    detail: StoredWordMatchDetail | null;
  };
}

export interface ShadowingAzureHistoryItem {
  attemptId: string;
  createdAt: string;
  evaluatedAt: string | null;
  pronunciationScore: number | null;
  accuracyScore: number | null;
  fluencyScore: number | null;
  completenessScore: number | null;
  prosodyScore: number | null;
  words: Array<{ word: string; accuracyScore: number | null; errorType: string }>;
}

export interface ShadowingSegmentResults {
  segmentIndex: number;
  attemptCount: number;
  latestAttempt: ShadowingAttemptDto | null;
  latestSuccessfulAzureAttempt: ShadowingAttemptDto | null;
  latestWordMatchAttempt: ShadowingAttemptDto | null;
  azureHistory: ShadowingAzureHistoryItem[];
}

export interface ShadowingRoundResults {
  roundId: string;
  youtubeVideoId: string;
  transcriptId: string | null;
  roundStatus: "active" | "completed" | "abandoned";
  evaluationTimeoutSec: number;
  segments: ShadowingSegmentResults[];
}

/** POST /api/practice/attempt */
export interface RecordShadowingAttemptRequest {
  youtubeVideoId: string;
  roundId?: string | null;
  transcriptId: string;
  segmentIndex: number;
  clientAttemptId: string;
  recordingDurationSec: number;
  studySessionId?: string | null;
}

export interface RecordShadowingAttemptResponse {
  attemptId: string;
  clientAttemptId: string;
  roundId: string;
  wasInserted: boolean;
  isPracticeValid: boolean;
  studySessionId: string | null;
  roundCompletedByThisRequest: boolean;
  roundStatus: "active" | "completed" | "abandoned";
  progress: RoundProgress;
  coverage: RoundProgress["coverage"];
}

/** POST /api/practice/evaluate (200). `persisted` says whether the scores
 *  below are stored; when false they are still a real evaluation of this
 *  recording, shown as "not saved". */
export interface EvaluateAttemptResponse {
  engine: "azure";
  attemptId: string;
  seq: number;
  persisted: boolean;
  /** A newer evaluation request for this attempt exists; this result was
   *  not stored and is not the attempt's result. */
  superseded?: boolean;
  /** Present only when persisted is false and not superseded. Opaque. */
  recoveryToken?: string;
  recoveryExpiresAt?: string;
  pronScore: number | null;
  accuracy: number | null;
  fluency: number | null;
  completeness: number | null;
  prosody: number | null;
  words: unknown[];
  recognizedText: string;
  rawResult?: Record<string, unknown>;
}

export interface WordMatchSubmitResponse {
  attemptId: string;
  status: WordMatchStatus;
  seq: number;
  applied: boolean;
  accuracy: number | null;
  completeness: number | null;
  problemWords: Array<{ word: string; errorType: string }>;
}
