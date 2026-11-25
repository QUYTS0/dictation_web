/**
 * Migration 050 on real PostgreSQL (dashboard redesign Phase 7, D2/D5–D7):
 * joining, the lazy rollover (promotion, demotion, the small-group and
 * Bronze/Master rules, hidden members, idempotence under a race), live
 * zones, kudos, the all-time snapshot, privacy (no ids or emails in any
 * board, no table access) and the League achievement — executed under the
 * real `authenticated` role the way PostgREST runs it.
 *
 * Upgrade path: 001–049 with the activated cutover, then 050. League state
 * for past weeks is seeded directly (as the owner), with practice records
 * dated inside those weeks so XP is calculated exactly as in production.
 * Skipped unless LOCALDB_ADMIN_URL is set.
 */
import {
  HAS_LOCALDB,
  applyMigration,
  asRole,
  backendPid,
  beginAs,
  createTestDb,
  createUser,
  errorOf,
  rpcAs,
  runCutover,
  waitUntilBlocked,
  type PgClient,
  type TestDb,
} from "./localdb/harness";

const d = HAS_LOCALDB ? describe : describe.skip;
if (!HAS_LOCALDB) console.warn("[leagues] skipped — LOCALDB_ADMIN_URL not set");

type Row = { rank: number; memberKey: string; name: string; weekXp: number; streakDays: number; kudos: number; youGaveKudos: boolean; isYou: boolean; zone: string };
type Board = {
  scope: string;
  status: string;
  tier: number;
  weekStart: string;
  weekEndsAt: string;
  displayName: string;
  rows: Row[];
  you: { rank: number; totalXp: number } | null;
  lastWeek: { weekStart: string; tier: number; outcome: string; finalRank: number | null; xp: number | null } | null;
  refreshedAt?: string | null;
};

// This league week's Monday 00:00 UTC (as an SQL expression).
const W = "(date_trunc('week', now() at time zone 'UTC') at time zone 'UTC')";

