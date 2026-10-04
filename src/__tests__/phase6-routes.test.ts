/**
 * Phase 6 route contracts (Supabase mocked): Library list/remove, last mode,
 * History sessions, the round report route, and the membership writes added
 * to Add Video and first-round creation. Ownership, aggregation and
 * provenance are the database's job — verified on real PostgreSQL in
 * integration/phase6-library.integration.test.ts.
 */
import { NextRequest } from "next/server";

const rpc = jest.fn();
const getUser = jest.fn();
const tables: Record<string, { data: unknown; error?: unknown; count?: number }> = {};

function builder(table: string) {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "is", "order", "limit"]) b[m] = () => b;
  const result = () => ({ error: null, ...(tables[table] ?? { data: null }) });
  b.maybeSingle = async () => result();
  b.then = (res: (v: unknown) => unknown) => Promise.resolve(result()).then(res);
  return b;
}

jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser }, rpc: (fn: string, args: unknown) => rpc(fn, args), from: (t: string) => builder(t) }),
  createServiceClient: () => ({ from: () => ({ upsert: async () => ({ error: null }) }) }),
}));
jest.mock("@/lib/rateLimit", () => ({ checkRateLimit: async () => null }));
jest.mock("@/lib/youtube", () => ({ fetchYouTubeVideoTitle: async () => "A title" }));

import { GET as libraryGET } from "@/app/api/videos/library/route";
import { DELETE as libraryDELETE } from "@/app/api/videos/library/[videoId]/route";
import { POST as modePOST } from "@/app/api/videos/[videoId]/mode/route";
import { GET as historyGET } from "@/app/api/history/sessions/route";
import { GET as reportGET } from "@/app/api/session/[sessionId]/report/route";
import { POST as resolvePOST } from "@/app/api/video/resolve/route";
import { POST as savePOST } from "@/app/api/session/save-progress/route";

const req = (url: string, init?: { method?: string; body?: unknown }) =>
  new NextRequest(`http://localhost${url}`, {
    method: init?.method ?? "GET",
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body), headers: { "Content-Type": "application/json" } } : {}),
  });
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });
const ROUND = "7b0c3b9e-0000-4000-8000-0000000000d1";

