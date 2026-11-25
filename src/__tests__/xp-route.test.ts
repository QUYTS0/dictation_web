/**
 * GET /api/xp (dashboard redesign Phase 5, migration 048): the database's
 * calculated XP plus the level derived from the total.
 */
import { NextRequest } from "next/server";

let user: { id: string } | null = { id: "user-1" };
type Rpc = { data: unknown; error: { message?: string; code?: string } | null };
let result: Rpc;
const rpc = jest.fn<Promise<Rpc>, [fn: string, params?: unknown]>(async () => result);

jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user } }) }, rpc }),
}));

import { GET } from "@/app/api/xp/route";

const req = (tz?: string) => new NextRequest(`http://localhost/api/xp${tz ? `?tz=${encodeURIComponent(tz)}` : ""}`);
const RAW = {
  rulesVersion: 1,
  timeZone: "Asia/Ho_Chi_Minh",
  xpTimeZone: "Asia/Ho_Chi_Minh",
  today: "2026-11-25",
  totalXp: 4850,
  todayXp: 40,
  leagueWeekStart: "2026-11-23T00:00:00+00:00",
  leagueWeekXp: 300,
  lastLeagueWeek: { weekStart: "2026-11-16", xp: 1240, activeSec: 5760, wordsReviewed: 41 },
  days: [],
};

beforeEach(() => {
  user = { id: "user-1" };
  result = { data: RAW, error: null };
  rpc.mockClear();
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("GET /api/xp", () => {
  it("401 when signed out (nothing is read)", async () => {
    user = null;
    expect((await GET(req("Asia/Ho_Chi_Minh"))).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("the database's XP with the level derived from the total (4,850 → level 10: 4,500 to 5,500)", async () => {
    const res = await GET(req("Asia/Ho_Chi_Minh"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...RAW, level: 10, levelStartXp: 4500, nextLevelXp: 5500 });
    expect(rpc).toHaveBeenCalledWith("fn_my_xp", { p_time_zone: "Asia/Ho_Chi_Minh" });
  });

  it("a missing or invalid viewer zone is UTC", async () => {
    await GET(req("UTC+7"));
    expect(rpc).toHaveBeenCalledWith("fn_my_xp", { p_time_zone: "UTC" });
  });

  it("migration 048 not applied → 503 learning_data_unavailable", async () => {
    result = { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
    const res = await GET(req());
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("learning_data_unavailable");
  });
});
