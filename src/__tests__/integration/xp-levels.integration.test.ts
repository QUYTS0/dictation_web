/**
 * Migration 048 on real PostgreSQL (dashboard redesign Phase 5, D1): XP
 * calculated from stored records — each rule pays its first occurrence
 * only, the vocabulary cap, the active-day bonus, the learner's XP zone,
 * the league week (UTC) and fn_my_xp's aggregation — executed under the
 * real `authenticated` role the way PostgREST runs it.
 *
 * Upgrade path: 001–047 with the activated cutover, practice seeded BEFORE
 * 048 (XP needs no backfill), then 048. Skipped unless LOCALDB_ADMIN_URL is set.
 */
import { randomUUID } from "crypto";
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
if (!HAS_LOCALDB) console.warn("[xp-levels] skipped — LOCALDB_ADMIN_URL not set");

type Event = { at: string; source: string; amount: number };
type XpDay = { date: string; xp: number; activity: { dictationSentences: number; shadowingSentences: number; wordsReviewed: number; listeningMin: number } };
type MyXp = {
  rulesVersion: number;
  timeZone: string;
  xpTimeZone: string;
  today: string;
  totalXp: number;
  todayXp: number;
  leagueWeekStart: string;
  leagueWeekXp: number;
  lastLeagueWeek: { weekStart: string; xp: number; activeSec: number; wordsReviewed: number };
  days: XpDay[];
};

const HCM = "Asia/Ho_Chi_Minh";
const NY = "America/New_York";
// 10:00 in Ho Chi Minh, 03:00 UTC — the same calendar day everywhere used here.
const T = "2026-11-10T03:00:00Z";
const plus = (iso: string, minutes: number) => new Date(Date.parse(iso) + minutes * 60_000).toISOString();
const at = (iso: string) => Date.parse(iso) / 1000;

