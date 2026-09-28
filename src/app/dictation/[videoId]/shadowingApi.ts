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

/** An intentional cancellation (AbortController), never a network error. */
export function isAbortError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "AbortError";
}

function abortError(): Error {
  const err = new Error("The operation was aborted.");
  err.name = "AbortError";
  return err;
}

async function send<T>(input: string, init: RequestInit, fallback: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(input, init);
  } catch (err) {
    // A cancelled request stays a cancellation for the caller.
    if (init.signal?.aborted || isAbortError(err)) throw abortError();
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

export function fetchShadowingAttempt(attemptId: string, signal?: AbortSignal): Promise<ShadowingAttemptDto> {
  return send(`/api/practice/attempt/${attemptId}`, { method: "GET", signal }, "Failed to load the recording");
}

export type StoredEvaluationWait =
  /** The stored evaluation is no longer pending (completed / failed / expired). */
  | { kind: "settled"; attempt: ShadowingAttemptDto }
  /** Deadline reached while still pending, or the reads kept failing. */
  | { kind: "gave_up"; reason: "deadline" | "read_failures" }
  /** The caller aborted the wait — nothing should be updated. */
  | { kind: "cancelled" };

/** Resolves true after `ms`, or false as soon as `signal` aborts. The timer
 *  and the abort listener are always removed; it never rejects. */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Bounded wait for a recording's stored Azure outcome — used when Evaluate
 * reported the recording is already being evaluated (or was already
 * evaluated). Reads only (GET); never posts Evaluate again. `signal` aborts
 * the in-flight read and the delay between reads; the result is then
 * `cancelled`, never a failure.
 */
export async function waitForStoredEvaluation(
  attemptId: string,
  opts: { signal?: AbortSignal; intervalMs?: number; maxWaitMs?: number } = {}
): Promise<StoredEvaluationWait> {
  const { signal } = opts;
  const interval = opts.intervalMs ?? 4000;
  const maxWait = opts.maxWaitMs ?? 130_000; // server timeout (120 s) + margin
  let waited = 0;
  let failures = 0;
  for (;;) {
    if (signal?.aborted) return { kind: "cancelled" };
    try {
      const dto = await fetchShadowingAttempt(attemptId, signal);
      if (signal?.aborted) return { kind: "cancelled" };
      failures = 0;
      if (dto.azure.status !== "pending") return { kind: "settled", attempt: dto };
    } catch (err) {
      if (signal?.aborted || isAbortError(err)) return { kind: "cancelled" };
      if (++failures >= 3) return { kind: "gave_up", reason: "read_failures" };
    }
    if (waited >= maxWait) return { kind: "gave_up", reason: "deadline" };
    if (!(await abortableDelay(interval, signal))) return { kind: "cancelled" };
    waited += interval;
  }
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
