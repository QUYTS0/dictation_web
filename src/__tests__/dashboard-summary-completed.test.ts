/**
 * GET /api/dashboard/summary — route contract (Supabase mocked). The metric
 * formulas themselves (verified vs earlier completions, in-progress overlap,
 * latest-answer accuracy, Azure without Word Match fallback, activity union,
 * local-day attribution) are computed by fn_dashboard_summary /
 * fn_activity_days and verified on real PostgreSQL in
 * integration/phase6-library and integration/phase6-corrections.
 *
 * Also: the practice header's GET /api/streak and the Dashboard share one
 * loader, so for the same data and timezone they report the same streak.
 */
import { NextRequest } from "next/server";

const rpc = jest.fn();
const tables: Record<string, unknown[]> = {};

function builder(table: string) {
  const result = { data: tables[table] ?? [], error: null, count: (tables[table] ?? []).length };
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "order", "limit"]) b[m] = () => b;
  b.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(result).then(resolve, reject);
  return b;
}

const getUser = jest.fn(async () => ({ data: { user: { id: "user-1" } as { id: string } | null } }));
jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser },
    from: (t: string) => builder(t),
    rpc: (fn: string) => rpc(fn),
  }),
}));

import { GET } from "@/app/api/dashboard/summary/route";
import { GET as GET_STREAK } from "@/app/api/streak/route";

const SUMMARY = {
  completedVideos: 2,
  legacyCompletedVideos: 1,
  inProgressVideos: 1,
  listenedThroughVideos: 3,
  libraryVideos: 5,
  sentenceAccuracy: { correct: 3, practiced: 4, excludedUnverified: 2 },
  shadowing: {
    takes: 1,
    practicedSentences: 1,
    attemptedSentences: 1,
    azure: { evaluatedSentences: 0, pronunciation: null, accuracy: null, completeness: null, fluency: null, prosody: null },
    wordMatch: { evaluatedSentences: 1, accuracy: 75, completeness: 75 },
  },
  activeTime: { activeSec: 900, trackedSince: "2026-09-01T00:00:00Z", sessionCount: 2 },
};

const req = (path: string, tz?: string) => new NextRequest(`http://localhost${path}${tz ? `?tz=${encodeURIComponent(tz)}` : ""}`);
const withDays = (days: string[], utcFallbackDays: string[] = []) =>
  rpc.mockImplementation(async (fn: string) =>
    fn === "fn_dashboard_summary" ? { data: SUMMARY, error: null } : { data: { days, utcFallbackDays }, error: null }
  );

beforeEach(() => {
  rpc.mockReset();
  for (const k of Object.keys(tables)) delete tables[k];
  getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

it("returns the database's separate metrics unchanged — missing stays null, nothing is blended or zero-filled", async () => {
  withDays([]);
  tables.vocabulary_items = [{ id: "v1", term: "cat", sentence_context: "a cat", created_at: "2026-09-01T00:00:00Z" }];
  const json = await (await GET(req("/api/dashboard/summary"))).json();
  expect(json).toMatchObject(SUMMARY);
  expect(json.shadowing.azure.pronunciation).toBeNull();
  expect(json.vocabularyCount).toBe(1);
  // The retired fields that mixed scopes are gone.
  expect(json).not.toHaveProperty("avgAccuracy");
  expect(json).not.toHaveProperty("totalPracticeMinutes");
  expect(json).not.toHaveProperty("resumableSessions");
});

describe("learning streak — local days, today in the viewer's zone", () => {
  // 2026-10-02 00:30 in Vietnam; still 2026-10-01 in UTC.
  const NOW = new Date("2026-10-01T17:30:00Z");
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] });
    jest.setSystemTime(NOW);
  });

  it("today is the viewer's local date: an Oct 2 (Vietnam) day counts as today at 00:30 local", async () => {
    withDays(["2026-10-02", "2026-10-01", "2026-09-30"]);
    const json = await (await GET(req("/api/dashboard/summary", "Asia/Ho_Chi_Minh"))).json();
    expect(json).toMatchObject({ streakDays: 3, streakToday: "2026-10-02", streakTimeZone: "Asia/Ho_Chi_Minh", streakIncludesUtcFallback: false });
  });

  it("latest practice yesterday (local) keeps the streak; a missing day ends it", async () => {
    withDays(["2026-10-01", "2026-09-30", "2026-09-28"]);
    expect((await (await GET(req("/api/dashboard/summary", "Asia/Ho_Chi_Minh"))).json()).streakDays).toBe(2);
    withDays(["2026-09-30", "2026-09-29"]);
    expect((await (await GET(req("/api/dashboard/summary", "Asia/Ho_Chi_Minh"))).json()).streakDays).toBe(0);
  });

  it("missing or invalid tz → today in UTC (documented fallback), never an error", async () => {
    withDays(["2026-10-01"]);
    for (const tz of [undefined, "Mars/Olympus", "+07:00"]) {
      const res = await GET(req("/api/dashboard/summary", tz));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ streakDays: 1, streakToday: "2026-10-01", streakTimeZone: "UTC" });
    }
  });

  it("flags a current streak that rests on a UTC-dated (historical) day", async () => {
    withDays(["2026-10-02", "2026-10-01", "2026-09-20"], ["2026-10-01", "2026-09-20"]);
    const json = await (await GET(req("/api/dashboard/summary", "Asia/Ho_Chi_Minh"))).json();
    expect(json).toMatchObject({ streakDays: 2, streakIncludesUtcFallback: true });
  });

  it("the practice header (/api/streak) and the Dashboard agree for the same data and zone", async () => {
    for (const [days, tz] of [
      [["2026-10-02", "2026-10-01"], "Asia/Ho_Chi_Minh"],
      [["2026-10-01", "2026-09-30", "2026-09-29"], "America/New_York"],
      [["2026-10-01"], undefined],
    ] as Array<[string[], string | undefined]>) {
      withDays(days);
      const dash = await (await GET(req("/api/dashboard/summary", tz))).json();
      const header = await (await GET_STREAK(req("/api/streak", tz))).json();
      expect(header).toEqual({
        streakDays: dash.streakDays,
        streakTimeZone: dash.streakTimeZone,
        streakToday: dash.streakToday,
        streakIncludesUtcFallback: dash.streakIncludesUtcFallback,
      });
    }
    // Both read the same function; neither writes anything.
    expect(new Set(rpc.mock.calls.map(([fn]) => fn))).toEqual(new Set(["fn_dashboard_summary", "fn_activity_days"]));
  });
});

it("migration 040 not applied → 503 with a stable code (never fake zeros)", async () => {
  rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "Could not find the function" } });
  for (const res of [await GET(req("/api/dashboard/summary")), await GET_STREAK(req("/api/streak"))]) {
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "learning_data_unavailable" });
  }
});

it("401 without a signed-in user; no database call", async () => {
  getUser.mockResolvedValue({ data: { user: null } });
  expect((await GET(req("/api/dashboard/summary"))).status).toBe(401);
  expect((await GET_STREAK(req("/api/streak"))).status).toBe(401);
  expect(rpc).not.toHaveBeenCalled();
});