d("050 — leagues (real PostgreSQL)", () => {
  let db: TestDb;
  let c: PgClient;
  let video = 0;
  const allUsers: string[] = [];

  const user = async () => {
    const u = await createUser(c);
    allUsers.push(u);
    return u;
  };
  /** `sentences` first answers at `at` → XP = 10·sentences + 10 (that UTC day's active-day bonus). */
  const practice = async (u: string, atSql: string, sentences: number) => {
    const r = (await c.query("insert into learning_sessions (user_id, youtube_video_id) values ($1, $2) returning id", [u, `v${video++}`])).rows[0].id;
    await c.query(
      `insert into attempt_logs (session_id, segment_index, expected_text, user_text, is_correct, created_at)
       select $1, n, 'a', 'b', false, ${atSql} from generate_series(0, $2 - 1) n`,
      [r, sentences]
    );
  };
  const weekKey = async (weeks: number) =>
    (await c.query(`select to_char(date_trunc('week', now() at time zone 'UTC') + make_interval(days => $1), 'YYYY-MM-DD') as d`, [7 * weeks])).rows[0].d as string;
  /** Seeds a group directly: members in `users` order join a minute apart. */
  const seedGroup = async (week: string, tier: number, members: string[]) => {
    await c.query("insert into league_weeks (week_start) values ($1) on conflict do nothing", [week]);
    const g = (await c.query("insert into league_groups (week_start, tier) values ($1, $2) returning id", [week, tier])).rows[0].id as string;
    for (let i = 0; i < members.length; i++) {
      await c.query("insert into user_league_state (user_id, tier) values ($1, $2) on conflict (user_id) do update set tier = excluded.tier", [members[i], tier]);
      await c.query(
        `insert into league_members (week_start, group_id, user_id, joined_at) values ($1, $2, $3, ${W} - interval '7 days' + make_interval(mins => $4))`,
        [week, g, members[i], i]
      );
    }
    return g;
  };
  const board = (u: string, scope = "week") => rpcAs<Board>(c, u, "select fn_league_board($1)", [scope]);
  const kudos = (u: string, key: string) => rpcAs<{ ok: boolean; kudos: number }>(c, u, "select fn_league_give_kudos($1)", [key]);
  const state = async (u: string) => (await c.query("select tier from user_league_state where user_id = $1", [u])).rows[0]?.tier as number | undefined;
  const member = async (u: string, week: string) =>
    (await c.query("select final_rank, final_xp, outcome from league_members where user_id = $1 and week_start = $2", [u, week])).rows[0];
  const hide = (u: string, hidden = true) => c.query("update users set leaderboard_hidden = $2 where id = $1", [u, hidden]);
  const noIdsOrEmails = (b: unknown) => {
    const s = JSON.stringify(b);
    for (const u of allUsers) expect(s).not.toContain(u);
    expect(s).not.toMatch(/@|email|userId|user_id|avatar/i);
  };

  let lastWeek: string;
  let thisWeek: string;
  const silver12: string[] = []; // last week, Silver, XP 20…130 (index 0 = 1 sentence)
  let silverHidden: string;
  const bronze4: string[] = [];
  const master2: string[] = [];
  const g10: string[] = []; // this week, Silver, 10 members; g10[4] is the viewer
  let newcomer: string;
  let newcomer2: string;
  let idle: string;
  let hiddenLearner: string;
  let dayRules: string;
  let daysBefore050: unknown;

  beforeAll(async () => {
    db = await createTestDb("league050", 49);
    c = await db.connect();
    await runCutover(c, "activated");

    // Every source of 046's day rule, read BEFORE 050 rewrites fn_activity_days.
    dayRules = await user();
    const at = (iso: string) => Date.parse(iso) / 1000;
    const local = (
      await c.query(
        `insert into study_sessions (user_id, youtube_video_id, activity_intervals, last_activity_at) values ($1, 'vD', $2::jsonb, now()) returning id`,
        [dayRules, JSON.stringify([{ start: at("2026-11-20T16:50:00Z"), end: at("2026-11-20T17:10:00Z") }])]
      )
    ).rows[0].id;
    await c.query(
      `insert into activity_flush_log (study_session_id, flush_batch_id, kind, payload_fingerprint, client_timezone, activity_dates, day_basis, processed_at)
       values ($1, gen_random_uuid(), 'activity', 'fp', 'Asia/Ho_Chi_Minh', array['2026-11-20'::date, '2026-11-21'::date], 'local', '2026-11-20T17:10:00Z')`,
      [local]
    );
    await c.query(`insert into study_sessions (user_id, youtube_video_id, activity_intervals, last_activity_at) values ($1, 'vE', $2::jsonb, now())`, [
      dayRules,
      JSON.stringify([{ start: at("2026-11-15T23:50:00Z"), end: at("2026-11-16T00:10:00Z") }]), // undated: UTC days
    ]);
    const r = (await c.query("insert into learning_sessions (user_id, youtube_video_id) values ($1, 'vD') returning id", [dayRules])).rows[0].id;
    await c.query(
      `insert into attempt_logs (session_id, segment_index, expected_text, user_text, is_correct, study_session_id, created_at)
       values ($1, 0, 'a', 'a', true, $2, '2026-11-22T18:00:00Z'), ($1, 1, 'a', 'a', true, null, '2026-11-10T10:00:00Z')`,
      [r, local]
    );
    await c.query(
      `insert into vocabulary_reviews (user_id, grade, reviewed_at, client_timezone)
       values ($1, 'good', '2026-11-05T20:00:00Z', 'Asia/Ho_Chi_Minh'), ($1, 'good', '2026-11-03T20:00:00Z', null)`,
      [dayRules]
    );
    daysBefore050 = await rpcAs(c, dayRules, "select fn_activity_days()");

    await applyMigration(c, 50);
    [lastWeek, thisWeek] = [await weekKey(-1), await weekKey(0)];
    const lastFriday = `${W} - interval '3 days'`;

    // Last week, Silver (12 ranked + 1 hidden): practice N = 1…12 sentences.
    for (let n = 1; n <= 12; n++) {
      const u = await user();
      await practice(u, lastFriday, n);
      silver12.push(u);
    }
    silverHidden = await user();
    await practice(silverHidden, lastFriday, 50); // would win — but is hidden at rollover
    await seedGroup(lastWeek, 2, [...silver12, silverHidden]);
    await hide(silverHidden);

    // Last week, Bronze (4): a tie between the 2nd and 3rd — the earlier joiner ranks higher.
    for (const n of [5, 3, 3, 1]) {
      const u = await user();
      await practice(u, lastFriday, n);
      bronze4.push(u);
    }
    await seedGroup(lastWeek, 1, bronze4);

    // Last week, Master (2): nobody moves up from Master.
    for (const n of [9, 1]) {
      const u = await user();
      await practice(u, lastFriday, n);
      master2.push(u);
    }
    await seedGroup(lastWeek, 6, master2);

    // This week, Silver, 10 members practicing now (XP 20…110).
    for (let n = 1; n <= 10; n++) {
      const u = await user();
      await practice(u, "now()", n);
      g10.push(u);
    }
    await seedGroup(thisWeek, 2, g10);
    await c.query("update users set public_name = 'Mai' where id = $1", [g10[9]]);

    // This week, a full Bronze group of 30 (no XP needed for seeded members).
    const full: string[] = [];
    for (let i = 0; i < 30; i++) full.push(await user());
    await seedGroup(thisWeek, 1, full);

    newcomer = await user();
    await practice(newcomer, "now()", 2);
    newcomer2 = await user();
    await practice(newcomer2, "now()", 1);
    idle = await user();
    hiddenLearner = await user();
    await practice(hiddenLearner, "now()", 40);
    await hide(hiddenLearner);
  }, 600_000);
  afterAll(async () => {
    await c?.end();
    await db?.drop();
  });

  it("fn_activity_days() after 050 returns exactly what 049's returned, across every day rule", async () => {
    const after = (await rpcAs(c, dayRules, "select fn_activity_days()")) as { days: string[]; utcFallbackDays: string[] };
    expect(after).toEqual(daysBefore050);
    // Local batch dates, the session's local answer, the undated session's UTC days, a UTC answer, local + UTC reviews.
    expect(after.days).toEqual(["2026-11-23", "2026-11-21", "2026-11-20", "2026-11-16", "2026-11-15", "2026-11-10", "2026-11-06", "2026-11-03"]);
    expect(after.utcFallbackDays).toEqual(["2026-11-16", "2026-11-15", "2026-11-10", "2026-11-03"]);
  });

  it("fn_activity_days() still returns the caller's days (now via fn_activity_days_of)", async () => {
    const own = await rpcAs(c, silver12[0], "select fn_activity_days()");
    const of = (await c.query("select fn_activity_days_of($1) as r", [silver12[0]])).rows[0].r;
    expect(own).toEqual(of);
    expect((of as { days: string[] }).days).toHaveLength(1);
  });

  describe("rollover (lazy, on the first board read of the week)", () => {
    beforeAll(async () => {
      await board(idle); // any read finalizes past weeks
    });

    it("Silver, 12 ranked: top 3 move up, bottom 3 move down, the rest stay; ranks and XP recorded", async () => {
      expect(await member(silver12[11], lastWeek)).toEqual({ final_rank: 1, final_xp: 130, outcome: "promoted" });
      expect(await member(silver12[9], lastWeek)).toEqual({ final_rank: 3, final_xp: 110, outcome: "promoted" });
      expect(await member(silver12[8], lastWeek)).toEqual({ final_rank: 4, final_xp: 100, outcome: "stayed" });
      expect(await member(silver12[2], lastWeek)).toEqual({ final_rank: 10, final_xp: 40, outcome: "demoted" });
      expect(await member(silver12[0], lastWeek)).toEqual({ final_rank: 12, final_xp: 20, outcome: "demoted" });
      expect([await state(silver12[11]), await state(silver12[8]), await state(silver12[0])]).toEqual([3, 2, 1]);
      expect(Number((await c.query("select count(*) as n from league_weeks where week_start = $1 and finalized_at is not null", [lastWeek])).rows[0].n)).toBe(1);
    });

    it("a member hidden at rollover is not ranked and keeps the tier", async () => {
      expect(await member(silverHidden, lastWeek)).toMatchObject({ final_rank: null, outcome: "stayed" });
      expect(await state(silverHidden)).toBe(2);
    });

    it("a group under 10 demotes nobody; a tie goes to the earlier joiner; Bronze can't go lower", async () => {
      expect((await Promise.all(bronze4.map((u) => member(u, lastWeek)))).map((m) => [m.final_rank, m.outcome])).toEqual([
        [1, "promoted"],
        [2, "promoted"],
        [3, "promoted"],
        [4, "stayed"],
      ]);
      expect(await state(bronze4[3])).toBe(1);
    });

    it("nobody moves up from Master", async () => {
      expect((await member(master2[0], lastWeek)).outcome).toBe("stayed");
      expect(await state(master2[0])).toBe(6);
    });

    it("a second read changes nothing (idempotent)", async () => {
      const before = (await c.query("select user_id, tier from user_league_state order by user_id")).rows;
      await board(idle);
      expect((await c.query("select user_id, tier from user_league_state order by user_id")).rows).toEqual(before);
    });

    it("the result is the learner's lastWeek on the board", async () => {
      const b = await board(silver12[11]);
      expect(b.lastWeek).toEqual({ weekStart: lastWeek, tier: 2, outcome: "promoted", finalRank: 1, xp: 130 });
    });
  });

  describe("joining this week", () => {
    it("XP this week → joins their tier; a full group (30) is never overfilled — the next one opens", async () => {
      const b = await board(newcomer);
      expect(b).toMatchObject({ status: "member", tier: 1, weekStart: thisWeek });
      expect(b.rows).toHaveLength(1);
      expect(b.rows[0]).toMatchObject({ rank: 1, isYou: true, weekXp: 30, zone: "promotion", name: expect.stringMatching(/^Learner [0-9A-F]{5}$/) });
      expect(b.displayName).toBe(b.rows[0].name);
      const b2 = await board(newcomer2);
      expect(b2.rows.map((r) => r.weekXp)).toEqual([30, 20]); // same new group
      const sizes = (await c.query("select count(*)::int as n from league_members m join league_groups g on g.id = m.group_id where g.week_start = $1 and g.tier = 1 group by g.id order by n desc", [thisWeek])).rows.map((r) => r.n);
      expect(sizes).toEqual([30, 2]);
    });

    it("no XP this week → not joined, nothing shown", async () => {
      expect(await board(idle)).toMatchObject({ status: "not_joined", tier: 1, rows: [], you: null });
      expect((await c.query("select 1 from league_members where user_id = $1 and week_start = $2", [idle, thisWeek])).rowCount).toBe(0);
    });

    it("hidden → never joined, and sees no board (week or all time)", async () => {
      expect(await board(hiddenLearner)).toMatchObject({ status: "hidden", rows: [], you: null });
      expect(await board(hiddenLearner, "all")).toMatchObject({ status: "hidden", rows: [] });
      expect((await c.query("select 1 from league_members where user_id = $1", [hiddenLearner])).rowCount).toBe(0);
    });

    it("weekEndsAt is next Monday 00:00 UTC", async () => {
      const b = await board(newcomer);
      const next = await weekKey(1);
      expect(new Date(b.weekEndsAt).toISOString()).toBe(`${next}T00:00:00.000Z`);
    });
  });

  describe("the week board", () => {
    it("ranked by this week's XP; live zones (top 3 up, bottom 3 down in a group of ≥ 10); public name or nickname; no ids or emails", async () => {
      const b = await board(g10[4]);
      expect(b).toMatchObject({ status: "member", tier: 2 });
      expect(b.rows.map((r) => r.weekXp)).toEqual([110, 100, 90, 80, 70, 60, 50, 40, 30, 20]);
      expect(b.rows.map((r) => r.zone)).toEqual(["promotion", "promotion", "promotion", "safe", "safe", "safe", "safe", "demotion", "demotion", "demotion"]);
      expect(b.rows[0].name).toBe("Mai");
      expect(b.rows.filter((r) => r.isYou).map((r) => r.rank)).toEqual([6]);
      expect(b.rows.every((r) => r.streakDays === 1)).toBe(true); // each practiced today
      noIdsOrEmails(b);
    });

    it("kudos: once per member per week, same group only, never yourself", async () => {
      const b = await board(g10[4]);
      const top = b.rows[0];
      expect(await kudos(g10[4], top.memberKey)).toEqual({ ok: true, kudos: 1 });
      expect(await kudos(g10[4], top.memberKey)).toEqual({ ok: true, kudos: 1 }); // again: no change
      expect(await kudos(g10[3], top.memberKey)).toEqual({ ok: true, kudos: 2 });
      const after = await board(g10[4]);
      expect(after.rows[0]).toMatchObject({ kudos: 2, youGaveKudos: true });
      expect(after.rows[1]).toMatchObject({ kudos: 0, youGaveKudos: false });

      const self = after.rows.find((r) => r.isYou)!.memberKey;
      expect((await errorOf(kudos(g10[4], self)))?.message).toBe("invalid_payload");
      const otherGroup = (await board(newcomer)).rows[0].memberKey;
      expect((await errorOf(kudos(g10[4], otherGroup)))?.message).toBe("invalid_payload");
      expect((await errorOf(kudos(idle, top.memberKey)))?.message).toBe("invalid_payload"); // not a member this week
    });

    it("hiding mid-week: off the board and can't receive kudos; the membership row stays", async () => {
      const key = (await board(g10[4])).rows[1].memberKey; // g10[8]
      await hide(g10[8]);
      const b = await board(g10[4]);
      expect(b.rows).toHaveLength(9);
      expect(b.rows.some((r) => r.memberKey === key)).toBe(false);
      expect(b.rows.map((r) => r.zone).filter((z) => z === "demotion")).toEqual([]); // 9 visible: no demotion zone
      expect((await errorOf(kudos(g10[4], key)))?.message).toBe("invalid_payload");
      expect((await c.query("select 1 from league_members where user_id = $1 and week_start = $2", [g10[8], thisWeek])).rowCount).toBe(1);
      await hide(g10[8], false);
    });
  });

  describe("all time", () => {
    it("global top 5 by total XP and your rank; hidden learners left out; no ids or emails", async () => {
      const b = await board(g10[4], "all");
      expect(b.status).toBe("member");
      expect(b.rows).toHaveLength(5);
      const totals = b.rows.map((r) => (r as unknown as { totalXp: number }).totalXp);
      expect(totals).toEqual([...totals].sort((x, y) => y - x));
      expect(totals[0]).toBe(130); // the hidden learners' 410 and 510 are not on it
      expect(b.you).toMatchObject({ totalXp: 60 });
      expect(b.refreshedAt).toBeTruthy();
      noIdsOrEmails(b);
    });

    it("a snapshot at most an hour old is served as is; an older one is recomputed", async () => {
      const first = (await board(newcomer, "all")).refreshedAt;
      expect((await board(newcomer, "all")).refreshedAt).toBe(first);
      await c.query("update leaderboard_alltime_refresh set refreshed_at = now() - interval '2 hours'");
      expect((await board(newcomer, "all")).refreshedAt).not.toBe(first);
    });

    it("an unknown scope is refused", async () => {
      expect((await errorOf(board(newcomer, "month")))?.message).toBe("invalid_payload");
    });
  });

  describe("a rollover raced by two reads", () => {
    it("finalizes once: the second read waits for the first and then finds nothing to do", async () => {
      const old = await user();
      const twoWeeksAgo = await weekKey(-2);
      await practice(old, `${W} - interval '10 days'`, 3);
      await seedGroup(twoWeeksAgo, 1, [old]);
      await c.query("update league_members set joined_at = $3::date where user_id = $1 and week_start = $2", [old, twoWeeksAgo, twoWeeksAgo]);

      const c2 = await db.connect();
      const observer = await db.connect();
      try {
        await beginAs(c, "authenticated", idle);
        await c.query("select fn_league_board('week')");
        const pid2 = await backendPid(c2);
        const second = (async () => {
          await beginAs(c2, "authenticated", newcomer);
          await c2.query("select fn_league_board('week')");
          await c2.query("commit");
        })();
        await waitUntilBlocked(observer, pid2);
        await c.query("commit");
        await second;
      } finally {
        await c2.end();
        await observer.end();
      }
      expect(await state(old)).toBe(2); // promoted exactly once
      expect((await member(old, twoWeeksAgo)).outcome).toBe("promoted");
    });
  });

  describe("access and achievements", () => {
    it("no league table is readable or writable by an application role; the helpers are internal", async () => {
      for (const t of ["user_league_state", "league_weeks", "league_groups", "league_members", "league_kudos", "leaderboard_alltime"]) {
        expect((await errorOf(asRole(c, "authenticated", newcomer, () => c.query(`select * from ${t}`))))?.message).toMatch(/permission denied/);
      }
      expect((await errorOf(asRole(c, "authenticated", newcomer, () => c.query("select fn_league_rollover()"))))?.message).toMatch(/permission denied/);
      expect((await errorOf(asRole(c, "authenticated", newcomer, () => c.query("select fn_activity_days_of($1)", [newcomer]))))?.message).toMatch(/permission denied/);
      expect((await errorOf(asRole(c, "anon", null, () => c.query("select fn_league_board('week')"))))?.message).toMatch(/permission denied/);
      expect((await errorOf(asRole(c, "authenticated", null, () => c.query("select fn_league_board('week')"))))?.message).toBe("authentication_required");
    });

    it("League achievement: moved up from Silver to Gold → Silver and Gold reached", async () => {
      const s = await rpcAs<{ tracks: Array<{ track: string; value: number }>; newlyUnlocked: Array<{ track: string; tier: number }> }>(
        c,
        silver12[11],
        "select fn_sync_achievements()"
      );
      expect(Number(s.tracks.find((t) => t.track === "league")!.value)).toBe(3);
      expect(s.newlyUnlocked.filter((u) => u.track === "league").map((u) => u.tier)).toEqual([1, 2]);
      const bronze = await rpcAs<{ tracks: Array<{ track: string; value: number }> }>(c, bronze4[3], "select fn_sync_achievements()");
      expect(Number(bronze.tracks.find((t) => t.track === "league")!.value)).toBe(1);
    });
  });
});
