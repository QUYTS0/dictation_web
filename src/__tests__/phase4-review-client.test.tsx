import { StrictMode, createElement, type ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";

// Client side of the Phase 4 review fixes: "evaluation in progress" /
// "already evaluated" are not failures, and the page reads the stored result
// with BOUNDED, CANCELLABLE polling instead of posting Evaluate again.
jest.mock("@/lib/utils/wavEncode", () => ({ blobToWav16kMono: async (b: Blob) => b }));

import { usePracticeEvaluation } from "@/app/dictation/[videoId]/usePracticeEvaluation";
import { waitForStoredEvaluation, type StoredEvaluationWait } from "@/app/dictation/[videoId]/shadowingApi";
import { applyStoredEvaluationWait, useEvaluationWaits } from "@/app/dictation/[videoId]/useEvaluationWaits";

const ATTEMPT = "7b0c3b9e-0000-4000-8000-000000000001";
const OTHER = "7b0c3b9e-0000-4000-8000-000000000002";
const fetchMock = jest.fn();

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}
const dto = (status: string, extra: Record<string, unknown> = {}) => ({ attemptId: ATTEMPT, azure: { status, seq: 1, errorReason: null, ...extra } });

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

describe("usePracticeEvaluation outcome mapping", () => {
  async function evaluateWith(res: Response) {
    fetchMock.mockImplementation(async (url: string) =>
      url === "/api/practice/quota" ? jsonResponse({ engineConfigured: true, limitReached: false }) : res
    );
    const { result } = renderHook(() => usePracticeEvaluation());
    let outcome: Awaited<ReturnType<typeof result.current.evaluate>> | null = null;
    await act(async () => {
      outcome = await result.current.evaluate(0, { audioBlob: new Blob(["x"]), attemptId: ATTEMPT });
    });
    return outcome!;
  }

  it("an in-progress evaluation is a server_result (read it), never a failure", async () => {
    const outcome = await evaluateWith(jsonResponse({ code: "evaluation_in_progress", attemptId: ATTEMPT, seq: 1 }, 409));
    expect(outcome).toMatchObject({ ok: false, status: "server_result", code: "evaluation_in_progress", attemptId: ATTEMPT });
  });

  it("an already-evaluated recording is also a server_result (show the saved score, no new call)", async () => {
    const outcome = await evaluateWith(jsonResponse({ code: "azure_already_evaluated", attemptId: ATTEMPT }, 409));
    expect(outcome).toMatchObject({ status: "server_result", code: "azure_already_evaluated" });
  });

  it("a temporarily failing quota check is a retryable failure, not 'not set up'", async () => {
    const outcome = await evaluateWith(jsonResponse({ code: "quota_unavailable", retryable: true }, 503));
    expect(outcome).toMatchObject({ ok: false, status: "failed", code: "quota_unavailable" });
  });

  it("a conflicting result is surfaced as such (not saved)", async () => {
    const outcome = await evaluateWith(
      jsonResponse({ engine: "azure", attemptId: ATTEMPT, seq: 1, persisted: false, conflict: true, pronScore: 70, words: [] })
    );
    expect(outcome).toMatchObject({ ok: true, data: { persisted: false, conflict: true, superseded: false } });
  });

  it("sends only attemptId + audio", async () => {
    await evaluateWith(jsonResponse({ engine: "azure", attemptId: ATTEMPT, seq: 1, persisted: true, pronScore: 70, words: [] }));
    const call = fetchMock.mock.calls.find((c) => c[0] === "/api/practice/evaluate")!;
    const body = call[1].body as FormData;
    expect([...body.keys()].sort()).toEqual(["attemptId", "audio"]);
  });
});

// ---- Bounded, cancellable polling (fake timers, mocked HTTP; never Azure) ----

const abortError = () => Object.assign(new Error("aborted"), { name: "AbortError" });

