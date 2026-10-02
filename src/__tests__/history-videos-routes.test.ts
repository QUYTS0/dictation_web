/**
 * History-by-video routes (migration 042) — contract with Supabase mocked:
 * validation, the exact RPC each calls, cursor pass-through, error mapping,
 * and that they are reads (only rpc, never a table write).
 */
import { NextRequest } from "next/server";
import { GET as VIDEOS } from "@/app/api/history/videos/route";
import { GET as ROUNDS } from "@/app/api/history/videos/[videoId]/rounds/route";
import { GET as SESSIONS } from "@/app/api/history/videos/[videoId]/sessions/route";

const rpc = jest.fn();
const from = jest.fn();
const getUser = jest.fn();
jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser }, rpc: (...a: unknown[]) => rpc(...a), from: (...a: unknown[]) => from(...a) }),
}));

const RID = "0b6c1b4e-4d0f-4b8e-9c55-6f1d1d6c2a11";
const SID = "1c6c1b4e-4d0f-4b8e-9c55-6f1d1d6c2a22";
const req = (path: string) => new NextRequest(`http://localhost${path}`);
const videoParams = (videoId: string) => ({ params: Promise.resolve({ videoId }) });

beforeEach(() => {
  rpc.mockReset();
  from.mockReset();
  getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  rpc.mockResolvedValue({ data: { items: [], hasMore: false }, error: null });
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  expect(from).not.toHaveBeenCalled(); // reads through the 042 functions only
  jest.restoreAllMocks();
});

describe("GET /api/history/videos", () => {
  it("first page and a cursor page call fn_history_videos with the keyset", async () => {
    await VIDEOS(req("/api/history/videos?limit=10"));
    expect(rpc).toHaveBeenLastCalledWith("fn_history_videos", { p_limit: 10, p_before_last_activity_at: null, p_before_video: null });
    await VIDEOS(req("/api/history/videos?limit=5&beforeLastActivityAt=2026-09-30T08:25:00Z&beforeVideoId=vidL"));
    expect(rpc).toHaveBeenLastCalledWith("fn_history_videos", {
      p_limit: 5,
      p_before_last_activity_at: "2026-09-30T08:25:00Z",
      p_before_video: "vidL",
    });
  });

  it("rejects a half or malformed cursor and bad limits; 401 for guests", async () => {
    for (const q of ["limit=0", "limit=51", "beforeVideoId=vidL", "beforeLastActivityAt=2026-09-30T08:25:00Z", "beforeLastActivityAt=nope&beforeVideoId=v"]) {
      expect([q, (await VIDEOS(req(`/api/history/videos?${q}`))).status]).toEqual([q, 400]);
    }
    getUser.mockResolvedValueOnce({ data: { user: null } });
    expect((await VIDEOS(req("/api/history/videos"))).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("migration 042 missing → 503 with a stable code", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: "PGRST202", message: "Could not find the function" } });
    const res = await VIDEOS(req("/api/history/videos"));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "learning_data_unavailable" });
  });
});

describe("GET /api/history/videos/[videoId]/rounds", () => {
  it("calls fn_history_video_rounds for the video (bounded)", async () => {
    rpc.mockResolvedValueOnce({ data: { videoId: "vidA", defaultRoundId: null, rounds: [], hasMore: false, roundlessSessionCount: 0 }, error: null });
    expect((await ROUNDS(req("/x"), videoParams("vidA"))).status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("fn_history_video_rounds", { p_video: "vidA", p_limit: 50 });
    expect((await ROUNDS(req("/x"), videoParams("x".repeat(65)))).status).toBe(400);
  });
});

describe("GET /api/history/videos/[videoId]/sessions", () => {
  it("one round's sessions, or the round-less ones — never mixed — with the session keyset", async () => {
    await SESSIONS(req(`/x?roundId=${RID}&limit=10`), videoParams("vidA"));
    expect(rpc).toHaveBeenLastCalledWith("fn_history_video_sessions", {
      p_video: "vidA",
      p_round_id: RID,
      p_roundless: false,
      p_limit: 10,
      p_before_started_at: null,
      p_before_id: null,
    });
    await SESSIONS(req(`/x?roundId=none&limit=10&beforeStartedAt=2026-09-20T08:00:00Z&beforeId=${SID}`), videoParams("vidA"));
    expect(rpc).toHaveBeenLastCalledWith("fn_history_video_sessions", {
      p_video: "vidA",
      p_round_id: null,
      p_roundless: true,
      p_limit: 10,
      p_before_started_at: "2026-09-20T08:00:00Z",
      p_before_id: SID,
    });
  });

  it("requires a round id or 'none'; another user's round is a 404", async () => {
    for (const q of ["", "roundId=abc", `roundId=${RID}&beforeId=${SID}`]) {
      expect([q, (await SESSIONS(req(`/x?${q}`), videoParams("vidA"))).status]).toEqual([q, 400]);
    }
    rpc.mockResolvedValueOnce({ data: null, error: { message: "round_not_found" } });
    expect((await SESSIONS(req(`/x?roundId=${RID}`), videoParams("vidA"))).status).toBe(404);
  });
});
