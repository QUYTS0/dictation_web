import { NextRequest } from "next/server";
import { TranscriptFetchError } from "@/lib/youtubeCaptions/errors";

// ---- Supabase mock: a small chainable/thenable query-builder per call,
// configured per test via `queueResponse(table, response)`. Mirrors the
// hand-rolled chainable-builder convention already used by
// dictation-check-route.test.ts / bookmarks-route.test.ts. ----
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

jest.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => ({ from: (table: string) => fromMock(table) }),
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

beforeEach(() => {
  responseQueues.clear();
  fromMock.mockClear();
  generateEnglishTranscript.mockReset();
  acquireTranscriptLock.mockReset();
  getCooldown.mockReset().mockResolvedValue(null);
  setCooldown.mockClear();
  clearCooldown.mockClear();
  acquireTranscriptLock.mockResolvedValue({ token: "tok", key: "k", release: jest.fn(async () => undefined) });
});

describe("POST /api/transcript/generate — provider orchestration (route level)", () => {
  it("1. reuses a ready cached transcript without calling the orchestrator", async () => {
    queueResponse("transcripts", { data: [{ id: "t1", status: "ready", updated_at: "now", created_at: "now" }], error: null });
    queueResponse("transcript_segments", { data: null, error: null, count: 5 });

    const res = await POST(makeRequest({ videoId: "vid1" }));
    const json = await res.json();

    expect(json).toMatchObject({ transcriptId: "t1", status: "ready" });
    expect(generateEnglishTranscript).not.toHaveBeenCalled();
    expect(acquireTranscriptLock).not.toHaveBeenCalled();
  });

  it("6. returns a failure response (manual fallback available) when both providers fail and no prior transcript exists", async () => {
    queueResponse("transcripts", { data: [], error: null }); // no existing transcripts
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
  });

  it("7. a failed forced regenerate never overwrites an existing ready transcript", async () => {
    queueResponse("transcripts", {
      data: [{ id: "ready-1", status: "ready", updated_at: "now", created_at: "now" }],
      error: null,
    });

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

    // Preservation means no write ever targets the transcripts table with a
    // "failed" status for this request.
    const transcriptsBuilders = fromMock.mock.results
      .map((r, i) => ({ table: fromMock.mock.calls[i][0], builder: r.value }))
      .filter((r) => r.table === "transcripts");
    const anyMarkedFailed = transcriptsBuilders.some((r) =>
      (r.builder.update as jest.Mock).mock.calls.some((call: unknown[]) => (call[0] as { status?: string })?.status === "failed")
    );
    expect(anyMarkedFailed).toBe(false);
  });

  it("returns GENERATION_IN_PROGRESS without calling the orchestrator when the lock is contended", async () => {
    queueResponse("transcripts", { data: [], error: null });
    acquireTranscriptLock.mockResolvedValue(null);

    const res = await POST(makeRequest({ videoId: "vid4" }));
    const json = await res.json();

    expect(res.status).toBe(202);
    expect(json).toMatchObject({ status: "processing", code: "GENERATION_IN_PROGRESS" });
    expect(generateEnglishTranscript).not.toHaveBeenCalled();
  });

  it("returns FETCH_COOLDOWN without acquiring a lock or calling the orchestrator when a cooldown is active", async () => {
    queueResponse("transcripts", { data: [], error: null });
    queueResponse("transcripts", { data: { id: "failed-id" }, error: null });
    getCooldown.mockResolvedValue({ code: "YOUTUBE_BOT_BLOCKED", setAt: Date.now() });

    const res = await POST(makeRequest({ videoId: "vid5" }));
    const json = await res.json();

    expect(json.code).toBe("FETCH_COOLDOWN");
    expect(acquireTranscriptLock).not.toHaveBeenCalled();
    expect(generateEnglishTranscript).not.toHaveBeenCalled();
  });

  it("force=true bypasses cooldown but still requires the lock", async () => {
    queueResponse("transcripts", { data: [], error: null });
    getCooldown.mockResolvedValue({ code: "YOUTUBE_BOT_BLOCKED", setAt: Date.now() });
    acquireTranscriptLock.mockResolvedValue(null);

    const res = await POST(makeRequest({ videoId: "vid6", force: true }));
    const json = await res.json();

    expect(getCooldown).not.toHaveBeenCalled();
    expect(acquireTranscriptLock).toHaveBeenCalled();
    expect(json.code).toBe("GENERATION_IN_PROGRESS");
  });

  it("manual segments bypass the lock, cooldown, and providers entirely", async () => {
    queueResponse("transcripts", { data: [], error: null });
    queueResponse("transcripts", { data: { id: "new-transcript" }, error: null }); // insert
    queueResponse("transcript_segments", { data: null, error: null }); // segments insert
    queueResponse("transcripts", { data: null, error: null }); // final status update

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
  });
});
