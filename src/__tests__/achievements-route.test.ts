/**
 * GET /api/achievements (dashboard redesign Phase 6, migration 049).
 */
let user: { id: string } | null = { id: "user-1" };
type Rpc = { data: unknown; error: { message?: string; code?: string } | null };
let result: Rpc;
const rpc = jest.fn<Promise<Rpc>, [fn: string, params?: unknown]>(async () => result);

jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user } }) }, rpc }),
}));

import { GET } from "@/app/api/achievements/route";

beforeEach(() => {
  user = { id: "user-1" };
  rpc.mockClear();
  result = {
    data: {
      tracks: [
        { track: "flame_keeper", value: 9, tiers: [{ tier: 1, threshold: "3", unlockedAt: "2026-11-20T00:00:00Z" }, { tier: 2, threshold: "7", unlockedAt: null }] },
        { track: "immersion", value: "1.02", tiers: [{ tier: 1, threshold: 1, unlockedAt: null }] },
        { track: "future_track", value: 1, tiers: [] },
      ],
      newlyUnlocked: [
        { track: "flame_keeper", tier: 1, unlockedAt: "2026-11-20T00:00:00Z" },
        { track: "future_track", tier: 1, unlockedAt: "2026-11-20T00:00:00Z" },
      ],
    },
    error: null,
  };
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("GET /api/achievements", () => {
  it("401 when signed out (nothing is synced)", async () => {
    user = null;
    expect((await GET()).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("syncs through fn_sync_achievements; numbers normalized; tracks this app doesn't know are left out", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("fn_sync_achievements");
    expect(await res.json()).toEqual({
      tracks: [
        { track: "flame_keeper", value: 9, tiers: [{ tier: 1, threshold: 3, unlockedAt: "2026-11-20T00:00:00Z" }, { tier: 2, threshold: 7, unlockedAt: null }] },
        { track: "immersion", value: 1.02, tiers: [{ tier: 1, threshold: 1, unlockedAt: null }] },
      ],
      newlyUnlocked: [{ track: "flame_keeper", tier: 1, unlockedAt: "2026-11-20T00:00:00Z" }],
    });
  });

  it("migration 049 not applied → 503 learning_data_unavailable", async () => {
    result = { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
    const res = await GET();
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("learning_data_unavailable");
  });
});
