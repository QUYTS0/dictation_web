import { NextRequest } from "next/server";

type QueryResult = { data?: unknown; error?: unknown; count?: number | null };

// Table-aware Supabase mock: each table answers with its own queued result,
// and every filter is recorded so revision scoping can be asserted.
const tables: Record<string, QueryResult> = {};
const filters: Array<[string, string, unknown]> = [];
const rpcMock = jest.fn(async (...args: [string, unknown?]): Promise<QueryResult> => (void args, { data: null, error: null }));

function makeBuilder(table: string) {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  for (const method of ["select", "order", "limit"]) builder[method] = jest.fn(chain);
  for (const method of ["eq", "is"]) {
    builder[method] = jest.fn((col: string, val: unknown) => {
      filters.push([table, `${method}:${col}`, val]);
      return builder;
    });
  }
  const result = () => tables[table] ?? { data: null, error: null };
  builder.maybeSingle = jest.fn(() => Promise.resolve(result()));
  builder.then = (res: (v: unknown) => unknown) => Promise.resolve(result()).then(res);
  return builder;
}

const getUserMock = jest.fn(async () => ({ data: { user: { id: "user-1" } } }));

jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: getUserMock },
    from: (table: string) => makeBuilder(table),
    rpc: (fn: string, args: unknown) => rpcMock(fn, args),
  }),
}));

import { GET } from "@/app/api/session/resume/route";

function makeRequest(videoId: string) {
  return new NextRequest(`http://localhost/api/session/resume?videoId=${encodeURIComponent(videoId)}`);
}

const ROUND_ROW = {
  id: "sess-1",
  current_segment_index: 4,
  video_current_time: 12.5,
  accuracy: 80,
  total_attempts: 5,
  updated_at: "2024-01-01T00:00:00Z",
  status: "active",
  transcript_id: "rev-A",
};

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  filters.length = 0;
  rpcMock.mockClear();
  rpcMock.mockResolvedValue({ data: null, error: null });
  getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("GET /api/session/resume — Phase 0 pinned-revision exposure", () => {
  it("13. returns the session's pinned transcript_id", async () => {
    tables.learning_sessions = { data: ROUND_ROW, error: null };
    const json = await (await GET(makeRequest("vid1"))).json();
    expect(json.session).toMatchObject({ sessionId: "sess-1", transcriptId: "rev-A" });
  });

  it("returns transcriptId: null for a legacy session row with no pinned revision, rather than omitting the field", async () => {
    tables.learning_sessions = { data: { ...ROUND_ROW, id: "sess-2", transcript_id: null }, error: null };
    const json = await (await GET(makeRequest("vid2"))).json();
    expect(json.session.transcriptId).toBeNull();
  });

  it("returns session: null when no session exists", async () => {
    const json = await (await GET(makeRequest("vid3"))).json();
    expect(json.session).toBeNull();
  });
});

describe("GET /api/session/resume — Phase 6 (Listening, last mode, progress)", () => {
  it("Listening is resolved WITHOUT a round, against the current revision; the last explicit mode is returned", async () => {
    tables.transcripts = { data: { id: "rev-B" }, error: null };
    tables.listening_progress = { data: { coverage_ratio: "0.4", listened_through: false, last_position_sec: "42.5" }, error: null, count: 2 };
    rpcMock.mockImplementation(async (fn: string) => ({ data: fn === "fn_video_last_mode" ? "listening" : null, error: null }));
    const json = await (await GET(makeRequest("vidL"))).json();
    expect(rpcMock).toHaveBeenCalledWith("fn_video_last_mode", { p_youtube_video_id: "vidL" });
    expect(json.session).toBeNull(); // no round at all
    expect(json.lastMode).toBe("listening");
    expect(json.listening).toEqual({ transcriptId: "rev-B", coverageRatio: 0.4, listenedThrough: false, lastPositionSec: 42.5, hasHistory: true });
    expect(filters).toContainEqual(["listening_progress", "eq:transcript_id", "rev-B"]);
  });

  it("with no ready revision it reads the pre-transcript row — and never offers another revision's checkpoint", async () => {
    tables.listening_progress = { data: null, error: null, count: 1 }; // history exists under some revision
    const json = await (await GET(makeRequest("vidX"))).json();
    expect(json.listening).toEqual({ transcriptId: null, coverageRatio: null, listenedThrough: false, lastPositionSec: null, hasHistory: true });
    expect(filters).toContainEqual(["listening_progress", "is:transcript_id", null]);
    expect(json.lastMode).toBeNull();
  });

  it("returns the round's server-side progress (the caller's own round, via fn_my_round_progress)", async () => {
    tables.learning_sessions = { data: ROUND_ROW, error: null };
    const progress = {
      requiredSentenceCount: 10,
      coveredSentences: { dictation: 3, shadowing: 2, overall: 4 },
      coverage: { dictation: 0.3, shadowing: 0.2, overall: 0.4 },
      attemptCount: 5,
      sentenceAccuracy: { correct: 2, practiced: 3, percent: 67 },
    };
    rpcMock.mockResolvedValue({ data: progress, error: null });
    const json = await (await GET(makeRequest("vid1"))).json();
    expect(rpcMock).toHaveBeenCalledWith("fn_my_round_progress", { p_round_id: "sess-1" });
    expect(json.session.progress).toEqual(progress);
  });

  it("a progress/listening read failure degrades to null — the resume still answers", async () => {
    tables.learning_sessions = { data: ROUND_ROW, error: null };
    rpcMock.mockResolvedValue({ data: null, error: { message: "boom" } });
    const res = await GET(makeRequest("vid1"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.session).toMatchObject({ sessionId: "sess-1", progress: null });
    expect(json.lastMode).toBeNull();
  });
});
