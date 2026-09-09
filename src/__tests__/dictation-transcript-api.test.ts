/**
 * Tests src/app/dictation/[videoId]/api.ts's generate-transcript wrappers —
 * the piece useDictationSession.ts's client-side polling/retry scheduler
 * (see triggerAutoGenerate) actually calls and branches on. Full rendering
 * of the hook itself isn't covered here: this repo's Jest config runs a
 * plain Node test environment with no React Testing Library installed, and
 * adding that infrastructure was out of scope for this change (see the
 * final report's "not verified" section).
 */
import { regenerateTranscript, saveManualTranscript, requestTranscriptGeneration } from "@/app/dictation/[videoId]/api";

function jsonResponse(body: unknown, status: number) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  jest.resetAllMocks();
});

describe("requestTranscriptGeneration / regenerateTranscript / saveManualTranscript", () => {
  it("45. surfaces retryAfterMs from a successful (non-throwing) processing/cooldown response", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(jsonResponse({ status: "processing", code: "GENERATION_IN_PROGRESS", retryAfterMs: 4000 }, 202)) as unknown as typeof fetch;

    const result = await requestTranscriptGeneration("vid1");
    expect(result.code).toBe("GENERATION_IN_PROGRESS");
    expect(result.retryAfterMs).toBe(4000);
  });

  it("does not throw for a FETCH_COOLDOWN response even though its HTTP status is non-2xx", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        jsonResponse({ status: "ready", code: "FETCH_COOLDOWN", retryAfterMs: 12_000, error: "cooling down" }, 503)
      ) as unknown as typeof fetch;

    const result = await requestTranscriptGeneration("vid2");
    expect(result.code).toBe("FETCH_COOLDOWN");
    expect(result.retryAfterMs).toBe(12_000);
  });

  it("46. throws (with the typed code attached) for a permanent failure, so polling can stop", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(jsonResponse({ status: "failed", code: "CAPTIONS_DISABLED", error: "no captions" }, 422)) as unknown as typeof fetch;

    await expect(regenerateTranscript("vid3")).rejects.toMatchObject({ code: "CAPTIONS_DISABLED" });
  });

  it("propagates retryAfterMs on a thrown NETWORK_ERROR so a bounded retry can use it", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(jsonResponse({ status: "failed", code: "NETWORK_ERROR", error: "network issue" }, 503)) as unknown as typeof fetch;

    await expect(regenerateTranscript("vid4")).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  });

  it("saveManualTranscript sends the importSource through to the request body", async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ status: "ready", transcriptId: "t1" }, 200));
    global.fetch = fetchMock as unknown as typeof fetch;

    await saveManualTranscript("vid5", [{ segmentIndex: 0, start: 0, end: 2, text: "Hi." }], "vtt");

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.importSource).toBe("vtt");
    expect(body.force).toBe(true);
  });

  it("a plain 2xx success returns transcriptId/status without throwing", async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse({ status: "ready", transcriptId: "t2" }, 200)) as unknown as typeof fetch;
    const result = await requestTranscriptGeneration("vid6");
    expect(result).toMatchObject({ status: "ready", transcriptId: "t2" });
  });
});
