import { NextRequest } from "next/server";

// Same chainable-builder convention as transcript-generate-route.test.ts.
type QueryResult = { data?: unknown; error?: unknown };

const responseQueues = new Map<string, QueryResult[]>();
function queueResponse(table: string, result: QueryResult) {
  const queue = responseQueues.get(table) ?? [];
  queue.push(result);
  responseQueues.set(table, queue);
}
function nextResponse(table: string): QueryResult {
  const queue = responseQueues.get(table) ?? [];
  return queue.shift() ?? { data: null, error: null };
}

function makeBuilder(table: string) {
  const result = nextResponse(table);
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  for (const method of ["select", "eq", "order", "limit", "update"]) {
    builder[method] = jest.fn(chain);
  }
  builder.maybeSingle = jest.fn(() => Promise.resolve(result));
  builder.then = (resolve: (v: QueryResult) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return builder;
}

const fromMock = jest.fn((table: string) => makeBuilder(table));

jest.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => ({ from: (table: string) => fromMock(table) }),
}));

jest.mock("@/lib/youtube", () => ({
  fetchYouTubeVideoTitle: jest.fn(async () => null),
}));

import { GET } from "@/app/api/transcript/[videoId]/route";

function makeRequest(videoId: string, query: string) {
  return new NextRequest(`http://localhost/api/transcript/${videoId}?${query}`);
}

function params(videoId: string) {
  return { params: Promise.resolve({ videoId }) };
}

const segmentRow = {
  id: "seg-1",
  transcript_id: "rev-a",
  segment_index: 0,
  start_sec: 0,
  end_sec: 2,
  duration_sec: 2,
  text_raw: "Hello world.",
  text_normalized: "hello world",
};

beforeEach(() => {
  responseQueues.clear();
  fromMock.mockClear();
});

describe("GET /api/transcript/[videoId] — Phase 0 pinned-revision resolution", () => {
  it("10. resolves the current (is_current) revision when no transcriptId is requested", async () => {
    queueResponse("transcripts", { data: { id: "rev-current", status: "ready", source: "cache" }, error: null }); // is_current lookup
    queueResponse("videos", { data: { title: "A Video" }, error: null });
    queueResponse("transcript_segments", { data: [segmentRow], error: null });

    const res = await GET(makeRequest("vid1", "lang=en"), params("vid1"));
    const json = await res.json();

    expect(json.status).toBe("ready");
    expect(json.transcriptId).toBe("rev-current");
  });

  it("10. a pinned transcriptId is served even though it is no longer the current revision", async () => {
    // The pinned lookup (.eq("id", ...)) is the only transcripts call in
    // this branch — its queued row IS the pinned, superseded revision.
    queueResponse("transcripts", {
      data: { id: "rev-A", status: "ready", source: "cache", youtube_video_id: "vid2", language: "en" },
      error: null,
    });
    queueResponse("videos", { data: { title: "A Video" }, error: null });
    queueResponse("transcript_segments", { data: [{ ...segmentRow, transcript_id: "rev-A" }], error: null });

    const res = await GET(makeRequest("vid2", "lang=en&transcriptId=rev-A"), params("vid2"));
    const json = await res.json();

    expect(json.status).toBe("ready");
    expect(json.transcriptId).toBe("rev-A");
    // Never queries for "current" when a pinned id was supplied.
    expect(fromMock.mock.calls.filter((c) => c[0] === "transcripts").length).toBe(1);
  });

  it("11. a transcriptId belonging to a different video is rejected, not silently served", async () => {
    queueResponse("transcripts", {
      data: { id: "rev-A", status: "ready", source: "cache", youtube_video_id: "some-other-video", language: "en" },
      error: null,
    });

    const res = await GET(makeRequest("vid3", "lang=en&transcriptId=rev-A"), params("vid3"));
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.status).toBe("error");
  });

  it("11. a transcriptId belonging to a different language is rejected", async () => {
    queueResponse("transcripts", {
      data: { id: "rev-A", status: "ready", source: "cache", youtube_video_id: "vid4", language: "vi" },
      error: null,
    });

    const res = await GET(makeRequest("vid4", "lang=en&transcriptId=rev-A"), params("vid4"));
    expect(res.status).toBe(404);
  });

  it("12. a nonexistent pinned transcriptId is rejected, never silently substituted with current", async () => {
    queueResponse("transcripts", { data: null, error: null }); // pinned lookup: not found

    const res = await GET(makeRequest("vid5", "lang=en&transcriptId=does-not-exist"), params("vid5"));
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.status).toBe("error");
    // Only one transcripts call was made — the pinned lookup — confirming no
    // fallback "current" query ever ran.
    expect(fromMock.mock.calls.filter((c) => c[0] === "transcripts").length).toBe(1);
  });

  it("reports 'processing' (with the row's own id) when the current-revision lookup finds nothing but a processing row exists", async () => {
    queueResponse("transcripts", { data: null, error: null }); // is_current: none
    queueResponse("transcripts", { data: { id: "proc-1", status: "processing", source: "cache" }, error: null }); // latest-any-status fallback
    queueResponse("videos", { data: null, error: null });

    const res = await GET(makeRequest("vid6", "lang=en"), params("vid6"));
    const json = await res.json();

    expect(json.status).toBe("processing");
    expect(json.transcriptId).toBe("proc-1");
  });

  it("reports 'processing' with a null transcriptId when no transcript row exists at all yet", async () => {
    queueResponse("transcripts", { data: null, error: null }); // is_current: none
    queueResponse("transcripts", { data: null, error: null }); // latest-any-status: none
    queueResponse("videos", { data: null, error: null });

    const res = await GET(makeRequest("vid7", "lang=en"), params("vid7"));
    const json = await res.json();

    expect(json.status).toBe("processing");
    expect(json.transcriptId).toBeNull();
  });
});
