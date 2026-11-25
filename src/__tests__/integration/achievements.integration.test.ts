/**
 * Migration 049 on real PostgreSQL (dashboard redesign Phase 6, D2): the
 * seeded tiers, fn_sync_achievements (server-computed metrics, idempotent,
 * announced once even under a race), unlocks that survive a dropping count,
 * no client write path, and the SQL streak helpers' parity with
 * src/lib/utils/streak.ts — executed under the real `authenticated` role.
 *
 * Upgrade path: 001–048 with the activated cutover, practice seeded BEFORE
 * 049, then 049. Skipped unless LOCALDB_ADMIN_URL is set.
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
import { computeStreakFromDays, previousDayKey } from "@/lib/utils/streak";

const d = HAS_LOCALDB ? describe : describe.skip;
if (!HAS_LOCALDB) console.warn("[achievements] skipped — LOCALDB_ADMIN_URL not set");

type Tier = { tier: number; threshold: number; unlockedAt: string | null };
type Track = { track: string; value: number; tiers: Tier[] };
type Sync = { tracks: Track[]; newlyUnlocked: Array<{ track: string; tier: number; unlockedAt: string }> };

d("049 — achievements (real PostgreSQL)", () => {
  let db: TestDb;
  let c: PgClient;
  let userA: string; // something in every track
  let userB: string; // nothing yet
  let userRace: string;

  const sync = (user: string) => rpcAs<Sync>(c, user, "select fn_sync_achievements()");
  const track = (s: Sync, name: string) => s.tracks.find((t) => t.track === name)!;
  const unlockedTiers = (t: Track) => t.tiers.filter((x) => x.unlockedAt).map((x) => x.tier);

  const reviewDays = (user: string, daysAgo: number[]) =>
    c.query(
      `insert into vocabulary_reviews (user_id, grade, reviewed_at, client_timezone)
       select $1, 'good', (date_trunc('day', now() at time zone 'UTC') + interval '12 hours' - make_interval(days => n)) at time zone 'UTC', 'UTC'
         from unnest($2::int[]) n`,
      [user, daysAgo]
    );
  const words = (user: string, count: number, prefix: string) =>
    c.query(
      `insert into vocabulary_items (user_id, video_id, segment_index, term, normalized_term, sentence_context)
       select $1, 'vid1', 0, $3 || n, $3 || n, 'ctx' from generate_series(1, $2) n`,
      [user, count, prefix]
    );

  beforeAll(async () => {
    db = await createTestDb("ach049", 48);
    c = await db.connect();
    await runCutover(c, "activated");
    [userA, userB, userRace] = [await createUser(c), await createUser(c), await createUser(c)];

    // Flame Keeper: word-review-only days 10, 9, 8 days ago (a 3-day run), then 5 and 4.
    await reviewDays(userA, [10, 9, 8, 5, 4]);
    // Lexicon: 25 saved words.
    await words(userA, 25, "w");
    // Precision Typist: 25 sentences whose latest answer is correct, one whose latest is wrong.
    const round = (await c.query(`insert into learning_sessions (user_id, youtube_video_id) values ($1, 'vA') returning id`, [userA])).rows[0].id;
    await c.query(
      `insert into attempt_logs (session_id, segment_index, expected_text, user_text, is_correct, created_at)
       select $1, n, 'a', 'a', true, now() - interval '1 hour' from generate_series(0, 24) n`,
      [round]
    );
    await c.query(
      `insert into attempt_logs (session_id, segment_index, expected_text, user_text, is_correct, created_at)
       values ($1, 25, 'a', 'a', true, now() - interval '2 hours'), ($1, 25, 'a', 'b', false, now() - interval '1 hour')`,
      [round]
    );
    // Shadow Master: 10 Azure-scored sentences (a sentence's second take counts once).
    await c.query(
      `insert into shadowing_attempts (user_id, round_id, youtube_video_id, segment_index, recording_duration_sec, is_practice_valid,
                                       azure_eval_status, azure_pronunciation_score)
       select $1, $2, 'vA', n % 10, 3, true, 'completed', 70 from generate_series(0, 10) n`,
      [userA, round]
    );
    // Immersion: 1 h 1 min of engaged time.
    await c.query(`insert into study_sessions (user_id, youtube_video_id, activity_intervals) values ($1, 'vA', $2::jsonb)`, [
      userA,
      JSON.stringify([{ start: 1_763_000_000, end: 1_763_000_000 + 3660 }]),
    ]);
    // The race learner: 3 consecutive review days.
    await reviewDays(userRace, [3, 2, 1]);

    await applyMigration(c, 49);
  }, 300_000);
  afterAll(async () => {
    await c?.end();
    await db?.drop();
  });

  it("seeds 5 tracks × 4 tiers; re-applying 049 keeps every unlock", async () => {
    expect(Number((await c.query("select count(*) as n from achievement_tiers")).rows[0].n)).toBe(20);
    expect((await c.query("select threshold from achievement_tiers where track = 'immersion' order by tier")).rows.map((r) => Number(r.threshold))).toEqual([1, 5, 20, 50]);
  });

  describe("fn_sync_achievements", () => {
    it("first sync: every metric computed server-side; each met tier recorded and announced once, in track order", async () => {
      const s = await sync(userA);
      expect(s.tracks.map((t) => [t.track, Number(t.value)])).toEqual([
        ["flame_keeper", 3],
        ["precision_typist", 25],
        ["shadow_master", 10],
        ["lexicon", 25],
        ["immersion", 1.02],
      ]);
      expect(s.newlyUnlocked.map((u) => [u.track, u.tier])).toEqual([
        ["flame_keeper", 1],
        ["precision_typist", 1],
        ["shadow_master", 1],
        ["lexicon", 1],
        ["immersion", 1],
      ]);
      for (const t of s.tracks) expect(unlockedTiers(t)).toEqual([1]);
      expect(track(s, "flame_keeper").tiers.map((t) => Number(t.threshold))).toEqual([3, 7, 14, 30]);
    });

    it("a second sync records and announces nothing new (idempotent); a learner with nothing has every tier locked", async () => {
      const again = await sync(userA);
      expect(again.newlyUnlocked).toEqual([]);
      expect(track(again, "lexicon").tiers[0].unlockedAt).not.toBeNull();
      const empty = await sync(userB);
      expect(empty.newlyUnlocked).toEqual([]);
      expect(empty.tracks.every((t) => unlockedTiers(t).length === 0)).toBe(true);
    });

    it("an unlocked tier stays unlocked when its count drops (deleted words)", async () => {
      await c.query("delete from vocabulary_items where id in (select id from vocabulary_items where user_id = $1 limit 5)", [userA]);
      const s = await sync(userA);
      expect(Number(track(s, "lexicon").value)).toBe(20);
      expect(unlockedTiers(track(s, "lexicon"))).toEqual([1]);
    });

    it("crossing the next threshold announces only that tier", async () => {
      await reviewDays(userA, [7, 6]); // 10…4 days ago is now a 7-day run
      const s = await sync(userA);
      expect(s.newlyUnlocked.map((u) => [u.track, u.tier])).toEqual([["flame_keeper", 2]]);
      expect(Number(track(s, "flame_keeper").value)).toBe(7);
    });

    it("two syncs at once: the tier is recorded once and announced by exactly one of them", async () => {
      const c2 = await db.connect();
      const observer = await db.connect();
      try {
        await beginAs(c, "authenticated", userRace);
        const first = (await c.query("select fn_sync_achievements() as r")).rows[0].r as Sync;
        const pid2 = await backendPid(c2);
        const second = (async () => {
          await beginAs(c2, "authenticated", userRace);
          const r = (await c2.query("select fn_sync_achievements() as r")).rows[0].r as Sync;
          await c2.query("commit");
          return r;
        })();
        await waitUntilBlocked(observer, pid2);
        await c.query("commit");
        expect(first.newlyUnlocked.map((u) => [u.track, u.tier])).toEqual([["flame_keeper", 1]]);
        expect((await second).newlyUnlocked).toEqual([]);
        expect(Number((await c.query("select count(*) as n from user_achievements where user_id = $1", [userRace])).rows[0].n)).toBe(1);
      } finally {
        await c2.end();
        await observer.end();
      }
    });

    it("anon can't call it; authenticated without a user is refused", async () => {
      expect((await errorOf(asRole(c, "anon", null, () => c.query("select fn_sync_achievements()"))))?.message).toMatch(/permission denied/);
      expect((await errorOf(asRole(c, "authenticated", null, () => c.query("select fn_sync_achievements()"))))?.message).toBe("authentication_required");
    });
  });

  describe("access", () => {
    it("a learner reads only their own unlocks and can write none — no insert, update or delete", async () => {
      const seen = await asRole(c, "authenticated", userB, async () => (await c.query("select distinct user_id from user_achievements")).rows);
      expect(seen).toEqual([]);
      for (const sql of [
        `insert into user_achievements (user_id, track, tier) values ('${userB}', 'lexicon', 4)`,
        `update user_achievements set tier = 4 where user_id = '${userA}'`,
        `delete from user_achievements where user_id = '${userA}'`,
        `insert into achievement_tiers (track, tier, threshold) values ('league', 1, 1)`,
        `update achievement_tiers set threshold = 1`,
      ]) {
        expect((await errorOf(asRole(c, "authenticated", userA, () => c.query(sql))))?.message).toMatch(/permission denied/);
      }
      const tiers = await asRole(c, "authenticated", userB, async () => (await c.query("select count(*) as n from achievement_tiers")).rows[0].n);
      expect(Number(tiers)).toBe(20);
      expect((await errorOf(asRole(c, "anon", null, () => c.query("select * from user_achievements"))))?.message).toMatch(/permission denied/);
    });
  });

  describe("SQL streak helpers ↔ src/lib/utils/streak.ts", () => {
    // Deterministic pseudo-random day sets around a fixed "today".
    let seed = 42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const today = "2026-11-25";
    const daySet = () => {
      const out: string[] = [];
      let day = today;
      for (let i = 0; i < 40; i++) {
        if (rand() < 0.6) out.push(day);
        if (rand() < 0.15) out.push(day); // duplicates
        day = previousDayKey(day);
      }
      return out;
    };
    const longestJs = (days: string[]) => {
      const sorted = [...new Set(days)].sort();
      let best = 0;
      let run = 0;
      for (let i = 0; i < sorted.length; i++) {
        run = i > 0 && previousDayKey(sorted[i]) === sorted[i - 1] ? run + 1 : 1;
        best = Math.max(best, run);
      }
      return best;
    };

    it("fn_streak_from_days matches computeStreakFromDays; fn_longest_streak matches the longest run (200 random sets + edge cases)", async () => {
      const cases = [[], [today], [previousDayKey(today)], [previousDayKey(previousDayKey(today))], ...Array.from({ length: 200 }, daySet)];
      for (const days of cases) {
        const r = (await c.query("select fn_streak_from_days($1::date[], $2::date) as s, fn_longest_streak($1::date[]) as l", [days, today])).rows[0];
        expect([r.s, r.l]).toEqual([computeStreakFromDays(days, today), longestJs(days)]);
      }
    });

    it("both are internal", async () => {
      for (const sql of ["select fn_longest_streak(array[current_date])", "select fn_streak_from_days(array[current_date], current_date)"]) {
        expect((await errorOf(asRole(c, "authenticated", userA, () => c.query(sql))))?.message).toMatch(/permission denied/);
      }
    });
  });
});
