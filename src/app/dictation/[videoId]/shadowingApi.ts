// Client calls for Phase 4 Shadowing persistence. Every failure is a typed
// ShadowingApiError so callers can tell "retry later" from "reload".

import type {
  RecordShadowingAttemptRequest,
  RecordShadowingAttemptResponse,
  ShadowingAttemptDto,
  ShadowingRoundResults,
  WordMatchStatus,
  WordMatchSubmitResponse,
} from "@/lib/practice/shadowingTypes";

export class ShadowingApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
    /** Worth retrying the same request (network error, maintenance, 5xx). */
    public retryable = false
  ) {
    super(message);
  }
}

async function toError(res: Response, fallback: string): Promise<ShadowingApiError> {
  let body: { error?: string; message?: string; code?: string; retryable?: boolean } = {};
  try {
    body = await res.json();
  } catch {
    // non-JSON error body
  }
  const retryable = body.retryable === true || res.status >= 500 || res.status === 429;
  return new ShadowingApiError(body.message ?? body.error ?? fallback, res.status, body.code ?? body.error, retryable);
}

async function send<T>(input: string, init: RequestInit, fallback: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(input, init);
  } catch {
    throw new ShadowingApiError("Couldn't reach the server.", 0, "network_error", true);
  }
  if (!res.ok) throw await toError(res, fallback);
  return (await res.json()) as T;
}

export function recordShadowingAttempt(body: RecordShadowingAttemptRequest): Promise<RecordShadowingAttemptResponse> {
  return send(
    "/api/practice/attempt",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    "Failed to save your recording"
  );
}

export function submitWordMatch(
  attemptId: string,
  body: { status: WordMatchStatus; recognizedText?: string }
): Promise<WordMatchSubmitResponse> {
  return send(
    `/api/practice/attempt/${attemptId}/word-match`,
    { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    "Failed to save Word Match"
  );
}

export function fetchShadowingAttempt(attemptId: string): Promise<ShadowingAttemptDto> {
  return send(`/api/practice/attempt/${attemptId}`, { method: "GET" }, "Failed to load the recording");
}

export function fetchRoundShadowingResults(roundId: string): Promise<ShadowingRoundResults> {
  return send(`/api/practice/attempts?roundId=${encodeURIComponent(roundId)}`, { method: "GET" }, "Failed to load saved recordings");
}

export function persistEvaluationRecovery(recoveryToken: string): Promise<{ persisted: true; attemptId: string; seq: number }> {
  return send(
    "/api/practice/evaluate/persist-recovery",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ recoveryToken }) },
    "Couldn't save the score yet"
  );
}
