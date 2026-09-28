import { act, renderHook } from "@testing-library/react";

// Client side of the Phase 4 review fixes: "evaluation in progress" /
// "already evaluated" are not failures, and the page reads the stored result
// with BOUNDED polling instead of posting Evaluate again.
jest.mock("@/lib/utils/wavEncode", () => ({ blobToWav16kMono: async (b: Blob) => b }));

import { usePracticeEvaluation } from "@/app/dictation/[videoId]/usePracticeEvaluation";
import { waitForStoredEvaluation } from "@/app/dictation/[videoId]/shadowingApi";

const ATTEMPT = "7b0c3b9e-0000-4000-8000-000000000001";
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

describe("waitForStoredEvaluation", () => {
  const noSleep = async () => {};

  it("reads (GET) until the stored evaluation is no longer pending — never POSTs Evaluate", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(dto("pending")))
      .mockResolvedValueOnce(jsonResponse(dto("pending")))
      .mockResolvedValueOnce(jsonResponse(dto("completed", { pronunciationScore: 80 })));
    const result = await waitForStoredEvaluation(ATTEMPT, { sleep: noSleep });
    expect(result?.azure.status).toBe("completed");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe(`/api/practice/attempt/${ATTEMPT}`);
      expect(init.method).toBe("GET");
    }
  });

  it("is bounded: gives up after maxWait with null", async () => {
    fetchMock.mockResolvedValue(jsonResponse(dto("pending")));
    const result = await waitForStoredEvaluation(ATTEMPT, { sleep: noSleep, intervalMs: 4000, maxWaitMs: 12_000 });
    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(4); // t = 0, 4, 8, 12 s
  });

  it("stops when cancelled (e.g. sign-out) and after repeated read failures", async () => {
    fetchMock.mockResolvedValue(jsonResponse(dto("pending")));
    let calls = 0;
    const cancelled = await waitForStoredEvaluation(ATTEMPT, { sleep: noSleep, isCancelled: () => ++calls > 2 });
    expect(cancelled).toBeNull();
    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new TypeError("offline"));
    expect(await waitForStoredEvaluation(ATTEMPT, { sleep: noSleep })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