/** fetch that only settles when its signal aborts (then rejects like a browser). */
function hangingFetch() {
  fetchMock.mockImplementation(
    (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init.signal;
        if (signal?.aborted) return reject(abortError());
        signal?.addEventListener("abort", () => reject(abortError()), { once: true });
      })
  );
}
const signals = () => fetchMock.mock.calls.map((c) => (c[1] as RequestInit).signal!);
const flush = () =>
  act(async () => {
    await jest.advanceTimersByTimeAsync(0);
  });
const expectOnlyAttemptReads = (attemptId: string) => {
  for (const [url, init] of fetchMock.mock.calls) {
    expect(url).toBe(`/api/practice/attempt/${attemptId}`);
    expect((init as RequestInit).method).toBe("GET");
  }
  expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/evaluate"))).toBe(false);
};

describe("waitForStoredEvaluation", () => {
  // Every polling task in this block runs on a tracked controller, aborted
  // after each test so nothing keeps polling if an assertion fails.
  let controllers: AbortController[] = [];
  const newSignal = () => {
    const c = new AbortController();
    controllers.push(c);
    return c;
  };
  beforeEach(() => {
    controllers = [];
    jest.useFakeTimers();
  });
  afterEach(() => {
    for (const c of controllers) c.abort();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it("reads (GET only) until the stored evaluation is no longer pending, then settles", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(dto("pending")))
      .mockResolvedValueOnce(jsonResponse(dto("pending")))
      .mockResolvedValueOnce(jsonResponse(dto("completed", { pronunciationScore: 80 })));
    const p = waitForStoredEvaluation(ATTEMPT, { signal: newSignal().signal });
    await jest.advanceTimersByTimeAsync(8000); // reads at t = 0, 4, 8 s
    const result = await p;
    expect(result.kind).toBe("settled");
    if (result.kind !== "settled") return;
    expect(result.attempt.azure.status).toBe("completed");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expectOnlyAttemptReads(ATTEMPT);
  });

  it("settles on a stored failed/expired evaluation (terminal, no further reads)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(dto("failed", { errorReason: "expired" })));
    const p = waitForStoredEvaluation(ATTEMPT, { signal: newSignal().signal });
    await jest.advanceTimersByTimeAsync(0);
    const result = await p;
    expect(result.kind).toBe("settled");
    if (result.kind !== "settled") return;
    expect(result.attempt.azure).toMatchObject({ status: "failed", errorReason: "expired" });
    await jest.advanceTimersByTimeAsync(20_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("is bounded: reaching maxWait while pending gives gave_up/deadline", async () => {
    fetchMock.mockResolvedValue(jsonResponse(dto("pending")));
    const p = waitForStoredEvaluation(ATTEMPT, { signal: newSignal().signal, intervalMs: 4000, maxWaitMs: 12_000 });
    await jest.advanceTimersByTimeAsync(20_000);
    await expect(p).resolves.toEqual({ kind: "gave_up", reason: "deadline" });
    expect(fetchMock).toHaveBeenCalledTimes(4); // t = 0, 4, 8, 12 s
    expectOnlyAttemptReads(ATTEMPT);
  });

  it("the default bound (130 s) covers the server timeout, reading only the attempt", async () => {
    fetchMock.mockResolvedValue(jsonResponse(dto("pending")));
    const p = waitForStoredEvaluation(ATTEMPT, { signal: newSignal().signal });
    await jest.advanceTimersByTimeAsync(140_000);
    await expect(p).resolves.toEqual({ kind: "gave_up", reason: "deadline" });
    // Reads every 4 s; the first read at or past 130 s is the last (t = 132 s).
    expect(fetchMock).toHaveBeenCalledTimes(34);
    expectOnlyAttemptReads(ATTEMPT);
  });

  it("three consecutive read failures give gave_up/read_failures", async () => {
    fetchMock.mockRejectedValue(new TypeError("offline"));
    const p = waitForStoredEvaluation(ATTEMPT, { signal: newSignal().signal });
    await jest.advanceTimersByTimeAsync(20_000);
    await expect(p).resolves.toEqual({ kind: "gave_up", reason: "read_failures" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("returns cancelled without any request when the signal is already aborted", async () => {
    const c = newSignal();
    c.abort();
    await expect(waitForStoredEvaluation(ATTEMPT, { signal: c.signal })).resolves.toEqual({ kind: "cancelled" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborting during an in-flight read cancels the fetch and reports cancelled (not a network error)", async () => {
    hangingFetch();
    const c = newSignal();
    const p = waitForStoredEvaluation(ATTEMPT, { signal: c.signal });
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(signals()[0]).toBe(c.signal);
    c.abort();
    await expect(p).resolves.toEqual({ kind: "cancelled" });
    expect(jest.getTimerCount()).toBe(0);
  });

  it("aborting during the delay between reads stops polling and leaves no timer", async () => {
    fetchMock.mockResolvedValue(jsonResponse(dto("pending")));
    const c = newSignal();
    const p = waitForStoredEvaluation(ATTEMPT, { signal: c.signal });
    await jest.advanceTimersByTimeAsync(1000); // inside the 4 s delay
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(1);
    c.abort();
    await expect(p).resolves.toEqual({ kind: "cancelled" });
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("an answer that arrives after the abort is still cancelled", async () => {
    let answer: ((r: Response) => void) | undefined;
    fetchMock.mockImplementation(() => new Promise<Response>((r) => (answer = r)));
    const c = newSignal();
    const p = waitForStoredEvaluation(ATTEMPT, { signal: c.signal });
    await jest.advanceTimersByTimeAsync(0);
    c.abort();
    answer?.(jsonResponse(dto("completed", { pronunciationScore: 80 })));
    await expect(p).resolves.toEqual({ kind: "cancelled" });
  });
});

describe("useEvaluationWaits (per-operation cancellation)", () => {
  // renderHook's automatic cleanup unmounts after each test, which aborts
  // any wait still running.
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });
  const target = (attemptId: string, origin = "u1.v1.t1.r1") => ({ attemptId, clipId: `clip-${attemptId}`, origin });

  it("unmount aborts pending waits, including the in-flight read", async () => {
    hangingFetch();
    const { result, unmount } = renderHook(() => useEvaluationWaits());
    const p = result.current.wait(target(ATTEMPT));
    await flush();
    unmount();
    await expect(p).resolves.toEqual({ kind: "cancelled" });
    expect(signals()[0].aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("a scope change cancels only waits whose results can't be shown in the new scope", async () => {
    hangingFetch();
    const { result } = renderHook(() => useEvaluationWaits());
    const same = result.current.wait(target(ATTEMPT, "u1.v1.t1.r1"));
    const noRoundYet = result.current.wait(target("a-none", "u1.v1.t1.none")); // adopts r1: still valid
    const otherRound = result.current.wait(target("a-r2", "u1.v1.t1.r2"));
    const otherRevision = result.current.wait(target("a-t2", "u1.v1.t2.r1"));
    const otherUser = result.current.wait(target("a-u2", "u2.v1.t1.r1"));
    const otherVideo = result.current.wait(target("a-v2", "u1.v2.t1.r1"));
    await flush();
    act(() => result.current.cancelOutsideScope("u1.v1.t1.r1"));
    for (const p of [otherRound, otherRevision, otherUser, otherVideo]) await expect(p).resolves.toEqual({ kind: "cancelled" });
    expect(signals().map((s) => s.aborted)).toEqual([false, false, true, true, true, true]);
    act(() => result.current.cancelAll());
    await expect(same).resolves.toEqual({ kind: "cancelled" });
    await expect(noRoundYet).resolves.toEqual({ kind: "cancelled" });
  });

  it("removing a recording cancels its wait only; a newer wait for the same attempt replaces the older one; reset cancels all", async () => {
    hangingFetch();
    const { result } = renderHook(() => useEvaluationWaits());
    const a = result.current.wait(target(ATTEMPT));
    const b = result.current.wait(target(OTHER));
    await flush();
    act(() => result.current.cancelWhere((op) => op.clipId === `clip-${OTHER}`));
    await expect(b).resolves.toEqual({ kind: "cancelled" });
    const a2 = result.current.wait(target(ATTEMPT));
    await expect(a).resolves.toEqual({ kind: "cancelled" });
    await flush();
    expect(signals().map((s) => s.aborted)).toEqual([true, true, false]);
    act(() => result.current.cancelAll()); // recordings reset: sign-out / account or video switch
    await expect(a2).resolves.toEqual({ kind: "cancelled" });
  });

  it("Strict Mode: waits started after the cleanup/setup cycle work; the final cleanup cancels them for good", async () => {
    const wrapper = ({ children }: { children: ReactNode }) => createElement(StrictMode, null, children);
    fetchMock
      .mockResolvedValueOnce(jsonResponse(dto("pending")))
      .mockResolvedValueOnce(jsonResponse(dto("completed", { pronunciationScore: 90 })));
    const { result, unmount } = renderHook(() => useEvaluationWaits(), { wrapper });
    const ok = result.current.wait(target(ATTEMPT));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(4000);
    });
    expect((await ok).kind).toBe("settled");

    // A wait whose answer only arrives after cleanup is never revived.
    let answer: ((r: Response) => void) | undefined;
    fetchMock.mockImplementation(() => new Promise<Response>((r) => (answer = r)));
    const old = result.current.wait(target(OTHER));
    await flush();
    unmount();
    answer?.(jsonResponse({ ...dto("completed"), attemptId: OTHER }));
    await expect(old).resolves.toEqual({ kind: "cancelled" });
    await jest.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("applyStoredEvaluationWait", () => {
  const handlers = () => ({ complete: jest.fn(), fail: jest.fn(), updated: jest.fn() });
  const settled = (status: string, extra: Record<string, unknown> = {}, attemptId = ATTEMPT) =>
    ({ kind: "settled", attempt: { ...dto(status, extra), attemptId } }) as unknown as StoredEvaluationWait;

  it("cancelled changes nothing: no status, message or unread flag", () => {
    const h = handlers();
    expect(applyStoredEvaluationWait({ kind: "cancelled" }, ATTEMPT, h)).toBe("ignored");
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.fail).not.toHaveBeenCalled();
    expect(h.updated).not.toHaveBeenCalled();
  });

  it("completed restores the stored score; failed / expired end with a Retry message", () => {
    let h = handlers();
    expect(applyStoredEvaluationWait(settled("completed", { pronunciationScore: 80 }), ATTEMPT, h)).toBe("completed");
    expect(h.complete).toHaveBeenCalledTimes(1);
    expect(h.updated).toHaveBeenCalledTimes(1);
    h = handlers();
    expect(applyStoredEvaluationWait(settled("failed", { errorReason: "expired" }), ATTEMPT, h)).toBe("failed");
    expect(h.fail).toHaveBeenCalledWith(expect.stringContaining("Press Retry"));
    h = handlers();
    applyStoredEvaluationWait(settled("failed", { errorReason: null }), ATTEMPT, h);
    expect(h.fail).toHaveBeenCalledWith("The evaluation failed. Press Retry to try again.");
  });

  it("gave_up reports the pending state accurately; an answer for another attempt is ignored", () => {
    let h = handlers();
    expect(applyStoredEvaluationWait({ kind: "gave_up", reason: "deadline" }, ATTEMPT, h)).toBe("gave_up");
    expect(h.fail).toHaveBeenCalledWith("This recording is still being evaluated. Check back in a moment.");
    h = handlers();
    applyStoredEvaluationWait({ kind: "gave_up", reason: "read_failures" }, ATTEMPT, h);
    expect(h.fail).toHaveBeenCalledWith("Couldn't check this recording's evaluation. Check back in a moment.");
    h = handlers();
    expect(applyStoredEvaluationWait(settled("completed", {}, OTHER), ATTEMPT, h)).toBe("ignored");
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.updated).not.toHaveBeenCalled();
  });
});