d("048 — XP and levels (real PostgreSQL)", () => {
  let db: TestDb;
  let c: PgClient;
  let userRules: string;
  let userVocab: string;
  let userListen: string;
  let userZone: string;
  let userWeek: string;
  let userRecent: string;
  let roundR1: string;

  const round = async (user: string, video: string, status = "active", provenance = "current", completedAt: string | null = null) =>
    (
      await c.query(
        `insert into learning_sessions (user_id, youtube_video_id, status, provenance, completed_at) values ($1, $2, $3, $4, $5) returning id`,
        [user, video, status, provenance, completedAt]
      )
    ).rows[0].id as string;
  const answer = (roundId: string, seg: number, correct: boolean, when: string, valid = true) =>
    c.query(
      `insert into attempt_logs (session_id, segment_index, expected_text, user_text, is_correct, is_practice_valid, created_at)
       values ($1, $2, 'a b', $3, $4, $5, ${when})`,
      [roundId, seg, correct ? "a b" : "a", correct, valid]
    );
  const take = (user: string, roundId: string, seg: number, when: string, score: number | null, valid = true) =>
    c.query(
      `insert into shadowing_attempts (user_id, round_id, youtube_video_id, segment_index, recording_duration_sec, is_practice_valid,
                                       azure_eval_status, azure_pronunciation_score, created_at)
       values ($1, $2, 'vA', $3, 3, $4, $5, $6, $7)`,
      [user, roundId, seg, valid, score === null ? "not_evaluated" : "completed", score, when]
    );
  const item = async (user: string, term: string) =>
    (
      await c.query(
        `insert into vocabulary_items (user_id, video_id, segment_index, term, normalized_term, sentence_context) values ($1, 'vid1', 0, $2, $2, $2) returning id`,
        [user, term]
      )
    ).rows[0].id as string;
  const review = (user: string, itemId: string | null, when: string, tz: string | null) =>
    c.query(`insert into vocabulary_reviews (user_id, item_id, grade, reviewed_at, client_timezone) values ($1, $2, 'good', ${when}, $3)`, [user, itemId, tz]);
  const session = async (user: string, intervals: Array<{ start: number; end: number }>, listeningSec = 0, startedAt = "now()") =>
    (
      await c.query(
        `insert into study_sessions (user_id, youtube_video_id, activity_intervals, listening_newly_covered_sec, started_at)
         values ($1, 'vid1', $2::jsonb, $3, ${startedAt}) returning id`,
        [user, JSON.stringify(intervals), listeningSec]
      )
    ).rows[0].id as string;

  const events = async (user: string, tz = "UTC"): Promise<Event[]> =>
    (
      await c.query(
        `select to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as at, source, amount
           from fn_xp_events($1, $2) order by occurred_at, source`,
        [user, tz]
      )
    ).rows;
  const myXp = (user: string, tz = "UTC") => rpcAs<MyXp>(c, user, "select fn_my_xp($1)", [tz]);
  const total = (evs: Event[]) => evs.reduce((s, e) => s + e.amount, 0);

  beforeAll(async () => {
    db = await createTestDb("xp048", 47);
    c = await db.connect();
    await runCutover(c, "activated");
    [userRules, userVocab, userListen, userZone, userWeek, userRecent] = await Promise.all(Array.from({ length: 6 }, () => createUser(c)));

    // --- Dictation, Shadowing, completion (all on 10 Nov, UTC) ----------
    roundR1 = await round(userRules, "vA", "completed", "current", plus(T, 60));
    const q = (iso: string) => `'${iso}'::timestamptz`;
    await answer(roundR1, 0, false, q(T)); //            first answer → +10
    await answer(roundR1, 0, false, q(plus(T, 1))); //    retry → nothing
    await answer(roundR1, 0, true, q(plus(T, 2))); //     first correct → +5
    await answer(roundR1, 0, true, q(plus(T, 3))); //     correct again → nothing
    await answer(roundR1, 1, true, q(plus(T, 4)), false); // not practice-valid → nothing
    await answer(roundR1, 1, false, q(plus(T, 5))); //    first valid answer → +10
    const legacy = await round(userRules, "vB", "completed", "legacy_unverified", plus(T, 30));
    await answer(legacy, 0, true, q(plus(T, 10))); //     legacy answers still pay sentence XP; no completion
    const abandoned = await round(userRules, "vC", "abandoned");
    await answer(abandoned, 0, false, q(plus(T, 12))); // +10; no completion
    await take(userRules, roundR1, 0, plus(T, 20), 70); //  first take → +10 (score < 80)
    await take(userRules, roundR1, 0, plus(T, 21), 85); //  first take >= 80 → +5
    await take(userRules, roundR1, 0, plus(T, 22), 95); //  nothing
    await take(userRules, roundR1, 1, plus(T, 23), 95, false); // not practice-valid → nothing

    // --- Vocabulary: 25 words on one Ho Chi Minh day, one of them 3 times --
    const words: string[] = [];
    for (let i = 0; i < 25; i++) words.push(await item(userVocab, `w${i}`));
    for (let i = 0; i < 25; i++) await review(userVocab, words[i], q(plus("2026-11-12T03:00:00Z", i)), HCM);
    await review(userVocab, words[0], q(plus("2026-11-12T03:00:00Z", 30)), HCM);
    await review(userVocab, words[0], q(plus("2026-11-12T03:00:00Z", 31)), HCM);
    // The next Ho Chi Minh day (17:30Z = 00:30 local), word 0 again → +3. In
    // UTC that would still be the 12th.
    await review(userVocab, words[0], q("2026-11-12T17:30:00Z"), HCM);
    // A deleted word's reviews still count.
    await review(userVocab, null, q("2026-11-12T17:31:00Z"), HCM);

    // --- Listening -------------------------------------------------------
    await session(userListen, [], 150, `'${T}'`); // 2 whole minutes → +2 at the session start
    await session(userListen, [], 59, `'${plus(T, 60)}'`); // under a minute → nothing

    // --- XP zone + an interval across New York midnight --------------------
    const s = await session(userZone, [{ start: at("2026-11-11T04:50:00Z"), end: at("2026-11-11T05:10:00Z") }]); // 23:50–00:10 NY
    await review(userZone, await item(userZone, "older"), q("2026-11-01T00:00:00Z"), HCM); // older, other zone
    await c.query(
      `insert into activity_flush_log (study_session_id, flush_batch_id, kind, payload_fingerprint, client_timezone, activity_dates, day_basis, processed_at)
       values ($1, $2, 'activity', 'fp', $3, array['2026-11-10'::date, '2026-11-11'::date], 'local', '2026-11-11T05:10:00Z')`,
      [s, randomUUID(), NY]
    );

    // --- League week boundary (Monday 00:00 UTC) ---------------------------
    const W = "(date_trunc('week', now() at time zone 'UTC') at time zone 'UTC')";
    const wr = await round(userWeek, "vW");
    await answer(wr, 0, false, `${W} - interval '1 second'`); // last week
    await answer(wr, 1, false, W); //                           this week (the boundary belongs to the new week)
    const [i1, i2] = [await item(userWeek, "one"), await item(userWeek, "two")];
    await review(userWeek, i1, `${W} - interval '2 days'`, "UTC");
    await review(userWeek, i2, `${W} - interval '2 days' + interval '1 minute'`, "UTC");
    await review(userWeek, i2, `${W} - interval '1 day'`, "UTC");
    const lo = (await c.query(`select extract(epoch from ${W})::float8 as w`)).rows[0].w as number;
    await session(userWeek, [
      { start: lo - 3 * 86400, end: lo - 3 * 86400 + 600 }, // Friday, 10 min
      { start: lo - 100, end: lo + 100 }, //                     across the boundary: 100 s each side
    ]);

    // --- Today -------------------------------------------------------------
    const rr = await round(userRecent, "vR");
    await answer(rr, 0, true, "now()");

    await applyMigration(c, 48);
  }, 300_000);
  afterAll(async () => {
    await c?.end();
    await db?.drop();
  });

  it("re-applying 048 is harmless (reads only)", async () => {
    const before = await events(userRules);
    await applyMigration(c, 48);
    expect(await events(userRules)).toEqual(before);
  });

  describe("rules v1 — first occurrence only", () => {
    it("Dictation, Shadowing and round completion: retries, repeat takes, invalid practice and legacy/abandoned completions earn nothing", async () => {
      expect(await events(userRules)).toEqual([
        { at: "2026-11-10T03:00:00Z", source: "active_day", amount: 10 },
        { at: "2026-11-10T03:00:00Z", source: "dictation_sentence", amount: 10 },
        { at: "2026-11-10T03:02:00Z", source: "dictation_correct", amount: 5 },
        { at: "2026-11-10T03:05:00Z", source: "dictation_sentence", amount: 10 },
        { at: "2026-11-10T03:10:00Z", source: "dictation_correct", amount: 5 },
        { at: "2026-11-10T03:10:00Z", source: "dictation_sentence", amount: 10 },
        { at: "2026-11-10T03:12:00Z", source: "dictation_sentence", amount: 10 },
        { at: "2026-11-10T03:20:00Z", source: "shadowing_sentence", amount: 10 },
        { at: "2026-11-10T03:21:00Z", source: "shadowing_score", amount: 5 },
        { at: "2026-11-10T04:00:00Z", source: "round_complete", amount: 50 },
      ]);
    });

    it("vocabulary: +3 for the first review of a word per local day, 20 paid a day (60 XP), the rest listed with 0", async () => {
      const evs = (await events(userVocab, HCM)).filter((e) => e.source === "vocabulary");
      const first = evs.filter((e) => e.at < "2026-11-12T17:00:00Z");
      expect(first).toHaveLength(25); // word 0's two repeats that day are not listed
      expect(total(first)).toBe(60);
      expect(first.slice(20).every((e) => e.amount === 0)).toBe(true);
      // The next local day: word 0 again, and a deleted word's review.
      expect(evs.filter((e) => e.at > "2026-11-12T17:00:00Z").map((e) => e.amount)).toEqual([3, 3]);
      // Two local days of activity → two active-day bonuses.
      expect((await events(userVocab, HCM)).filter((e) => e.source === "active_day")).toHaveLength(2);
    });

    it("the local day is the zone's: in UTC the same reviews are one day (cap reached → the next-day ones pay 0)", async () => {
      const evs = (await events(userVocab, "UTC")).filter((e) => e.source === "vocabulary");
      expect(evs).toHaveLength(26); // word 0 reviewed again the same UTC day isn't new; the deleted word's is
      expect(total(evs)).toBe(60);
    });

    it("listening: whole minutes of newly covered time per session, at the session's start", async () => {
      expect((await events(userListen)).filter((e) => e.source === "listening")).toEqual([{ at: T.replace(".000", ""), source: "listening", amount: 2 }]);
    });
  });

  describe("XP zone and the active-day bonus", () => {
    it("the zone is the learner's most recently recorded one; UTC without any", async () => {
      const zone = async (u: string) => (await c.query("select fn_xp_time_zone($1) as tz", [u])).rows[0].tz;
      expect(await zone(userZone)).toBe(NY); // the newer activity batch beats the older review
      expect(await zone(userVocab)).toBe(HCM);
      expect(await zone(userRules)).toBe("UTC");
    });

    it("engaged time across local midnight is activity on both days; the second day's bonus is dated at its midnight", async () => {
      expect((await events(userZone, NY)).filter((e) => e.source === "active_day").map((e) => e.at)).toEqual([
        "2026-11-01T00:00:00Z", // the older review (31 Oct in New York)
        "2026-11-11T04:50:00Z", // 23:50, 10 Nov New York
        "2026-11-11T05:00:00Z", // 00:00, 11 Nov New York
      ]);
    });
  });

  describe("fn_my_xp", () => {
    it("totals, today, 14 local days ending today, and the rules version; the days add up to the total", async () => {
      const xp = await myXp(userRecent);
      // first answer +10, first correct +5, active day +10
      expect(xp).toMatchObject({ rulesVersion: 1, timeZone: "UTC", xpTimeZone: "UTC", totalXp: 25, todayXp: 25 });
      expect(xp.days).toHaveLength(14);
      expect(xp.days[13]).toEqual({ date: xp.today, xp: 25, activity: { dictationSentences: 1, shadowingSentences: 0, wordsReviewed: 0, listeningMin: 0 } });
      expect(xp.days.reduce((s, x) => s + x.xp, 0)).toBe(xp.totalXp);
    });

    it("the whole history counts toward the total, the same as the events", async () => {
      expect((await myXp(userRules)).totalXp).toBe(total(await events(userRules)));
      expect((await myXp(userVocab)).totalXp).toBe(total(await events(userVocab, HCM)));
    });

    it("the league week runs from Monday 00:00 UTC; last week's recap has its XP, engaged time and distinct words", async () => {
      const xp = await myXp(userWeek);
      const { w, prev } = (
        await c.query(
          `select to_char(date_trunc('week', now() at time zone 'UTC'), 'YYYY-MM-DD') as w,
                  to_char(date_trunc('week', now() at time zone 'UTC') - interval '7 days', 'YYYY-MM-DD') as prev`
        )
      ).rows[0];
      expect(new Date(xp.leagueWeekStart).toISOString()).toBe(`${w}T00:00:00.000Z`);
      expect(xp.lastLeagueWeek.weekStart).toBe(prev);
      // This week: the answer at 00:00 Monday (+10) and Monday's active day (+10).
      expect(xp.leagueWeekXp).toBe(20);
      // Last week: the Sunday answer (+10), three word reviews on two days (+9),
      // active Friday, Saturday and Sunday (+30).
      expect(xp.lastLeagueWeek).toMatchObject({ xp: 49, activeSec: 700, wordsReviewed: 2 });
      expect(Number(xp.lastLeagueWeek.activeSec)).toBe(700);
    });

    it("changing the daily goal changes no XP", async () => {
      const before = await myXp(userRecent);
      await rpcAs(c, userRecent, `select fn_update_my_profile('{"dailyGoalMinutes":60}')`);
      expect((await myXp(userRecent)).totalXp).toBe(before.totalXp);
    });

    it("the viewer's zone only moves the dates, never the total", async () => {
      const [utc, hcm] = [await myXp(userVocab, "UTC"), await myXp(userVocab, HCM)];
      expect(hcm.totalXp).toBe(utc.totalXp);
    });

    it("an invalid zone is refused; anon can't call it; nobody can call the internal helpers", async () => {
      expect((await errorOf(myXp(userRecent, "UTC+7")))?.message).toBe("invalid_payload");
      expect((await errorOf(asRole(c, "anon", null, () => c.query("select fn_my_xp('UTC')"))))?.message).toMatch(/permission denied/);
      expect((await errorOf(asRole(c, "authenticated", null, () => c.query("select fn_my_xp('UTC')"))))?.message).toBe("authentication_required");
      for (const sql of [
        "select * from fn_xp_events($1, 'UTC')",
        "select fn_xp_time_zone($1)",
        "select fn_active_seconds_between($1, now() - interval '1 day', now())",
      ]) {
        expect((await errorOf(asRole(c, "authenticated", userRecent, () => c.query(sql, [userRecent]))))?.message).toMatch(/permission denied/);
      }
    });
  });
});
