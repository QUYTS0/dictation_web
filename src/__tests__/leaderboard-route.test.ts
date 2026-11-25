/**
 * GET /api/leaderboard and POST /api/leaderboard/kudos (dashboard redesign
 * Phase 7, migration 050).
 */
import { NextRequest } from "next/server";

let user: { id: string } | null = { id: "user-1" };
type Rpc = { data: unknown; error: { message?: string; code?: string } | null };
let results: Record<string, Rpc>;
const rpc = jest.fn<Promise<Rpc>, [fn: string, params?: unknown]>(async (fn) => results[fn] ?? { data: null, error: { message: "unexpected rpc" } });

jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user } }) }, rpc }),
}));

import { GET } from "@/app/api/leaderboard/route";
import { POST } from "@/app/api/leaderboard/kudos/route";

const KEY = "0b5a2c6e-1d3f-4a5b-8c7d-9e0f1a2b3c4d";
const row = (rank: number, over: Record<string, unknown> = {}) => ({
  rank,
  memberKey: `00000000-0000-4000-8000-00000000000${rank}`,
  name: `Learner ${rank}AAAA`,
  weekXp: 200 - rank * 20,
  streakDays: 2,
  kudos: 0,
  youGaveKudos: false,
  isYou: false,
  zone: rank <= 3 ? "promotion" : "safe",
  ...over,
});
const base = { status: "member", tier: 3, weekStart: "2026-11-23", weekEndsAt: "2026-11-30T00:00:00+00:00", displayName: "Linh Tran", lastWeek: null };
const get = (qs = "") => GET(new NextRequest(`http://localhost/api/leaderboard${qs}`));
const post = (body: string) => POST(new NextRequest("http://localhost/api/leaderboard/kudos", { method: "POST", headers: { "Content-Type": "application/json" }, body }));

beforeEach(() => {
  user = { id: "user-1" };
  rpc.mockClear();
  // The viewer's own streak (loadActivityStreak → fn_activity_days): today and yesterday.
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  results = {
    fn_league_board: {
      data: { ...base, scope: "week", rows: [row(1), row(2), row(3), row(4), row(5, { isYou: true, name: "Linh Tran", streakDays: 0 })], you: null },
      error: null,
    },
    fn_activity_days: { data: { days: [today, yesterday], utcFallbackDays: [] }, error: null },
    fn_league_give_kudos: { data: { ok: true, kudos: 3 }, error: null },
  };
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("GET /api/leaderboard", () => {
  it("401 when signed out (nothing read, nobody placed in a group)", async () => {
    user = null;
    expect((await get()).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("week (default): initials; the caller's own streak is their viewer-local one; you + the XP gap to #3", async () => {
    const res = await get("?tz=UTC");
    expect(rpc).toHaveBeenCalledWith("fn_league_board", { p_scope: "week" });
    const body = await res.json();
    expect(body).toMatchObject({ scope: "week", status: "member", tier: 3, displayName: "Linh Tran" });
    expect(body.rows[0]).toMatchObject({ initials: "L1", weekXp: 180, zone: "promotion" });
    expect(body.rows[4]).toMatchObject({ isYou: true, initials: "LT", streakDays: 2 });
    // #3 has 140 XP, the caller 100: 41 more passes them.
    expect(body.you).toEqual({ rank: 5, weekXp: 100, zone: "safe", gapToPromotionXp: 41 });
    expect(JSON.stringify(body)).not.toMatch(/user-1|email|avatar/);
  });

  it("no gap in the promotion zone or in Master; a member not yet ranked has none", async () => {
    results.fn_league_board.data = { ...base, scope: "week", rows: [row(1, { isYou: true })], you: null };
    expect((await (await get()).json()).you.gapToPromotionXp).toBeNull();
    results.fn_league_board.data = { ...base, tier: 6, scope: "week", rows: [row(1), row(2), row(3), row(4, { isYou: true })], you: null };
    expect((await (await get()).json()).you.gapToPromotionXp).toBeNull();
    results.fn_league_board.data = { ...base, status: "not_joined", scope: "week", rows: [], you: null };
    expect((await (await get()).json()).you).toBeNull();
  });

  it("all time: top rows with initials, the caller's rank and the snapshot time; no streak read", async () => {
    results.fn_league_board.data = {
      ...base,
      scope: "all",
      rows: [{ rank: 1, name: "Mai", totalXp: 9000, isYou: false }],
      you: { rank: 12, totalXp: 1500 },
      refreshedAt: "2026-11-25T09:00:00Z",
    };
    const body = await (await get("?scope=all")).json();
    expect(rpc).toHaveBeenCalledWith("fn_league_board", { p_scope: "all" });
    expect(rpc).not.toHaveBeenCalledWith("fn_activity_days");
    expect(body).toMatchObject({ scope: "all", rows: [{ rank: 1, name: "Mai", initials: "M", totalXp: 9000, isYou: false }], you: { rank: 12, totalXp: 1500 }, refreshedAt: "2026-11-25T09:00:00Z" });
  });

  it("migration 050 not applied → 503 learning_data_unavailable", async () => {
    results.fn_league_board = { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
    const res = await get();
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("learning_data_unavailable");
  });
});

describe("POST /api/leaderboard/kudos", () => {
  it("401 when signed out", async () => {
    user = null;
    expect((await post(JSON.stringify({ memberKey: KEY }))).status).toBe(401);
  });

  it.each([["not JSON", "{"], ["no key", "{}"], ["not a uuid", JSON.stringify({ memberKey: "user-2" })]])("400 for %s, without calling the database", async (_l, body) => {
    expect((await post(body)).status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("gives kudos through fn_league_give_kudos and answers the receiver's count", async () => {
    const res = await post(JSON.stringify({ memberKey: KEY }));
    expect(await res.json()).toEqual({ ok: true, kudos: 3 });
    expect(rpc).toHaveBeenCalledWith("fn_league_give_kudos", { p_member_key: KEY });
  });

  it("refused by the database (self, another group, hidden) → 400", async () => {
    results.fn_league_give_kudos = { data: null, error: { message: "invalid_payload" } };
    expect((await post(JSON.stringify({ memberKey: KEY }))).status).toBe(400);
  });
});