beforeEach(() => {
  rpc.mockReset();
  rpc.mockResolvedValue({ data: {}, error: null });
  for (const k of Object.keys(tables)) delete tables[k];
  getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("GET /api/videos/library", () => {
  it("passes deterministic pagination + filter to fn_video_library as the caller", async () => {
    rpc.mockResolvedValue({ data: { items: [], total: 0, limit: 12, offset: 24, filter: "completed", hasMore: false }, error: null });
    const res = await libraryGET(req("/api/videos/library?filter=completed&limit=12&offset=24"));
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("fn_video_library", { p_limit: 12, p_offset: 24, p_filter: "completed" });
  });

  it("refuses bad input and anonymous callers before any database call", async () => {
    for (const q of ["filter=everything", "limit=0", "limit=51", "offset=-1", "limit=abc"]) {
      expect((await libraryGET(req(`/api/videos/library?${q}`))).status).toBe(400);
    }
    getUser.mockResolvedValue({ data: { user: null } });
    expect((await libraryGET(req("/api/videos/library"))).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/videos/library/[videoId]", () => {
  it("removes only the caller's membership (fn_library_remove_video) and is idempotent", async () => {
    rpc.mockResolvedValue({ data: { videoId: "vid", removed: false }, error: null });
    const res = await libraryDELETE(req("/api/videos/library/vid", { method: "DELETE" }), params({ videoId: "vid" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ videoId: "vid", removed: false });
    expect(rpc).toHaveBeenCalledWith("fn_library_remove_video", { p_youtube_video_id: "vid" });
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(["fn_library_remove_video"]); // nothing else is deleted
  });

  it("401 anonymous; 400 for an invalid id", async () => {
    expect((await libraryDELETE(req("/api/videos/library/x", { method: "DELETE" }), params({ videoId: "x".repeat(65) }))).status).toBe(400);
    getUser.mockResolvedValue({ data: { user: null } });
    expect((await libraryDELETE(req("/api/videos/library/vid", { method: "DELETE" }), params({ videoId: "vid" }))).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("POST /api/videos/[videoId]/mode", () => {
  it("records the explicit mode only — no round, no activity", async () => {
    rpc.mockResolvedValue({ data: { videoId: "vid", lastMode: "shadowing" }, error: null });
    const res = await modePOST(req("/api/videos/vid/mode", { method: "POST", body: { mode: "shadowing" } }), params({ videoId: "vid" }));
    expect(res.status).toBe(200);
    expect(rpc.mock.calls).toEqual([["fn_set_video_last_mode", { p_youtube_video_id: "vid", p_mode: "shadowing" }]]);
  });

  it("rejects unknown modes", async () => {
    const res = await modePOST(req("/api/videos/vid/mode", { method: "POST", body: { mode: "karaoke" } }), params({ videoId: "vid" }));
    expect(res.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("GET /api/history/sessions", () => {
  it("keyset cursor + video filter are passed through; a half cursor is refused", async () => {
    rpc.mockResolvedValue({ data: { items: [], hasMore: false, unattributed: null }, error: null });
    const at = "2026-09-30T08:00:00.123456+00:00";
    const res = await historyGET(req(`/api/history/sessions?limit=5&beforeStartedAt=${encodeURIComponent(at)}&beforeId=${ROUND}&videoId=vid`));
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("fn_history_sessions", { p_limit: 5, p_before_started_at: at, p_before_id: ROUND, p_video: "vid" });
    expect((await historyGET(req(`/api/history/sessions?beforeId=${ROUND}`))).status).toBe(400);
    expect((await historyGET(req(`/api/history/sessions?beforeStartedAt=${encodeURIComponent(at)}&beforeId=nope`))).status).toBe(400);
  });

  it("a missing 040 function is a 503 with a stable code", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "missing" } });
    const res = await historyGET(req("/api/history/sessions"));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "learning_data_unavailable" });
  });
});

describe("GET /api/session/[sessionId]/report", () => {
  it("another user's round is not found (the session row is owner-scoped, fn_round_report re-checks)", async () => {
    tables.learning_sessions = { data: null };
    rpc.mockResolvedValue({ data: null, error: { message: "round_not_found" } });
    const res = await reportGET(req(`/api/session/${ROUND}/report`), params({ sessionId: ROUND }));
    expect(res.status).toBe(404);
  });

  it("includes the whole-round report from fn_round_report", async () => {
    tables.learning_sessions = {
      data: { id: ROUND, youtube_video_id: "vid", transcript_id: "tr", status: "completed", accuracy: 50, total_attempts: 4, current_segment_index: 3, started_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-02T00:00:00Z" },
    };
    tables.attempt_logs = { data: [] };
    tables.videos = { data: { title: "T" } };
    tables.transcript_segments = { data: null, count: 4 };
    const round = { round: { roundId: ROUND }, historyComplete: true, sentences: [] };
    rpc.mockResolvedValue({ data: round, error: null });
    const res = await reportGET(req(`/api/session/${ROUND}/report`), params({ sessionId: ROUND }));
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("fn_round_report", { p_round_id: ROUND });
    expect((await res.json()).round).toEqual(round);
  });

  it("Learning Reports P1: derives the Dictation evidence from the rows it reads — valid answers only — and writes nothing", async () => {
    tables.learning_sessions = {
      data: { id: ROUND, youtube_video_id: "vid", transcript_id: "tr", status: "completed", accuracy: 50, total_attempts: 3, current_segment_index: 0, started_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-02T00:00:00Z" },
    };
    tables.attempt_logs = {
      data: [
        { id: "a1", segment_index: 0, expected_text: "Hi.", user_text: "hey", is_correct: false, error_type: "wrong_form", created_at: "2026-09-01T00:00:01Z", is_practice_valid: true, match_mode: "relaxed" },
        { id: "a2", segment_index: 0, expected_text: "Hi.", user_text: "", is_correct: false, error_type: "missing_word", created_at: "2026-09-01T00:00:02Z", is_practice_valid: false, match_mode: "relaxed" },
        { id: "a3", segment_index: 0, expected_text: "Hi.", user_text: "hi", is_correct: true, error_type: "none", created_at: "2026-09-01T00:00:03Z", is_practice_valid: true, match_mode: null },
      ],
    };
    tables.videos = { data: { title: "T" } };
    tables.transcript_segments = { data: null, count: 1 };
    tables.attempt_explanations = { data: [] };
    rpc.mockResolvedValue({ data: { round: { roundId: ROUND }, historyComplete: true, sentences: [] }, error: null });
    const res = await reportGET(req(`/api/session/${ROUND}/report`), params({ sessionId: ROUND }));
    const body = await res.json();
    expect(body.dictationEvidence).toEqual({
      validSubmissions: 2,
      validCorrect: 1,
      invalidSubmissions: 1,
      sentences: [
        {
          segmentIndex: 0,
          validSubmissions: 2,
          validIncorrect: 1,
          latest: { attemptId: "a3", userText: "hi", matchMode: null, isCorrect: true, createdAt: "2026-09-01T00:00:03Z" },
          lastWrong: { attemptId: "a1", userText: "hey", matchMode: "relaxed", isCorrect: false, createdAt: "2026-09-01T00:00:01Z" },
        },
      ],
    });
    // Read-only: the only RPC is the report itself (the mocked builder has no write methods at all).
    expect(rpc.mock.calls.map(([fn]) => fn)).toEqual(["fn_round_report"]);
  });

  it("Learning Reports P3: names the pinned script version and reports Listening at its real scope (script version + this round's sittings)", async () => {
    tables.learning_sessions = {
      data: { id: ROUND, youtube_video_id: "vid", transcript_id: "tr", status: "active", accuracy: 0, total_attempts: 0, current_segment_index: 0, started_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-02T00:00:00Z" },
    };
    tables.attempt_logs = { data: [] };
    tables.videos = { data: { title: "T" } };
    tables.transcript_segments = { data: null, count: 1 };
    tables.transcripts = { data: { version: 3 } };
    tables.listening_progress = { data: { coverage_ratio: "0.5", listened_through: false, last_position_sec: "12.5" } };
    tables.study_sessions = { data: [{ listening_newly_covered_sec: "10", listening_observed_sec: "15" }, { listening_newly_covered_sec: 5, listening_observed_sec: 5 }] };
    rpc.mockResolvedValue({ data: { round: { roundId: ROUND }, historyComplete: true, sentences: [] }, error: null });
    const body = await (await reportGET(req(`/api/session/${ROUND}/report`), params({ sessionId: ROUND }))).json();
    expect(body.transcriptVersion).toBe(3);
    expect(body.listening).toEqual({ coverageRatio: 0.5, listenedThrough: false, lastPositionSec: 12.5, roundSittingsNewlyCoveredSec: 15, roundSittingsObservedSec: 20 });
    expect(body.newerActiveRound).toBeNull(); // an active round is the current one
    expect(rpc.mock.calls.map(([fn]) => fn)).toEqual(["fn_round_report"]);
  });
});

describe("Library membership writes", () => {
  it("Add Video (signed in) is an EXPLICIT add; a guest just resolves the video", async () => {
    rpc.mockResolvedValue({ data: { added: true }, error: null });
    const res = await resolvePOST(req("/api/video/resolve", { method: "POST", body: { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" } }));
    expect(await res.json()).toMatchObject({ videoId: "dQw4w9WgXcQ", status: "ok", libraryAdded: true });
    expect(rpc).toHaveBeenCalledWith("fn_library_add_video", { p_youtube_video_id: "dQw4w9WgXcQ", p_explicit: true });

    rpc.mockClear();
    getUser.mockResolvedValue({ data: { user: null } });
    const guest = await resolvePOST(req("/api/video/resolve", { method: "POST", body: { url: "https://youtu.be/dQw4w9WgXcQ" } }));
    expect(await guest.json()).toEqual({ videoId: "dQw4w9WgXcQ", status: "ok" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("a video's FIRST round adds membership implicitly (never over a removal); an existing round doesn't", async () => {
    rpc.mockResolvedValueOnce({ data: { roundId: ROUND, created: true, roundStatus: "active" }, error: null });
    await savePOST(req("/api/session/save-progress", { method: "POST", body: { youtubeVideoId: "vid", currentSegmentIndex: 0 } }));
    expect(rpc).toHaveBeenLastCalledWith("fn_library_add_video", { p_youtube_video_id: "vid", p_explicit: false });

    rpc.mockReset();
    rpc.mockResolvedValueOnce({ data: { roundId: ROUND, created: false, roundStatus: "active" }, error: null });
    await savePOST(req("/api/session/save-progress", { method: "POST", body: { youtubeVideoId: "vid", currentSegmentIndex: 0 } }));
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(["fn_create_or_get_active_round"]);
  });
});
