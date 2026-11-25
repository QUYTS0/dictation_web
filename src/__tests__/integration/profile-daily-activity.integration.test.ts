/**
 * Migration 047 on real PostgreSQL (dashboard redesign Phase 4, D3): the
 * profile preferences (fn_my_profile / fn_update_my_profile and the CHECK
 * backstops) and fn_daily_activity — executed under the real
 * `authenticated` role the way PostgREST runs it.
 *
 * Upgrade path: 001–046 with the activated cutover, study sessions seeded
 * BEFORE 047, then 047. Skipped unless LOCALDB_ADMIN_URL is set.
 */
import {
  HAS_LOCALDB,
  applyMigration,
  asRole,
  createTestDb,
  createUser,
  errorOf,
  rpcAs,
  runCutover,
  type PgClient,
  type TestDb,
} from "./localdb/harness";

const d = HAS_LOCALDB ? describe : describe.skip;
if (!HAS_LOCALDB) console.warn("[profile-daily-activity] skipped — LOCALDB_ADMIN_URL not set");

type Profile = { publicName: string | null; nickname: string; leaderboardHidden: boolean; dailyGoalMinutes: number | null };
type Day = { date: string; activeSec: number };

const HCM = "Asia/Ho_Chi_Minh"; // UTC+7, no DST
const NY = "America/New_York";
const at = (iso: string) => Date.parse(iso) / 1000;
const span = (from: string, to: string) => ({ start: at(from), end: at(to) });

