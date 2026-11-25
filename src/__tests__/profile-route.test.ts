/**
 * GET/PATCH /api/profile (dashboard redesign Phase 4, migration 047). The
 * database validates values (fn_update_my_profile); the route only rejects
 * bodies that can't be a patch.
 */
import { NextRequest } from "next/server";

let user: { id: string } | null = { id: "user-1" };
type Rpc = { data: unknown; error: { message?: string; code?: string } | null };
let result: Rpc;
const rpc = jest.fn<Promise<Rpc>, [fn: string, params?: unknown]>(async () => result);

jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user } }) }, rpc }),
}));

import { GET, PATCH } from "@/app/api/profile/route";

const PROFILE = { publicName: null, nickname: "Learner ABCDE", leaderboardHidden: false, dailyGoalMinutes: 20 };
const patch = (body: string) =>
  new NextRequest("http://localhost/api/profile", { method: "PATCH", headers: { "Content-Type": "application/json" }, body });

beforeEach(() => {
  user = { id: "user-1" };
  result = { data: PROFILE, error: null };
  rpc.mockClear();
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("GET /api/profile", () => {
  it("401 when signed out", async () => {
    user = null;
    expect((await GET()).status).toBe(401);
  });

  it("the caller's preferences from fn_my_profile", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(PROFILE);
    expect(rpc).toHaveBeenCalledWith("fn_my_profile");
  });

  it("migration 047 not applied → 503", async () => {
    result = { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
    expect((await GET()).status).toBe(503);
  });
});

describe("PATCH /api/profile", () => {
  it("401 when signed out (nothing is called)", async () => {
    user = null;
    expect((await PATCH(patch(JSON.stringify({ dailyGoalMinutes: 30 })))).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("passes the patch as-is to fn_update_my_profile and answers with the updated profile", async () => {
    result = { data: { ...PROFILE, dailyGoalMinutes: 30 }, error: null };
    const res = await PATCH(patch(JSON.stringify({ dailyGoalMinutes: 30 })));
    expect(res.status).toBe(200);
    expect((await res.json()).dailyGoalMinutes).toBe(30);
    expect(rpc).toHaveBeenCalledWith("fn_update_my_profile", { p_patch: { dailyGoalMinutes: 30 } });
  });

  it.each([
    ["not JSON", "{"],
    ["an array", "[30]"],
    ["null", "null"],
    ["an empty object", "{}"],
    ["an unknown key", JSON.stringify({ dailyGoalMinutes: 30, is_admin: true })],
  ])("400 for %s, without calling the database", async (_label, body) => {
    const res = await PATCH(patch(body));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_payload");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("a value the database refuses is a 400", async () => {
    result = { data: null, error: { message: "invalid_payload" } };
    const res = await PATCH(patch(JSON.stringify({ dailyGoalMinutes: 25 })));
    expect(res.status).toBe(400);
  });
});
