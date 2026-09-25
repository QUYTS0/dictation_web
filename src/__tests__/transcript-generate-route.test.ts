import { NextRequest } from "next/server";
import { TranscriptFetchError } from "@/lib/youtubeCaptions/errors";

// ---- Supabase mock: a small chainable/thenable query-builder per call,
// configured per test via `queueResponse(table, response)`. Mirrors the
// hand-rolled chainable-builder convention already used by
// dictation-check-route.test.ts / bookmarks-route.test.ts. `.maybeSingle()`
// responses queue a plain object (or null), not an array — matching Phase
// 0's is_current-based single-row resolution (§8.14 conventions). ----
type QueryResult = { data?: unknown; error?: unknown; count?: number };

const responseQueues = new Map<string, QueryResult[]>();
function queueResponse(table: string, result: QueryResult) {
  const queue = responseQueues.get(table) ?? [];
  queue.push(result);
  responseQueues.set(table, queue);
}
function nextResponse(table: string): QueryResult {
  const queue = responseQueues.get(table) ?? [];
  return queue.shift() ?? { data: null, error: null, count: 0 };
}

function makeBuilder(table: string) {
  const result = nextResponse(table);
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  for (const method of ["select", "eq", "order", "limit", "in"]) {
    builder[method] = jest.fn(chain);
  }
  builder.insert = jest.fn(chain);
  builder.update = jest.fn(chain);
  builder.delete = jest.fn(chain);
  builder.upsert = jest.fn(() => Promise.resolve(result));
  builder.maybeSingle = jest.fn(() => Promise.resolve(result));
  builder.single = jest.fn(() => Promise.resolve(result));
  builder.then = (resolve: (v: QueryResult) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return builder;
}

const fromMock = jest.fn((table: string) => makeBuilder(table));

let rpcQueue: QueryResult[] = [];
// Typed with both params (asserted on via .mock.calls below) even though
// the body itself only needs to return the next queued response — without
// this, TS infers a zero-arg call-args tuple and every .mock.calls[n][1]
// access below fails to typecheck.
const rpcMock = jest.fn((fn: string, params: Record<string, unknown>) => {
  void fn;
  void params;
  const result = rpcQueue.shift() ?? { data: null, error: { message: "no rpc response queued" } };
  return Promise.resolve(result);
});

jest.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => ({ from: (table: string) => fromMock(table), rpc: (fn: string, params: Record<string, unknown>) => rpcMock(fn, params) }),
}));

jest.mock("@/lib/rateLimit", () => ({
  checkRateLimit: jest.fn(async () => null),
}));

const generateEnglishTranscript = jest.fn();
jest.mock("@/lib/youtubeCaptions/orchestrator", () => ({
  generateEnglishTranscript: (...args: unknown[]) => generateEnglishTranscript(...args),
  toCueItems: jest.requireActual("@/lib/youtubeCaptions/orchestrator").toCueItems,
}));

const acquireTranscriptLock = jest.fn();
jest.mock("@/lib/youtubeCaptions/lock", () => ({
  acquireTranscriptLock: (...args: unknown[]) => acquireTranscriptLock(...args),
}));

const getCooldown = jest.fn();
const setCooldown = jest.fn<Promise<undefined>, unknown[]>(async () => undefined);
const clearCooldown = jest.fn<Promise<undefined>, unknown[]>(async () => undefined);
jest.mock("@/lib/youtubeCaptions/cooldown", () => {
  const actual = jest.requireActual("@/lib/youtubeCaptions/cooldown");
  return {
    getCooldown: (...args: unknown[]) => getCooldown(...args),
    setCooldown: (...args: unknown[]) => setCooldown(...args),
    clearCooldown: (...args: unknown[]) => clearCooldown(...args),
    resolveCooldownStatus: actual.resolveCooldownStatus,
  };
});

import { POST } from "@/app/api/transcript/generate/route";

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/transcript/generate", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

/** A minimal, already-sentence-shaped successful provider outcome — two
 *  complete cues that mergeIntoSentences/validateMergedSegments accept
 *  as-is (real, unmocked implementations). */
function successfulOutcome(overrides?: { provider?: string }) {
  return {
    ok: true as const,
    attemptCount: 1,
    fallbackUsed: false,
    result: {
      provider: overrides?.provider ?? "youtube-transcript",
      languageCode: "en",
      cues: [
        { text: "Hello world.", startSeconds: 0, durationSeconds: 2 },
        { text: "How are you today?", startSeconds: 2, durationSeconds: 2 },
      ],
      diagnostics: { attemptCount: 1, durationMs: 10 },
    },
  };
}

beforeEach(() => {
  responseQueues.clear();
  fromMock.mockClear();
  rpcQueue = [];
  rpcMock.mockClear();
  generateEnglishTranscript.mockReset();
  acquireTranscriptLock.mockReset();
  getCooldown.mockReset().mockResolvedValue(null);
  setCooldown.mockClear();
  clearCooldown.mockClear();
  acquireTranscriptLock.mockResolvedValue({ token: "tok", key: "k", release: jest.fn(async () => undefined) });
});

