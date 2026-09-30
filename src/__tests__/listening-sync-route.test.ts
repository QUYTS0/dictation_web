import { NextRequest } from "next/server";

// POST /api/listening/sync, POST /api/study-session/activity,
// GET /api/listening/progress — route contracts. Attribution, deduplication
// and merging are the database's job and are verified on real PostgreSQL in
// integration/phase5-listening.integration.test.ts; here Supabase is mocked.
const rpc = jest.fn();
const getUser = jest.fn();
const from = jest.fn();
const tables: Record<string, unknown> = {};
const filters: Array<[string, string, unknown]> = [];

function builder(table: string) {
  const b: Record<string, unknown> = {};
  b.select = () => b;
  for (const m of ["eq", "is"]) b[m] = (col: string, val: unknown) => (filters.push([table, `${m}:${col}`, val]), b);
  b.order = () => b;
  b.limit = () => b;
  b.maybeSingle = async () => ({ data: tables[table] ?? null, error: null });
  return b;
}

jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser }, rpc, from: (t: string) => (from(t), builder(t)) }),
}));

import { POST as syncPOST } from "@/app/api/listening/sync/route";
import { POST as activityPOST } from "@/app/api/study-session/activity/route";
import { GET as progressGET } from "@/app/api/listening/progress/route";

const BATCH = "7b0c3b9e-0000-4000-8000-0000000000b1";
const TR = "7b0c3b9e-0000-4000-8000-0000000000a1";
const ROUND = "7b0c3b9e-0000-4000-8000-0000000000d1";
const SESSION = "7b0c3b9e-0000-4000-8000-0000000000c1";

