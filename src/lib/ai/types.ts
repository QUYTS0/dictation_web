/**
 * Learning Reports P5 — request/response contracts shared by the AI routes,
 * the report route and the report page. No server-only imports.
 */

export interface OverviewPayloadView {
  overview: string;
  strengths: { text: string; evidenceIds: string[] }[];
  priorities: { title: string; explanation: string; evidenceIds: string[]; practice: string }[];
  practicePlan: string[];
  limitations: string[];
}

/** Stored with an accepted overview (round_assessments.accepted_meta). */
export interface AssessmentMetaView {
  generatedAt: string;
  promptVersion: number;
  model: string;
  /** Sentences Gemini saw individually vs only as counts. Statistics always cover every sentence. */
  evidence: { individual: number; aggregateOnly: number; total: number };
  /** The explanation half of the same request. */
  notes: { requested: number; valid: number };
  truncated: boolean;
  droppedStrengths: number;
  droppedPriorities: number;
}

/** Per-operation save outcome, reported independently. */
export type AiSaveStatus =
  | "saved" // stored now (or the identical result was already stored)
  | "reused" // a compatible saved result exists — no provider call was needed
  | "not_requested" // this request didn't include this part
  | "skipped_busy" // another request is generating this part; not included
  | "none_usable" // the response had nothing usable for this part — nothing stored, earlier results kept
  | "unusable" // (overview) the response's overview was unusable — earlier assessment kept
  | "superseded" // a newer generation started meanwhile — this result was discarded
  | "conflict" // a different result is already stored for this operation — kept
  | "rejected" // the database refused it (e.g. outdated app) — nothing stored
  | "not_saved"; // generated, but storing failed — recoverable with the token

export interface AiRecoveryEntryOverview {
  op: "overview";
  token: string;
  payload: OverviewPayloadView;
  meta: AssessmentMetaView;
}
export interface AiRecoveryEntryNotes {
  op: "explanations";
  token: string;
  items: Record<string, unknown>[];
}
export type AiRecoveryEntry = AiRecoveryEntryOverview | AiRecoveryEntryNotes;

export interface UnsavedNoteView {
  attemptId: string;
  kind: "explanation" | "minor" | "duplicate";
  explanation: string;
  correctedText: string | null;
  example: string | null;
  refAttemptId: string | null;
}

export interface AiActionResponse {
  action: "generate" | "explain";
  overview: { status: AiSaveStatus; payload?: OverviewPayloadView; meta?: AssessmentMetaView; recovery?: AiRecoveryEntryOverview };
  explanations: {
    status: AiSaveStatus | "no_targets";
    requested: number;
    valid: number;
    saved: number;
    /** Requested targets without a valid note (missing, empty, unknown or invalid). */
    missing: number;
    /** Missing targets left in the round after this request (no automatic loop). */
    remaining: number;
    /** Shown as "Not saved yet" until a recovery succeeds. */
    unsaved?: UnsavedNoteView[];
    recovery?: AiRecoveryEntryNotes;
  };
  /** The provider stopped at its output limit: coverage is incomplete. */
  truncated: boolean;
  /** Provider requests admitted for this action (1, or 2 with the parse retry). */
  requestsUsed: number;
}

export interface AiRecoverResponse {
  results: { op: "overview" | "explanations"; status: AiSaveStatus | "expired" | "invalid" }[];
}

/** The report route's AI block (read-only). */
export interface ReportAiView {
  /** Accepted new-format assessment, or null. */
  accepted: null | {
    payload: OverviewPayloadView;
    meta: AssessmentMetaView | null;
    acceptedAt: string;
    /** Based on the current learning data (fingerprint equal). */
    fresh: boolean;
    /** Made with the server's current prompt version and model. */
    contentCurrent: boolean;
  };
  /** Legacy (pre-P5) assessment shown only while nothing new-format was accepted. */
  legacy: null | { verdict: string; strengths: string[]; weaknesses: string[]; recommendation: string; generatedAt: string | null };
  /** A generation for this round is running now. */
  generating: boolean;
  targets: { total: number; missing: number };
  /** Current content version (for labels). */
  current: { promptVersion: number; model: string };
}