d("047 — profile preferences and active time per local day (real PostgreSQL)", () => {
  let db: TestDb;
  let c: PgClient;
  let userA: string;
  let userB: string;
  let userDst: string;

  const insertSession = (user: string, intervals: Array<{ start: number; end: number }>) =>
    c.query(`insert into study_sessions (user_id, youtube_video_id, activity_intervals) values ($1, 'vid1', $2::jsonb)`, [
      user,
      JSON.stringify(intervals),
    ]);
  const profile = (user: string) => rpcAs<Profile>(c, user, "select fn_my_profile()");
  const update = (user: string, patch: unknown) => rpcAs<Profile>(c, user, "select fn_update_my_profile($1::jsonb)", [JSON.stringify(patch)]);
  const daily = (user: string, tz: string | null, from: string, to: string) =>
    rpcAs<Day[]>(c, user, "select fn_daily_activity($1, $2::date, $3::date)", [tz, from, to]);
  const byDate = (days: Day[]) => Object.fromEntries(days.map((x) => [x.date, Number(x.activeSec)]));

  beforeAll(async () => {
    db = await createTestDb("profile047", 46);
    c = await db.connect();
    await runCutover(c, "activated");
    userA = await createUser(c);
    userB = await createUser(c);
    userDst = await createUser(c);
    // A: 23:50–00:10 Ho Chi Minh time (crosses local midnight), plus a second
    // tab overlapping it 00:00–00:20 — the union is 23:50–00:20.
    await insertSession(userA, [span("2026-11-20T16:50:00Z", "2026-11-20T17:10:00Z")]);
    await insertSession(userA, [span("2026-11-20T17:00:00Z", "2026-11-20T17:20:00Z")]);
    // B practiced at the same time: never part of A's days.
    await insertSession(userB, [span("2026-11-20T16:00:00Z", "2026-11-20T18:00:00Z")]);
    // New York's DST days: 8 Mar 2026 has 23 hours, 1 Nov 2026 has 25. Each
    // interval covers the whole local day, midnight to midnight.
    await insertSession(userDst, [span("2026-03-08T05:00:00Z", "2026-03-09T04:00:00Z"), span("2026-11-01T04:00:00Z", "2026-11-02T05:00:00Z")]);
    await applyMigration(c, 47);
  }, 240_000);
  afterAll(async () => {
    await c?.end();
    await db?.drop();
  });

  it("re-applying 047 changes nothing (idempotent)", async () => {
    await update(userB, { dailyGoalMinutes: 45 });
    await applyMigration(c, 47);
    expect((await profile(userB)).dailyGoalMinutes).toBe(45);
  });

  describe("fn_my_profile / fn_update_my_profile", () => {
    it("defaults: no public name, not hidden, no goal (the app's default applies), a stable generated nickname", async () => {
      const p = await profile(userA);
      expect(p).toEqual({ publicName: null, nickname: expect.stringMatching(/^Learner [0-9A-F]{5}$/), leaderboardHidden: false, dailyGoalMinutes: null });
      expect((await profile(userA)).nickname).toBe(p.nickname);
      expect((await profile(userDst)).nickname).not.toBe(p.nickname);
    });

    it("a patch changes only the keys it carries; null clears the goal", async () => {
      expect((await update(userA, { dailyGoalMinutes: 30 })).dailyGoalMinutes).toBe(30);
      expect(await update(userA, { leaderboardHidden: true })).toMatchObject({ dailyGoalMinutes: 30, leaderboardHidden: true });
      expect(await update(userA, { dailyGoalMinutes: null, leaderboardHidden: false })).toMatchObject({ dailyGoalMinutes: null, leaderboardHidden: false });
    });

    it("public names are trimmed and single-spaced; an empty name clears it; any script is allowed", async () => {
      expect((await update(userA, { publicName: "  Tri   Nguyen " })).publicName).toBe("Tri Nguyen");
      expect((await update(userA, { publicName: "Trí Nguyễn" })).publicName).toBe("Trí Nguyễn");
      expect((await update(userA, { publicName: "   " })).publicName).toBeNull();
      expect((await update(userA, { publicName: "Mai" })).publicName).toBe("Mai");
      expect((await update(userA, { publicName: null })).publicName).toBeNull();
    });

    it.each([
      ["an unsupported goal", { dailyGoalMinutes: 25 }],
      ["a fractional goal", { dailyGoalMinutes: 15.5 }],
      ["a goal sent as text", { dailyGoalMinutes: "30" }],
      ["a one-letter name", { publicName: "a" }],
      ["a 25-character name", { publicName: "x".repeat(25) }],
      ["an email as name", { publicName: "me@example.com" }],
      ["a URL as name", { publicName: "http://x.y" }],
      ["markup as name", { publicName: "<b>hi</b>" }],
      ["a generated nickname as name", { publicName: "learner 4f2a2" }],
      ["a non-boolean visibility", { leaderboardHidden: "yes" }],
      ["a null visibility", { leaderboardHidden: null }],
      ["an unknown key", { dailyGoalMinutes: 30, isAdmin: true }],
      ["an empty patch", {}],
      ["a non-object patch", [30]],
    ])("refuses %s with 'invalid_payload' and changes nothing", async (_label, patch) => {
      await update(userA, { dailyGoalMinutes: 20, publicName: "Mai" });
      expect((await errorOf(update(userA, patch)))?.message).toBe("invalid_payload");
      expect(await profile(userA)).toMatchObject({ dailyGoalMinutes: 20, publicName: "Mai", leaderboardHidden: false });
    });

    it("a direct PATCH of the user's own row (users_self_update) cannot store what the function refuses", async () => {
      for (const sql of [
        "update users set daily_goal_minutes = 25 where id = $1",
        "update users set public_name = 'me@example.com' where id = $1",
        "update users set public_name = ' padded' where id = $1",
      ]) {
        expect((await errorOf(asRole(c, "authenticated", userA, () => c.query(sql, [userA]))))?.code).toBe("23514");
      }
      // A valid direct write is still allowed (it is the user's own row).
      await asRole(c, "authenticated", userA, () => c.query("update users set daily_goal_minutes = 60 where id = $1", [userA]));
      expect((await profile(userA)).dailyGoalMinutes).toBe(60);
    });

    it("each user changes only their own row", async () => {
      await update(userA, { dailyGoalMinutes: 10 });
      expect((await profile(userB)).dailyGoalMinutes).toBe(45);
    });

    it("anon can call none of them; authenticated without a user is refused; the nickname helper is internal", async () => {
      for (const sql of ["select fn_my_profile()", "select fn_update_my_profile('{\"dailyGoalMinutes\":15}')", `select fn_daily_activity('UTC', current_date, current_date)`]) {
        expect((await errorOf(asRole(c, "anon", null, () => c.query(sql))))?.message).toMatch(/permission denied/);
        expect((await errorOf(asRole(c, "authenticated", null, () => c.query(sql))))?.message).toBe("authentication_required");
      }
      const helper = await errorOf(asRole(c, "authenticated", userA, () => c.query("select fn_public_nickname($1)", [userA])));
      expect(helper?.message).toMatch(/permission denied/);
    });
  });

  describe("fn_daily_activity", () => {
    it("every date of the range, oldest first, 0 where nothing was recorded", async () => {
      const days = await daily(userA, HCM, "2026-11-19", "2026-11-22");
      expect(days.map((x) => x.date)).toEqual(["2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22"]);
      expect(byDate(days)).toMatchObject({ "2026-11-19": 0, "2026-11-22": 0 });
    });

    it("an interval across local midnight is split at it; overlapping tabs count once; other users never count", async () => {
      expect(byDate(await daily(userA, HCM, "2026-11-19", "2026-11-22"))).toEqual({
        "2026-11-19": 0,
        "2026-11-20": 600, // 23:50–00:00
        "2026-11-21": 1200, // 00:00–00:20 (the two tabs overlap 00:00–00:10)
        "2026-11-22": 0,
      });
      // The same time is one UTC day.
      expect(byDate(await daily(userA, "UTC", "2026-11-20", "2026-11-21"))).toEqual({ "2026-11-20": 1800, "2026-11-21": 0 });
    });

    it("the days add up to the Dashboard's Est. active practice (same union rule)", async () => {
      const summary = await rpcAs<{ activeTime: { activeSec: number } }>(c, userA, "select fn_dashboard_summary()");
      const days = await daily(userA, HCM, "2026-11-01", "2026-11-30");
      expect(days.reduce((sum, x) => sum + Number(x.activeSec), 0)).toBe(Number(summary.activeTime.activeSec));
    });

    it("DST days are their real length: 23 h on 8 Mar, 25 h on 1 Nov (New York)", async () => {
      const spring = byDate(await daily(userDst, NY, "2026-03-07", "2026-03-09"));
      expect(spring).toEqual({ "2026-03-07": 0, "2026-03-08": 23 * 3600, "2026-03-09": 0 });
      const fall = byDate(await daily(userDst, NY, "2026-10-31", "2026-11-02"));
      expect(fall).toEqual({ "2026-10-31": 0, "2026-11-01": 25 * 3600, "2026-11-02": 0 });
    });

    it("31 days at most; the range must be in order; the zone must be a real IANA name", async () => {
      expect(await daily(userA, HCM, "2026-11-01", "2026-12-01")).toHaveLength(31);
      for (const [tz, from, to] of [
        [HCM, "2026-11-01", "2026-12-02"],
        [HCM, "2026-11-22", "2026-11-21"],
        ["Mars/Olympus", "2026-11-20", "2026-11-21"],
        ["UTC+7", "2026-11-20", "2026-11-21"],
        [null, "2026-11-20", "2026-11-21"],
      ] as const) {
        expect((await errorOf(daily(userA, tz, from, to)))?.message).toBe("invalid_payload");
      }
    });
  });
});