const post = (url: string, body: unknown) =>
  new NextRequest(`http://localhost${url}`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
const sync = (over: Record<string, unknown> = {}) =>
  syncPOST(
    post("/api/listening/sync", {
      videoId: "vid",
      transcriptId: TR,
      flushBatchId: BATCH,
      intervals: [{ start: 0, end: 10 }],
      currentPositionSec: 10,
      roundId: ROUND,
      observedAgeSec: 3,
      clientTimezone: "Asia/Ho_Chi_Minh",
      ...over,
    })
  );

beforeEach(() => {
  jest.clearAllMocks();
  filters.length = 0;
  for (const k of Object.keys(tables)) delete tables[k];
  jest.spyOn(console, "error").mockImplementation(() => {});
  getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  rpc.mockResolvedValue({
    data: { processed: true, coverageRatio: 0.25, listenedThrough: false, coveredSec: 10, lastPositionSec: 10, hasHistory: true, transcriptCoveredSec: 40, studySessionId: SESSION, attribution: "current" },
    error: null,
  });
});
afterEach(() => jest.restoreAllMocks());

describe("POST /api/listening/sync", () => {
  it("makes ONE atomic call as the caller, passing the observed round — the route resolves no round and no session itself", async () => {
    const res = await sync();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ processed: true, coverageRatio: 0.25, lastPositionSec: 10, hasHistory: true, studySessionId: SESSION, attribution: "current" });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("fn_sync_study_activity", {
      p_kind: "listening",
      p_flush_batch_id: BATCH,
      p_youtube_video_id: "vid",
      p_round_id: ROUND,
      p_intervals: [{ start: 0, end: 10 }],
      p_transcript_id: TR,
      p_current_position_sec: 10,
      p_client_timezone: "Asia/Ho_Chi_Minh",
      p_observed_age_sec: 3,
    });
    expect(from).not.toHaveBeenCalled(); // no separate read of rounds / sessions / the dedup log
  });

  it("no round observed → null; a client-supplied session id is not an input at all", async () => {
    await sync({ roundId: null, studySessionId: SESSION, observedAgeSec: undefined });
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_round_id: null, p_observed_age_sec: null });
    expect(JSON.stringify(rpc.mock.calls[0][1])).not.toContain(SESSION);
  });

  it("a checkpoint is passed only when the client observed one (null stays null — never 0)", async () => {
    await sync({ currentPositionSec: null });
    expect(rpc.mock.calls[0][1].p_current_position_sec).toBeNull();
    await sync({ currentPositionSec: 0.4 }); // a real return to the beginning
    expect(rpc.mock.calls[1][1].p_current_position_sec).toBe(0.4);
  });

  it("validates the payload before touching the database", async () => {
    for (const bad of [
      { flushBatchId: "nope" },
      { videoId: "" },
      { intervals: "x" },
      { intervals: [{ start: 5, end: 5 }] },
      { intervals: [{ start: 9, end: 5 }] },
      { intervals: [{ start: -1, end: 5 }] },
      { intervals: [{ start: 0, end: 2e7 }] },
      { intervals: [{ start: "0", end: 5 }] },
      { intervals: [{ start: null, end: 5 }] },
      { intervals: Array.from({ length: 1001 }, (_, i) => ({ start: i, end: i + 0.5 })) },
      { transcriptId: "nope" },
      { currentPositionSec: -3 },
      { roundId: "nope" },
      { observedAgeSec: -1 },
      { observedAgeSec: "5" },
      { observedAgeSec: 8 * 86400 },
      { clientTimezone: "x".repeat(65) },
    ]) {
      expect((await sync(bad)).status).toBe(400);
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it("requires sign-in", async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    expect((await sync()).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["study_session_mismatch", undefined, 409],
    ["transcript_not_found_for_video", undefined, 409],
    ["flush_batch_id_reused_with_different_payload", undefined, 409],
    ["round_mismatch", undefined, 409],
    ["late_activity_without_session", undefined, 409],
    ["invalid_interval_payload", undefined, 400],
    ["authentication_required", undefined, 401],
    ["function missing", "PGRST202", 503],
    ["boom", undefined, 500],
  ])("maps %s to %i", async (message, code, expected) => {
    rpc.mockResolvedValue({ data: null, error: { message, code } });
    expect((await sync()).status).toBe(expected);
  });
});

describe("POST /api/study-session/activity", () => {
  it("syncs wall-clock intervals as kind 'activity' without transcript or position", async () => {
    rpc.mockResolvedValue({ data: { processed: true, studySessionId: SESSION, attribution: "current" }, error: null });
    const now = Math.floor(Date.now() / 1000);
    const res = await activityPOST(
      post("/api/study-session/activity", { videoId: "vid", flushBatchId: BATCH, roundId: ROUND, intervals: [{ start: now - 20, end: now }], transcriptId: TR, currentPositionSec: 5 })
    );
    expect(res.status).toBe(200);
    expect(rpc.mock.calls[0][1]).toMatchObject({
      p_kind: "activity",
      p_round_id: ROUND,
      p_transcript_id: null,
      p_current_position_sec: null,
      p_intervals: [{ start: now - 20, end: now }],
    });
  });

  it("rejects malformed intervals (reversed, non-numeric, non-finite-as-null)", async () => {
    for (const intervals of [[{ start: 10, end: 5 }], [{ start: "a", end: "b" }], [{ start: null, end: 5 }], [42], "x"]) {
      const res = await activityPOST(post("/api/study-session/activity", { videoId: "vid", flushBatchId: BATCH, roundId: null, intervals }));
      expect(res.status).toBe(400);
    }
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("GET /api/listening/progress", () => {
  const get = (qs: string) => progressGET(new NextRequest(`http://localhost/api/listening/progress?${qs}`));

  it("returns the caller's revision-scoped coverage and the persisted checkpoint", async () => {
    tables.listening_progress = {
      covered_sec: "12.5",
      transcript_covered_sec: "50",
      coverage_ratio: "0.25",
      listened_through: false,
      listened_through_at: null,
      last_position_sec: "30",
    };
    const res = await get(`videoId=vid&transcriptId=${TR}`);
    expect(await res.json()).toEqual({
      videoId: "vid",
      transcriptId: TR,
      coveredSec: 12.5,
      transcriptCoveredSec: 50,
      coverageRatio: 0.25,
      listenedThrough: false,
      listenedThroughAt: null,
      lastPositionSec: 30,
      hasHistory: true,
    });
    expect(filters).toEqual(expect.arrayContaining([["listening_progress", "eq:user_id", "user-1"], ["listening_progress", "eq:transcript_id", TR]]));
  });

  it("no row yet → zero coverage, no history; no transcript → the current pre-transcript row", async () => {
    expect(await (await get("videoId=vid&transcriptId=" + TR)).json()).toMatchObject({ coverageRatio: 0, hasHistory: false, transcriptCoveredSec: null });
    filters.length = 0;
    await get("videoId=vid");
    expect(filters).toEqual(expect.arrayContaining([["listening_progress", "is:transcript_id", null], ["listening_progress", "is:superseded_at", null]]));
  });

  it("validates and requires sign-in", async () => {
    expect((await get("transcriptId=" + TR)).status).toBe(400);
    expect((await get("videoId=vid&transcriptId=nope")).status).toBe(400);
    getUser.mockResolvedValue({ data: { user: null } });
    expect((await get("videoId=vid")).status).toBe(401);
  });
});