describe("POST /api/transcript/generate — provider orchestration (route level)", () => {
  it("1. reuses the video's current ready transcript without calling the orchestrator", async () => {
    queueResponse("transcripts", { data: { id: "t1", status: "ready" }, error: null }); // currentReady
    queueResponse("transcript_segments", { data: null, error: null, count: 5 });

    const res = await POST(makeRequest({ videoId: "vid1" }));
    const json = await res.json();

    expect(json).toMatchObject({ transcriptId: "t1", status: "ready" });
    expect(generateEnglishTranscript).not.toHaveBeenCalled();
    expect(acquireTranscriptLock).not.toHaveBeenCalled();
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("6. returns a failure response (manual fallback available) when both providers fail and no prior transcript exists", async () => {
    queueResponse("transcripts", { data: null, error: null }); // currentReady: none
    queueResponse("transcripts", { data: null, error: null }); // mostRecentAnyStatus: none
    queueResponse("transcripts", { data: { id: "failed-id" }, error: null }); // insert failed row

    generateEnglishTranscript.mockResolvedValue({
      ok: false,
      error: new TranscriptFetchError("CAPTIONS_DISABLED", "confirmed disabled"),
      attemptCount: 2,
      fallbackUsed: true,
    });

    const res = await POST(makeRequest({ videoId: "vid2" }));
    const json = await res.json();

    expect(res.status).toBe(422);
    expect(json.status).toBe("failed");
    expect(json.code).toBe("CAPTIONS_DISABLED");
    expect(json.transcriptId).toBe("failed-id");
    expect(setCooldown).toHaveBeenCalledWith("vid2", "en", "CAPTIONS_DISABLED", undefined);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("7. a failed forced regenerate never overwrites an existing current transcript", async () => {
    queueResponse("transcripts", { data: { id: "ready-1", status: "ready" }, error: null }); // currentReady

    generateEnglishTranscript.mockResolvedValue({
      ok: false,
      error: new TranscriptFetchError("YOUTUBE_BOT_BLOCKED", "blocked"),
      attemptCount: 1,
      fallbackUsed: false,
    });

    const res = await POST(makeRequest({ videoId: "vid3", force: true }));
    const json = await res.json();

    expect(json.status).toBe("ready");
    expect(json.code).toBe("YOUTUBE_BOT_BLOCKED");
    expect(rpcMock).not.toHaveBeenCalled();

    // Preservation means no write ever targets the transcripts table with a
    // "failed" status for this request, and publication is never invoked.
    const transcriptsBuilders = fromMock.mock.results
      .map((r, i) => ({ table: fromMock.mock.calls[i][0], builder: r.value }))
      .filter((r) => r.table === "transcripts");
    const anyMarkedFailed = transcriptsBuilders.some((r) =>
      (r.builder.update as jest.Mock).mock.calls.some((call: unknown[]) => (call[0] as { status?: string })?.status === "failed")
    );
    expect(anyMarkedFailed).toBe(false);
  });

  it("returns GENERATION_IN_PROGRESS without calling the orchestrator when the lock is contended", async () => {
    queueResponse("transcripts", { data: null, error: null }); // currentReady
    queueResponse("transcripts", { data: null, error: null }); // mostRecentAnyStatus
    acquireTranscriptLock.mockResolvedValue(null);

    const res = await POST(makeRequest({ videoId: "vid4" }));
    const json = await res.json();

    expect(res.status).toBe(202);
    expect(json).toMatchObject({ status: "processing", code: "GENERATION_IN_PROGRESS" });
    expect(generateEnglishTranscript).not.toHaveBeenCalled();
  });

  it("returns FETCH_COOLDOWN without acquiring a lock or calling the orchestrator when a cooldown is active", async () => {
    queueResponse("transcripts", { data: null, error: null }); // currentReady
    queueResponse("transcripts", { data: null, error: null }); // mostRecentAnyStatus
    queueResponse("transcripts", { data: { id: "failed-id" }, error: null }); // insert failed row
    getCooldown.mockResolvedValue({ code: "YOUTUBE_BOT_BLOCKED", setAt: Date.now() });

    const res = await POST(makeRequest({ videoId: "vid5" }));
    const json = await res.json();

    expect(json.code).toBe("FETCH_COOLDOWN");
    expect(acquireTranscriptLock).not.toHaveBeenCalled();
    expect(generateEnglishTranscript).not.toHaveBeenCalled();
  });

  it("force=true bypasses cooldown but still requires the lock", async () => {
    queueResponse("transcripts", { data: null, error: null }); // currentReady
    queueResponse("transcripts", { data: null, error: null }); // mostRecentAnyStatus
    getCooldown.mockResolvedValue({ code: "YOUTUBE_BOT_BLOCKED", setAt: Date.now() });
    acquireTranscriptLock.mockResolvedValue(null);

    const res = await POST(makeRequest({ videoId: "vid6", force: true }));
    const json = await res.json();

    expect(getCooldown).not.toHaveBeenCalled();
    expect(acquireTranscriptLock).toHaveBeenCalled();
    expect(json.code).toBe("GENERATION_IN_PROGRESS");
  });

  it("15. manual segments bypass the lock, cooldown, and providers entirely, and publish through the same atomic function", async () => {
    queueResponse("transcripts", { data: null, error: null }); // currentReady
    queueResponse("transcripts", { data: null, error: null }); // mostRecentAnyStatus
    rpcQueue.push({
      data: { id: "new-transcript", version: 1, is_current: true, status: "ready" },
      error: null,
    });

    const res = await POST(
      makeRequest({
        videoId: "vid7",
        force: true,
        segments: [{ segmentIndex: 0, start: 0, end: 2, text: "Hello world." }],
      })
    );
    const json = await res.json();

    expect(getCooldown).not.toHaveBeenCalled();
    expect(acquireTranscriptLock).not.toHaveBeenCalled();
    expect(generateEnglishTranscript).not.toHaveBeenCalled();
    expect(json.status).toBe("ready");
    expect(json.transcriptId).toBe("new-transcript");

    expect(rpcMock).toHaveBeenCalledTimes(1);
    const [fnName, params] = rpcMock.mock.calls[0];
    expect(fnName).toBe("fn_publish_transcript_revision");
    expect(params).toMatchObject({
      p_youtube_video_id: "vid7",
      p_language: "en",
      p_source: "manual",
    });
    expect(Array.isArray(params.p_segments)).toBe(true);
    expect((params.p_segments as unknown[])[0]).toMatchObject({
      segmentIndex: 0,
      start: 0,
      end: 2,
      text: "Hello world.",
    });
    expect(typeof params.p_content_fingerprint).toBe("string");
  });

  it("3. an automatic (provider) success also publishes through fn_publish_transcript_revision — no in-place write path remains", async () => {
    queueResponse("transcripts", { data: null, error: null }); // currentReady
    queueResponse("transcripts", { data: null, error: null }); // mostRecentAnyStatus
    generateEnglishTranscript.mockResolvedValue(successfulOutcome());
    rpcQueue.push({ data: { id: "auto-transcript", version: 1 }, error: null });

    const res = await POST(makeRequest({ videoId: "vid8" }));
    const json = await res.json();

    expect(json).toMatchObject({ status: "ready", transcriptId: "auto-transcript" });
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(clearCooldown).toHaveBeenCalledWith("vid8", "en");

    // The old in-place write path is gone entirely: no update()/delete()
    // ever targets transcripts/transcript_segments/transcript_translations/
    // transcript_vocab_highlights in a successful publish.
    const mutatedTables = fromMock.mock.calls.map((c) => c[0]);
    expect(mutatedTables).not.toContain("transcript_translations");
    expect(mutatedTables).not.toContain("transcript_vocab_highlights");
  });

  it("4/5. identical content across two publish calls sends the same fingerprint; different content sends a different one", async () => {
    queueResponse("transcripts", { data: null, error: null });
    queueResponse("transcripts", { data: null, error: null });
    rpcQueue.push({ data: { id: "rev-a" }, error: null });
    await POST(
      makeRequest({ videoId: "vid9", force: true, segments: [{ segmentIndex: 0, start: 0, end: 2, text: "Hello world." }] })
    );

    queueResponse("transcripts", { data: null, error: null });
    queueResponse("transcripts", { data: null, error: null });
    rpcQueue.push({ data: { id: "rev-a" }, error: null });
    await POST(
      makeRequest({ videoId: "vid9", force: true, segments: [{ segmentIndex: 0, start: 0, end: 2, text: "Hello world." }] })
    );

    queueResponse("transcripts", { data: null, error: null });
    queueResponse("transcripts", { data: null, error: null });
    rpcQueue.push({ data: { id: "rev-b" }, error: null });
    await POST(
      makeRequest({ videoId: "vid9", force: true, segments: [{ segmentIndex: 0, start: 0, end: 2, text: "Something else entirely." }] })
    );

    const fingerprints = rpcMock.mock.calls.map((c) => (c[1] as { p_content_fingerprint: string }).p_content_fingerprint);
    expect(fingerprints[0]).toBe(fingerprints[1]);
    expect(fingerprints[0]).not.toBe(fingerprints[2]);
  });

  it("8. a publication (RPC) failure returns 500 and never marks the previous current revision failed", async () => {
    queueResponse("transcripts", { data: { id: "still-current", status: "ready" }, error: null }); // currentReady
    rpcQueue.push({ data: null, error: { message: "constraint violation" } });

    const res = await POST(
      makeRequest({ videoId: "vid10", force: true, segments: [{ segmentIndex: 0, start: 0, end: 2, text: "Hello world." }] })
    );

    expect(res.status).toBe(500);
    const transcriptsBuilders = fromMock.mock.results
      .map((r, i) => ({ table: fromMock.mock.calls[i][0], builder: r.value }))
      .filter((r) => r.table === "transcripts");
    const anyWrite = transcriptsBuilders.some(
      (r) =>
        (r.builder.update as jest.Mock).mock.calls.length > 0 || (r.builder.insert as jest.Mock).mock.calls.length > 0
    );
    expect(anyWrite).toBe(false);
  });
});
