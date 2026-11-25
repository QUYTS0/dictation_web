/**
 * Migration 046 on real PostgreSQL (dashboard redesign Phase 3, D9):
 * vocabulary_reviews, fn_record_vocabulary_review, the backfill, and
 * fn_activity_days counting vocabulary reviews as practice days — executed
 * under the real `authenticated` role the way PostgREST runs it.
 *
 * Upgrade path: 001–045 with the activated cutover, vocabulary seeded
 * BEFORE 046 (some already reviewed), then 046. Skipped unless
 * LOCALDB_ADMIN_URL is set.
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
if (!HAS_LOCALDB) console.warn("[vocabulary-review-log] skipped — LOCALDB_ADMIN_URL not set");

type Days = { days: string[]; utcFallbackDays: string[] };
type Item = { id: string; interval_days: number; ease_factor: number; repetitions: number; next_review_at: string; last_reviewed_at: string | null };

const HCM = "Asia/Ho_Chi_Minh";

d("046 — vocabulary review log and streak (real PostgreSQL)", () => {
  let db: TestDb;
  let c: PgClient;
  let userA: string;
  let userB: string;
  let reviewedBefore: string; // A's item reviewed before 046
  let neverReviewed: string; // A's item never reviewed
  let itemB: string;

  const insertItem = async (user: string, term: string, lastReviewedSql: string | null) =>
    (
      await c.query(
        `insert into vocabulary_items (user_id, video_id, segment_index, term, normalized_term, sentence_context, last_reviewed_at)
         values ($1, 'vid1', 0, $2, $2, $3, ${lastReviewedSql ?? "null"}) returning id`,
        [user, term, `A sentence with ${term} in it.`]
      )
    ).rows[0].id as string;

  const record = (user: string, item: string, grade = "good", tz: string | null = HCM) =>
    rpcAs<Item | null>(c, user, "select fn_record_vocabulary_review($1, $2, 1, 2.5, 1, now() + interval '1 day', $3)", [item, grade, tz]);
  const days = (user: string) => rpcAs<Days>(c, user, "select fn_activity_days()");
  const reviewRows = async (item: string) =>
    (await c.query("select grade, client_timezone, backfilled from vocabulary_reviews where item_id = $1 order by reviewed_at", [item])).rows;

  beforeAll(async () => {
    db = await createTestDb("vocab046", 45);
    c = await db.connect();
    await runCutover(c, "activated");
    userA = await createUser(c);
    userB = await createUser(c);
    reviewedBefore = await insertItem(userA, "breakthrough", "now() - interval '3 days'");
    neverReviewed = await insertItem(userA, "coordinate", null);
    itemB = await insertItem(userB, "landmark", null);
    await applyMigration(c, 46);
  }, 240_000);
  afterAll(async () => {
    await c?.end();
    await db?.drop();
  });

  describe("backfill", () => {
    it("one flagged row per already-reviewed item, at its last review, grade unknown, UTC day", async () => {
      const rows = (
        await c.query("select item_id, grade, client_timezone, backfilled, reviewed_at = (select last_reviewed_at from vocabulary_items where id = item_id) as at_last from vocabulary_reviews")
      ).rows;
      expect(rows).toEqual([{ item_id: reviewedBefore, grade: null, client_timezone: null, backfilled: true, at_last: true }]);
    });

    it("re-applying 046 adds nothing (idempotent)", async () => {
      await applyMigration(c, 46);
      expect(Number((await c.query("select count(*) as n from vocabulary_reviews")).rows[0].n)).toBe(1);
    });

    it("a backfilled review day counts toward the streak, as a UTC-fallback day", async () => {
      const expected = (await c.query("select to_char((now() - interval '3 days') at time zone 'UTC', 'YYYY-MM-DD') as d")).rows[0].d;
      const result = await days(userA);
      expect(result.days).toContain(expected);
      expect(result.utcFallbackDays).toContain(expected);
    });
  });

  describe("fn_record_vocabulary_review", () => {
    it("updates the item's SRS fields and logs the review in one call", async () => {
      const item = await record(userA, neverReviewed, "good", HCM);
      expect(item).toMatchObject({ id: neverReviewed, interval_days: 1, repetitions: 1 });
      expect(item?.last_reviewed_at).not.toBeNull();
      expect(await reviewRows(neverReviewed)).toEqual([{ grade: "good", client_timezone: HCM, backfilled: false }]);
    });

    it("an invalid or missing timezone is stored as null (UTC fallback), never rejected", async () => {
      for (const tz of ["Mars/Olympus", "+07:00", null]) {
        const before = (await reviewRows(neverReviewed)).length;
        expect(await record(userA, neverReviewed, "hard", tz)).not.toBeNull();
        const rows = await reviewRows(neverReviewed);
        expect(rows).toHaveLength(before + 1);
        expect(rows[rows.length - 1].client_timezone).toBeNull();
      }
    });

    it("another user's item → null, and nothing is changed or logged", async () => {
      const before = (await c.query("select repetitions, last_reviewed_at from vocabulary_items where id = $1", [itemB])).rows[0];
      expect(await record(userA, itemB)).toBeNull();
      expect((await c.query("select repetitions, last_reviewed_at from vocabulary_items where id = $1", [itemB])).rows[0]).toEqual(before);
      expect(await reviewRows(itemB)).toEqual([]);
    });

    it("rejects invalid grades and SRS values with 'invalid_payload'", async () => {
      expect((await errorOf(record(userA, neverReviewed, "bogus")))?.message).toBe("invalid_payload");
      const bad = await errorOf(
        rpcAs(c, userA, "select fn_record_vocabulary_review($1, 'good', -1, 2.5, 1, now(), null)", [neverReviewed])
      );
      expect(bad?.message).toBe("invalid_payload");
    });

    it("anon cannot call it; authenticated without a user is refused", async () => {
      const anon = await errorOf(asRole(c, "anon", null, () => c.query("select fn_record_vocabulary_review($1, 'good', 1, 2.5, 1, now(), null)", [neverReviewed])));
      expect(anon?.message).toMatch(/permission denied/);
      const noUser = await errorOf(asRole(c, "authenticated", null, () => c.query("select fn_record_vocabulary_review($1, 'good', 1, 2.5, 1, now(), null)", [neverReviewed])));
      expect(noUser?.message).toBe("authentication_required");
    });
  });

  describe("vocabulary_reviews access", () => {
    it("a user reads only their own rows and cannot write any directly", async () => {
      await record(userB, itemB, "easy", null);
      const seenByA = await asRole(c, "authenticated", userA, async () => (await c.query("select distinct user_id from vocabulary_reviews")).rows);
      expect(seenByA).toEqual([{ user_id: userA }]);
      const insert = await errorOf(
        asRole(c, "authenticated", userA, () =>
          c.query("insert into vocabulary_reviews (user_id, item_id, grade) values ($1, $2, 'good')", [userA, neverReviewed])
        )
      );
      expect(insert?.message).toMatch(/permission denied/);
      const del = await errorOf(asRole(c, "authenticated", userA, () => c.query("delete from vocabulary_reviews")));
      expect(del?.message).toMatch(/permission denied/);
    });
  });

  describe("fn_activity_days counts vocabulary reviews (D9)", () => {
    it("a vocabulary-only user gets today's day in their own timezone", async () => {
      const userC = await createUser(c);
      const item = await insertItem(userC, "allocentric", null);
      await record(userC, item, "good", HCM);
      const today = (await c.query("select to_char(now() at time zone $1, 'YYYY-MM-DD') as d", [HCM])).rows[0].d;
      const result = await days(userC);
      expect(result.days).toEqual([today]);
      expect(result.utcFallbackDays).toEqual([]);
    });

    it("the review's own timezone decides its date: 18:30 UTC is the NEXT day in Vietnam", async () => {
      const userD = await createUser(c);
      const item = await insertItem(userD, "striatum", null);
      // Two days ago at 18:30 UTC = two days ago + 1 at 01:30 in Vietnam.
      const atSql = "date_trunc('day', now() at time zone 'UTC') at time zone 'UTC' - interval '2 days' + interval '18 hours 30 minutes'";
      await c.query(`insert into vocabulary_reviews (user_id, item_id, grade, reviewed_at, client_timezone) values ($1, $2, 'good', ${atSql}, $3)`, [userD, item, HCM]);
      await c.query(`insert into vocabulary_reviews (user_id, item_id, grade, reviewed_at, client_timezone) values ($1, $2, 'good', ${atSql} - interval '1 day', null)`, [userD, item]);
      const expected = (
        await c.query(
          `select to_char((${atSql}) at time zone $1, 'YYYY-MM-DD') as local, to_char((${atSql} - interval '1 day') at time zone 'UTC', 'YYYY-MM-DD') as utc`,
          [HCM]
        )
      ).rows[0];
      const result = await days(userD);
      expect(result.days).toEqual([expected.local, expected.utc]);
      expect(result.utcFallbackDays).toEqual([expected.utc]);
    });

    it("deleting a saved word keeps its review history, and the day still counts", async () => {
      const userE = await createUser(c);
      const item = await insertItem(userE, "synchrony", null);
      await record(userE, item, "good", HCM);
      await c.query("delete from vocabulary_items where id = $1", [item]);
      expect((await c.query("select count(*) as n from vocabulary_reviews where user_id = $1 and item_id is null", [userE])).rows[0].n).toBe("1");
      expect((await days(userE)).days).toHaveLength(1);
    });

    it("other practice sources are unchanged: an answer-only user still gets their day", async () => {
      // Regression guard for the CTE added in 046 — same rule-3 path as 040.
      const userF = await createUser(c);
      const round = randomUUID();
      await c.query(
        `insert into learning_sessions (id, user_id, youtube_video_id, status) values ($1, $2, 'vidF', 'completed')`,
        [round, userF]
      );
      await c.query(
        `insert into attempt_logs (session_id, segment_index, expected_text, user_text, is_correct) values ($1, 0, 'a b', 'a b', true)`,
        [round]
      );
      const today = (await c.query("select to_char(now() at time zone 'UTC', 'YYYY-MM-DD') as d")).rows[0].d;
      expect((await days(userF)).days).toEqual([today]);
    });
  });
});
