/**
 * GET /api/dashboard/week (dashboard redesign Phase 4): the viewer's local
 * days — ✓ from the streak's day set, minutes from fn_daily_activity
 * (migration 047), and the saved or default daily goal.
 */
import { NextRequest } from "next/server";

let user: { id: string } | null = { id: "user-1" };
type Rpc = { data: unknown; error: { message?: string; code?: string } | null };
let results: Record<string, Rpc>;
const rpc = jest.fn(async (fn: string) => results[fn] ?? { data: null, error: { message: "unexpected rpc" } });

jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user } }) }, rpc }),
}));

import { GET } from "@/app/api/dashboard/week/route";

const req = (tz?: string) => new NextRequest(`http://localhost/api/dashboard/week${tz ? `?tz=${encodeURIComponent(tz)}` : ""}`);

beforeEach(() => {
  user = { id: "user-1" };
  rpc.mockClear();
  // Wed 25 Nov 2026, 10:00 in Ho Chi Minh (03:00Z).
  jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] });
  jest.setSystemTime(new Date("2026-11-25T03:00:00Z"));
  results = {
    fn_activity_days: { data: { days: ["2026-11-25", "2026-11-23", "2026-11-10", "2026-10-01"], utcFallbackDays: [] }, error: null },
    fn_daily_activity: {
      data: [
        { date: "2026-11-23", activeSec: 1325.4 },
        { date: "2026-11-25", activeSec: 660 },
      ],
      error: null,
    },
    fn_my_profile: { data: { publicName: null, nickname: "Learner ABCDE", leaderboardHidden: false, dailyGoalMinutes: 30 }, error: null },
  };
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("GET /api/dashboard/week", () => {
  it("401 when signed out", async () => {
    user = null;
    expect((await GET(req("Asia/Ho_Chi_Minh"))).status).toBe(401);
  });

  it("14 local days ending today: ✓ from the streak's day set, seconds per day, the week's Monday, the saved goal", async () => {
    const res = await GET(req("Asia/Ho_Chi_Minh"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ timeZone: "Asia/Ho_Chi_Minh", today: "2026-11-25", weekStart: "2026-11-23", goalMinutes: 30, goalIsDefault: false });
    expect(body.days).toHaveLength(14);
    expect(body.days[0]).toEqual({ date: "2026-11-12", practiced: false, activeSec: 0 });
    expect(body.days[13]).toEqual({ date: "2026-11-25", practiced: true, activeSec: 660 });
    expect(body.days.find((d: { date: string }) => d.date === "2026-11-23")).toEqual({ date: "2026-11-23", practiced: true, activeSec: 1325.4 });
    // A practiced day outside the window isn't listed; one with no time is still practiced.
    expect(body.days.some((d: { date: string }) => d.date === "2026-11-10")).toBe(false);
    expect(rpc).toHaveBeenCalledWith("fn_daily_activity", { p_time_zone: "Asia/Ho_Chi_Minh", p_from: "2026-11-12", p_to: "2026-11-25" });
  });

  it("no saved goal → the default 15 min, flagged as the default", async () => {
    results.fn_my_profile = { data: { dailyGoalMinutes: null }, error: null };
    expect(await (await GET(req("Asia/Ho_Chi_Minh"))).json()).toMatchObject({ goalMinutes: 15, goalIsDefault: true });
  });

  it("a missing or invalid zone is UTC (its own local today)", async () => {
    jest.setSystemTime(new Date("2026-11-24T20:00:00Z")); // already the 25th in Ho Chi Minh, still the 24th in UTC
    const body = await (await GET(req("UTC+7"))).json();
    expect(body).toMatchObject({ timeZone: "UTC", today: "2026-11-24", weekStart: "2026-11-23" });
    expect(rpc).toHaveBeenCalledWith("fn_daily_activity", expect.objectContaining({ p_time_zone: "UTC", p_to: "2026-11-24" }));
  });

  it("migration 047 not applied → 503 learning_data_unavailable (the hero hides the track, never zeros)", async () => {
    results.fn_daily_activity = { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
    const res = await GET(req("Asia/Ho_Chi_Minh"));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("learning_data_unavailable");
  });

  it("a failed day-set read is an error too", async () => {
    results.fn_activity_days = { data: null, error: { message: "boom" } };
    expect((await GET(req("Asia/Ho_Chi_Minh"))).status).toBe(500);
  });
});
