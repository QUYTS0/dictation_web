/**
 * Phase 5 on real PostgreSQL: Listening coverage, checkpoints and activity
 * pulses through fn_sync_study_activity / fn_flush_study_activity (039),
 * executed under the real `authenticated` role with JWT claims the way
 * PostgREST runs them. Production state first (001–038 + activated
 * cutover), then 039. Skipped unless LOCALDB_ADMIN_URL is set.
 */
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import {
  HAS_LOCALDB,
  applyMigration,
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
if (!HAS_LOCALDB) console.warn("[phase5-listening] skipped — LOCALDB_ADMIN_URL not set");

type Flush = {
  processed: boolean;
  coverageRatio?: number;
  listenedThrough?: boolean;
  coveredSec?: number;
  lastPositionSec?: number;
  hasHistory?: boolean;
  transcriptCoveredSec?: number | null;
  studySessionId?: string;
  attribution?: "current" | "late" | "replay";
};
const FLUSH_SQL = "select fn_flush_study_activity($1, $2, $3, $4, $5::jsonb, $6, $7, $8)";
const SYNC_SQL = "select fn_sync_study_activity($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)";
const CREATE_ROUND = "select fn_create_or_get_active_round($1, $2)";
const RESTART = "select fn_restart_round($1, $2)";

/** Sentences with a 10 s gap (10–20), an EMPTY sentence (30–35) and another gap (35–40). */
async function publishGappedTranscript(c: PgClient, videoId: string): Promise<string> {
  const segments = [
    { segmentIndex: 0, start: 0, end: 10, text: "Alpha one.", textNormalized: "alpha one" },
    { segmentIndex: 1, start: 20, end: 30, text: "Beta two.", textNormalized: "beta two" },
    { segmentIndex: 2, start: 30, end: 35, text: "...", textNormalized: "" },
    { segmentIndex: 3, start: 40, end: 50, text: "Gamma three.", textNormalized: "gamma three" },
  ];
  await c.query(`insert into videos (youtube_video_id, title) values ($1, $1) on conflict (youtube_video_id) do nothing`, [videoId]);
  const r = await c.query(
    `select (fn_publish_transcript_revision($1, 'en', 'manual', $2, $3::jsonb, $4)).id as id`,
    [videoId, "Alpha one. Beta two. Gamma three.", JSON.stringify(segments), `fp-${randomUUID()}`]
  );
  return r.rows[0].id as string;
}

interface SyncArgs {
  kind?: "listening" | "activity";
  batch?: string;
  roundId?: string | null;
  intervals?: unknown;
  transcriptId?: string | null;
  pos?: number | null;
  age?: number | null;
}

d("Phase 5 — Listening coverage and activity (real PostgreSQL)", () => {
  let db: TestDb;
  let c: PgClient;
  let userA: string;
  let userB: string;
  let tr: string;
  const VID = "vidL5";

  const session = async (user: string, video = VID, roundId: string | null = null) =>
    (await rpcAs<{ studySessionId: string }>(c, user, "select fn_get_or_create_study_session($1, $2)", [video, roundId])).studySessionId;
  const flush = (user: string, kind: string, sid: string, batch: string, intervals: unknown, transcriptId: string | null = tr, pos: number | null = null, video = VID) =>
    rpcAs<Flush>(c, user, FLUSH_SQL, [kind, sid, batch, video, JSON.stringify(intervals), transcriptId, pos, "Asia/Ho_Chi_Minh"]);
  const progress = async (user: string, transcriptId: string | null = tr, video = VID) =>
    (
      await c.query(
        `select covered_sec::float8 as covered, coverage_ratio::float8 as ratio, transcript_covered_sec::float8 as denom,
                listened_through, listened_through_at, last_position_sec::float8 as pos, superseded_at
           from listening_progress where user_id = $1 and youtube_video_id = $2 and transcript_id is not distinct from $3`,
        [user, video, transcriptId]
      )
    ).rows[0];
  const sessionRow = async (sid: string) =>
    (
      await c.query(
        `select listening_observed_sec::float8 as observed, listening_newly_covered_sec::float8 as newly, modes_used, activity_intervals,
                round_id, started_at, last_activity_at, ended_at
           from study_sessions where id = $1`,
        [sid]
      )
    ).rows[0];

  beforeAll(async () => {
    db = await createTestDb("phase5", 38);
    c = await db.connect();
    await runCutover(c, "activated");
    await applyMigration(c, 39);
    userA = await createUser(c);
    userB = await createUser(c);
    tr = await publishGappedTranscript(c, VID);
  }, 180_000);
  afterAll(async () => {
    await c?.end();
    await db?.drop();
  });

  // ---------------------------------------------------------------- coverage
  it("denominator = union of valid sentences (gaps and empty sentences excluded); gaps never credited; replays add observed time only", async () => {
    const sid = await session(userA);
    const r1 = await flush(userA, "listening", sid, randomUUID(), [{ start: 0, end: 10 }, { start: 10, end: 20 }], tr, 20);
    expect(r1).toMatchObject({ processed: true, listenedThrough: false, lastPositionSec: 20, hasHistory: true });
    expect(Number(r1.coveredSec)).toBe(10); // 10–20 is a gap between sentences
    expect(Number(r1.transcriptCoveredSec)).toBe(30);
    let p = await progress(userA);
    expect(p.denom).toBe(30); // [0,10] + [20,30] + [40,50]; the empty 30–35 sentence and the gaps excluded
    expect(p.ratio).toBeCloseTo(1 / 3, 4);

    await flush(userA, "listening", sid, randomUUID(), [{ start: 0, end: 10 }], tr, 10); // replay
    p = await progress(userA);
    expect(p.covered).toBe(10);
    expect(p.pos).toBe(10); // resume position may move backward
    const s = await sessionRow(sid);
    expect(s.observed).toBe(30); // 20 + 10 raw, replay-inclusive (the raw list is never merged first)
    expect(s.newly).toBe(10);
    expect(s.modes_used).toEqual(["listening"]);
  });

  it("a retried batch is a pure no-op; the same batch id with different content is refused", async () => {
    const sid = await session(userA);
    const batch = randomUUID();
    const first = await flush(userA, "listening", sid, batch, [{ start: 20, end: 25 }], tr, 25);
    expect(first.processed).toBe(true);
    const before = await sessionRow(sid);
    const retry = await flush(userA, "listening", sid, batch, [{ start: 20, end: 25 }], tr, 25);
    expect(retry).toMatchObject({ processed: false, coveredSec: 15 });
    expect(await sessionRow(sid)).toEqual(before);
    const err = await errorOf(flush(userA, "listening", sid, batch, [{ start: 20, end: 26 }], tr, 26));
    expect(err?.message).toMatch(/flush_batch_id_reused_with_different_payload/);
  });

  it("reaching 90 % of the valid union sets listened-through once; later flushes keep its timestamp", async () => {
    const sid = await session(userA);
    const r = await flush(userA, "listening", sid, randomUUID(), [{ start: 24, end: 30 }, { start: 40, end: 48 }], tr, 48);
    expect(r.listenedThrough).toBe(true);
    const p = await progress(userA);
    expect(p.covered).toBe(28);
    expect(p.ratio).toBeCloseTo(28 / 30, 4);
    const at = p.listened_through_at;
    await flush(userA, "listening", sid, randomUUID(), [{ start: 48, end: 50 }], tr, 50);
    expect((await progress(userA)).listened_through_at).toEqual(at);
  });

  // ---------------------------------------------------------------- activity
  it("activity pulses take wall-clock epoch seconds and are merged exactly; out-of-range, malformed and reversed intervals are refused", async () => {
    const sid = await session(userA);
    const now = Math.floor(Date.now() / 1000);
    const ok = await flush(userA, "activity", sid, randomUUID(), [{ start: now - 60, end: now - 45 }, { start: now - 50, end: now - 30 }], null);
    expect(ok).toMatchObject({ processed: true });
    expect((await sessionRow(sid)).activity_intervals).toEqual([{ start: now - 60, end: now - 30 }]);
    for (const bad of [
      [{ start: 0, end: 10 }], // media seconds are not wall-clock time
      [{ start: now - 1000, end: now }], // longer than 900 s
      [{ start: now - 30, end: now - 40 }], // reversed
      [{ start: now, end: now }], // empty
      [{ start: "1", end: "2" }], // not numbers
      [{ start: now + 700, end: now + 760 }], // more than 10 min in the future
      [{ start: now + 86400 * 365, end: now + 86400 * 365 + 10 }], // far future
      [{ start: now - 90000, end: now - 89990 }], // older than a day
      [{ start: 1e300, end: 1e301 }], // absurdly large
      [{ start: null, end: now }],
      ["x"],
      { start: now - 10, end: now }, // not an array
    ]) {
      expect((await errorOf(flush(userA, "activity", sid, randomUUID(), bad, null)))?.message).toMatch(/invalid_interval_payload/);
    }
    expect((await errorOf(flush(userA, "listening", sid, randomUUID(), [{ start: 0, end: 2e7 }])))?.message).toMatch(/invalid_interval_payload/);
    expect((await sessionRow(sid)).activity_intervals).toEqual([{ start: now - 60, end: now - 30 }]); // nothing else got in
  });

  it("isolation: another user can't flush into this session or read this progress; a transcript of another video is refused; roles", async () => {
    const sidA = await session(userA);
    expect((await errorOf(flush(userB, "listening", sidA, randomUUID(), [{ start: 0, end: 5 }])))?.message).toMatch(/study_session_mismatch/);
    const seen = await rpcAs<number>(c, userB, "select count(*)::int from listening_progress where youtube_video_id = $1", [VID]);
    expect(seen).toBe(0);
    const otherTr = await publishGappedTranscript(c, "vidOther5");
    expect((await errorOf(flush(userA, "listening", sidA, randomUUID(), [{ start: 0, end: 5 }], otherTr)))?.message).toMatch(
      /transcript_not_found_for_video/
    );
    for (const role of ["anon", "service_role"] as const) {
      expect((await errorOf(rpcAs(c, userA, FLUSH_SQL, ["listening", sidA, randomUUID(), VID, "[]", tr, null, null], role)))?.code).toBe("42501");
      expect((await errorOf(rpcAs(c, userA, SYNC_SQL, ["listening", randomUUID(), VID, null, "[]", tr, null, null, null], role)))?.code).toBe("42501");
    }
    // The internal function is callable by no application role.
    for (const role of ["anon", "authenticated", "service_role"] as const) {
      const err = await errorOf(
        rpcAs(c, userA, "select fn_apply_study_flush($1, 'listening', $2, $3, $4, '[]'::jsonb, $5, null, null, true)", [userA, sidA, randomUUID(), VID, tr], role)
      );
      expect(err?.code).toBe("42501");
    }
  });

  it("listening before a transcript exists is kept raw, then carried forward (clipped to the valid union) into the revision once", async () => {
    const VID2 = "vidL5b";
    const sid = await session(userB, VID2);
    await flush(userB, "listening", sid, randomUUID(), [{ start: 0, end: 12 }], null, 12, VID2);
    const tr2 = await publishGappedTranscript(c, VID2);
    const r = await flush(userB, "listening", sid, randomUUID(), [{ start: 40, end: 45 }], tr2, 45, VID2);
    expect(Number(r.coveredSec)).toBe(15); // carried [0,10] (10–12 is a gap) + new [40,45]
    const nullRow = (await c.query(`select superseded_at from listening_progress where user_id = $1 and youtube_video_id = $2 and transcript_id is null`, [userB, VID2])).rows[0];
    expect(nullRow.superseded_at).not.toBeNull();
  });

  // -------------------------------------- attribution: fn_sync_study_activity
  describe("batch attribution (fn_sync_study_activity)", () => {
    let user: string;
    let video: string;
    let trV: string;
    const sync = (a: SyncArgs = {}, u = user, v = video) =>
      rpcAs<Flush>(c, u, SYNC_SQL, [
        a.kind ?? "listening",
        a.batch ?? randomUUID(),
        v,
        a.roundId ?? null,
        JSON.stringify(a.intervals ?? [{ start: 0, end: 5 }]),
        a.transcriptId === undefined ? ((a.kind ?? "listening") === "listening" ? trV : null) : a.transcriptId,
        a.pos === undefined ? 5 : a.pos,
        "Asia/Ho_Chi_Minh",
        a.age ?? 0,
      ]);
    const sessionsOf = async (u = user, v = video) =>
      (await c.query(`select id, round_id, ended_at, last_activity_at from study_sessions where user_id = $1 and youtube_video_id = $2 order by started_at, id`, [u, v])).rows;
    const logCount = async (batch: string) =>
      Number((await c.query(`select count(*) from activity_flush_log where flush_batch_id = $1`, [batch])).rows[0].count);
    const round = async () => (await rpcAs<{ roundId: string }>(c, user, CREATE_ROUND, [video, trV])).roundId;
    const restart = async (expected: string) => (await rpcAs<{ roundId: string }>(c, user, RESTART, [video, expected])).roundId;

    beforeEach(async () => {
      user = await createUser(c);
      video = `vidAttr-${randomUUID().slice(0, 8)}`;
      trV = await publishGappedTranscript(c, video);
    });

    it("1. a committed batch whose response was lost: the retry is a no-op answered from the same session — nothing moves", async () => {
      const r1 = await round();
      const batch = randomUUID();
      const first = await sync({ batch, roundId: r1, intervals: [{ start: 0, end: 10 }], pos: 10 });
      expect(first).toMatchObject({ processed: true, attribution: "current" });
      const sid = first.studySessionId!;
      expect((await sessionRow(sid)).round_id).toBe(r1);
      const before = { session: await sessionRow(sid), progress: await progress(user, trV, video), sessions: await sessionsOf() };

      const retry = await sync({ batch, roundId: r1, intervals: [{ start: 0, end: 10 }], pos: 10, age: 12 }); // only the age differs
      expect(retry).toMatchObject({ processed: false, attribution: "replay", studySessionId: sid, coveredSec: 10, lastPositionSec: 10 });
      expect({ session: await sessionRow(sid), progress: await progress(user, trV, video), sessions: await sessionsOf() }).toEqual(before);
      expect(await logCount(batch)).toBe(1);
    });

    it("2. the same retry AFTER Restart still finds its own session: no second application, the new round untouched", async () => {
      const r1 = await round();
      const batch = randomUUID();
      const first = await sync({ batch, roundId: r1, intervals: [{ start: 0, end: 10 }], pos: 10 });
      const sid = first.studySessionId!;
      const r2 = await restart(r1);
      expect(r2).not.toBe(r1);
      const before = { session: await sessionRow(sid), sessions: await sessionsOf() };
      expect(before.session.ended_at).not.toBeNull(); // Restart closed it

      const retry = await sync({ batch, roundId: r1, intervals: [{ start: 0, end: 10 }], pos: 10, age: 30 });
      expect(retry).toMatchObject({ processed: false, attribution: "replay", studySessionId: sid });
      expect({ session: await sessionRow(sid), sessions: await sessionsOf() }).toEqual(before); // counters, timestamps, no new session
      expect((await sessionRow(sid)).observed).toBe(10);
      expect(await logCount(batch)).toBe(1);
    });

    it("3. an UNSENT old batch delivered after Restart goes to the old round's closed session — never to the new round", async () => {
      const r1 = await round();
      const sid1 = (await sync({ roundId: r1, intervals: [{ start: 0, end: 5 }], pos: 5 })).studySessionId!;
      const r2 = await restart(r1);
      const sid2 = (await sync({ roundId: r2, intervals: [{ start: 20, end: 22 }], pos: 22 })).studySessionId!; // the new round is in use
      expect(sid2).not.toBe(sid1);
      const s1Before = await sessionRow(sid1);
      const s2Before = await sessionRow(sid2);

      const late = await sync({ roundId: r1, intervals: [{ start: 5, end: 10 }], pos: 10 }); // observed under round 1
      expect(late).toMatchObject({ processed: true, attribution: "late", studySessionId: sid1 });
      const s1 = await sessionRow(sid1);
      expect(s1.observed).toBe(s1Before.observed + 5);
      expect(s1.round_id).toBe(r1); // association never changes
      expect(s1.ended_at).toEqual(s1Before.ended_at); // not reopened
      expect(s1.last_activity_at).toEqual(s1Before.last_activity_at); // not re-dated
      expect(await sessionRow(sid2)).toEqual(s2Before); // the new round's session: not closed, not credited
      expect((await progress(user, trV, video)).covered).toBe(12); // coverage itself is video/revision-scoped: [0,10] + [20,22]
      expect(await sessionsOf()).toHaveLength(2);
    });

    it("3b. late data for a round that never had a session is refused — not rerouted; nothing is written", async () => {
      const r1 = await round();
      const r2 = await restart(r1);
      const batch = randomUUID();
      const err = await errorOf(sync({ batch, roundId: r1 }));
      expect(err?.message).toMatch(/late_activity_without_session/);
      expect(await logCount(batch)).toBe(0);
      expect(await sessionsOf()).toHaveLength(0);
      expect(await progress(user, trV, video)).toBeUndefined();
      // Observed round-less while a round now exists: late as well.
      expect((await errorOf(sync({ roundId: null })))?.message).toMatch(/late_activity_without_session/);
      expect((await sync({ roundId: r2 })).attribution).toBe("current");
    });

    it("4. a session that expired between attempts: the retry stays in it; only genuinely NEW activity opens the next session", async () => {
      const r1 = await round();
      const batch = randomUUID();
      const sid = (await sync({ batch, roundId: r1, intervals: [{ start: 0, end: 10 }], pos: 10 })).studySessionId!;
      await c.query(`update study_sessions set last_activity_at = now() - interval '45 minutes' where id = $1`, [sid]);
      const aged = await sessionRow(sid);

      const retry = await sync({ batch, roundId: r1, intervals: [{ start: 0, end: 10 }], pos: 10, age: 2700 });
      expect(retry).toMatchObject({ processed: false, attribution: "replay", studySessionId: sid });
      expect(await sessionRow(sid)).toEqual(aged);
      expect(await sessionsOf()).toHaveLength(1);

      // A never-processed batch observed 45 minutes ago: late → the same session, untouched timestamps.
      const delayed = await sync({ roundId: r1, intervals: [{ start: 20, end: 25 }], pos: 25, age: 2700 });
      expect(delayed).toMatchObject({ processed: true, attribution: "late", studySessionId: sid });
      const afterDelayed = await sessionRow(sid);
      expect(afterDelayed.observed).toBe(15);
      expect(afterDelayed.last_activity_at).toEqual(aged.last_activity_at);
      expect(afterDelayed.ended_at).toBeNull();
      expect(await sessionsOf()).toHaveLength(1);

      // Fresh activity now: the ordinary rule closes the expired session and opens a new one.
      const fresh = await sync({ roundId: r1, intervals: [{ start: 40, end: 45 }], pos: 45, age: 1 });
      expect(fresh.attribution).toBe("current");
      expect(fresh.studySessionId).not.toBe(sid);
      expect((await sessionRow(sid)).ended_at).not.toBeNull();
      expect((await sessionRow(fresh.studySessionId!)).round_id).toBe(r1);
    });

    it("5. the same batch id with a different payload is an explicit conflict — also after Restart", async () => {
      const r1 = await round();
      const batch = randomUUID();
      await sync({ batch, roundId: r1, intervals: [{ start: 0, end: 10 }], pos: 10 });
      expect((await errorOf(sync({ batch, roundId: r1, intervals: [{ start: 0, end: 11 }], pos: 10 })))?.message).toMatch(
        /flush_batch_id_reused_with_different_payload/
      );
      await restart(r1);
      expect((await errorOf(sync({ batch, roundId: r1, intervals: [{ start: 0, end: 10 }], pos: 11 })))?.message).toMatch(
        /flush_batch_id_reused_with_different_payload/
      );
      expect(await logCount(batch)).toBe(1);
      expect((await progress(user, trV, video)).pos).toBe(10);
    });

    it("6. two tabs syncing at once: the second waits, both batches are kept and each is applied exactly once", async () => {
      const r1 = await round();
      const c1 = await db.connect();
      const c2 = await db.connect();
      const b1 = randomUUID();
      const b2 = randomUUID();
      const args = (batch: string, intervals: unknown, pos: number) => ["listening", batch, video, r1, JSON.stringify(intervals), trV, pos, null, 0];
      try {
        await beginAs(c1, "authenticated", user);
        await c1.query(SYNC_SQL, args(b1, [{ start: 0, end: 10 }], 10));
        await beginAs(c2, "authenticated", user);
        const pid2 = await backendPid(c2);
        const second = c2.query(SYNC_SQL, args(b2, [{ start: 20, end: 30 }], 30));
        await waitUntilBlocked(c, pid2);
        await c1.query("commit");
        await second;
        await c2.query("commit");
      } finally {
        await c1.end();
        await c2.end();
      }
      const sessions = await sessionsOf();
      expect(sessions).toHaveLength(1); // one session, not one per tab
      const s = await sessionRow(sessions[0].id);
      expect(s.observed).toBe(20);
      expect(s.newly).toBe(20);
      expect((await progress(user, trV, video)).covered).toBe(20);
      expect(await logCount(b1)).toBe(1);
      expect(await logCount(b2)).toBe(1);
      // Each retried once more with the identical payload: still one application each.
      expect((await rpcAs<Flush>(c, user, SYNC_SQL, args(b1, [{ start: 0, end: 10 }], 10))).attribution).toBe("replay");
      expect((await rpcAs<Flush>(c, user, SYNC_SQL, args(b2, [{ start: 20, end: 30 }], 30))).attribution).toBe("replay");
      expect((await sessionRow(sessions[0].id)).observed).toBe(20);
    });

    it("the round and revision are relationship-checked: someone else's round, another video's round, an unknown revision", async () => {
      const r1 = await round();
      const other = await createUser(c);
      expect((await errorOf(sync({ roundId: r1 }, other)))?.message).toMatch(/round_mismatch/);
      const otherVideo = `vidAttrX-${randomUUID().slice(0, 8)}`;
      const otherTr = await publishGappedTranscript(c, otherVideo);
      expect((await errorOf(sync({ roundId: r1, transcriptId: otherTr }, user, otherVideo)))?.message).toMatch(/round_mismatch/);
      expect((await errorOf(sync({ roundId: r1, transcriptId: otherTr })))?.message).toMatch(/transcript_not_found_for_video/);
      expect((await errorOf(sync({ roundId: r1, age: -5 })))?.message).toMatch(/invalid_interval_payload/);
    });

    it("a batch observed under revision A stays on revision A after the script is regenerated", async () => {
      const first = await sync({ intervals: [{ start: 0, end: 10 }], pos: 10, transcriptId: trV });
      const trB = await publishGappedTranscript(c, video); // regeneration: revision B becomes current
      expect(trB).not.toBe(trV);
      const late = await sync({ intervals: [{ start: 20, end: 25 }], pos: 25, transcriptId: trV });
      expect(late.studySessionId).toBe(first.studySessionId);
      expect((await progress(user, trV, video)).covered).toBe(15);
      expect(await progress(user, trB, video)).toBeUndefined(); // nothing became revision B's
    });

    it("another account reusing a batch id is not a replay of this account's batch, and changes nothing of it", async () => {
      const batch = randomUUID();
      const mine = await sync({ batch, intervals: [{ start: 0, end: 10 }], pos: 10 });
      const before = await sessionRow(mine.studySessionId!);
      const other = await createUser(c);
      const theirs = await sync({ batch, intervals: [{ start: 20, end: 25 }], pos: 25 }, other);
      expect(theirs).toMatchObject({ processed: true, attribution: "current" });
      expect(theirs.studySessionId).not.toBe(mine.studySessionId);
      expect(await sessionRow(mine.studySessionId!)).toEqual(before);
      expect((await progress(user, trV, video)).pos).toBe(10);
      expect((await progress(other, trV, video)).pos).toBe(25);
    });

    // ------------------------------------------------------------ checkpoint
    it("checkpoint: saved with the flush, moves backward on a replay, and coverage never shrinks", async () => {
      const a = await sync({ intervals: [{ start: 40, end: 50 }], pos: 50 }); // a later sentence
      expect(a.lastPositionSec).toBe(50);
      expect((await progress(user, trV, video)).pos).toBe(50);
      const sid = a.studySessionId!;

      const back = await sync({ intervals: [{ start: 40, end: 45 }], pos: 45 }); // sought back and replayed
      expect(back).toMatchObject({ lastPositionSec: 45, coveredSec: 10 }); // lower checkpoint, zero new coverage
      const s = await sessionRow(sid);
      expect(s.observed).toBe(15); // replay-inclusive
      expect(s.newly).toBe(10); // unique
      const p = await progress(user, trV, video);
      expect(p).toMatchObject({ pos: 45, covered: 10 });

      // A real return to the beginning is a real checkpoint (not the default).
      const start = await sync({ intervals: [{ start: 0, end: 1 }], pos: 1 });
      expect(start.lastPositionSec).toBe(1);
      expect((await progress(user, trV, video)).covered).toBe(11);
    });

    it("checkpoint: a batch without one keeps the saved checkpoint, and the response reports the stored value", async () => {
      await sync({ intervals: [{ start: 20, end: 30 }], pos: 30 });
      const noCheckpoint = await sync({ intervals: [{ start: 0, end: 5 }], pos: null });
      expect(noCheckpoint).toMatchObject({ processed: true, lastPositionSec: 30, hasHistory: true });
      expect((await progress(user, trV, video)).pos).toBe(30);
    });

    it("checkpoint: an old, already-processed batch retried after a newer save does not roll it back", async () => {
      const oldBatch = randomUUID();
      await sync({ batch: oldBatch, intervals: [{ start: 0, end: 10 }], pos: 10 });
      await sync({ intervals: [{ start: 40, end: 48 }], pos: 48 }); // newer save
      const retry = await sync({ batch: oldBatch, intervals: [{ start: 0, end: 10 }], pos: 10, age: 60 });
      expect(retry).toMatchObject({ processed: false, attribution: "replay", lastPositionSec: 48 }); // reports the current state
      expect((await progress(user, trV, video)).pos).toBe(48);
    });

    it("checkpoint: independent per revision and per account, and readable by its owner only", async () => {
      await sync({ intervals: [{ start: 40, end: 50 }], pos: 50 });
      const trB = await publishGappedTranscript(c, video);
      await sync({ intervals: [{ start: 0, end: 5 }], pos: 5, transcriptId: trB });
      expect((await progress(user, trV, video)).pos).toBe(50);
      expect((await progress(user, trB, video)).pos).toBe(5);
      const other = await createUser(c);
      await sync({ intervals: [{ start: 20, end: 22 }], pos: 22 }, other);
      expect((await progress(user, trV, video)).pos).toBe(50);
      // What GET /api/listening/progress reads, as each account (owner RLS).
      const read = (u: string) =>
        rpcAs<number | null>(c, u, "select max(last_position_sec)::float8 from listening_progress where youtube_video_id = $1 and transcript_id = $2", [video, trV]);
      expect(await read(user)).toBe(50);
      expect(await read(other)).toBe(22);
    });

    it("activity through the entry point: deduplicated by batch id, late data never re-dates a session", async () => {
      const now = Math.floor(Date.now() / 1000);
      const r1 = await round();
      const batch = randomUUID();
      const span = [{ start: now - 40, end: now - 20 }];
      const a = await sync({ kind: "activity", batch, roundId: r1, intervals: span });
      expect(a).toMatchObject({ processed: true, attribution: "current" });
      const sid = a.studySessionId!;
      expect((await sync({ kind: "activity", batch, roundId: r1, intervals: span })).attribution).toBe("replay");
      await restart(r1);
      const closed = await sessionRow(sid);
      const late = await sync({ kind: "activity", roundId: r1, intervals: [{ start: now - 20, end: now - 10 }] });
      expect(late).toMatchObject({ attribution: "late", studySessionId: sid });
      const s = await sessionRow(sid);
      expect(s.activity_intervals).toEqual([{ start: now - 40, end: now - 10 }]);
      expect(s.last_activity_at).toEqual(closed.last_activity_at);
      expect(s.ended_at).toEqual(closed.ended_at);
    });
  });
});

d("Phase 5 rollout rehearsal: 00_preflight → 039 → 01_postflight (real PostgreSQL, production state)", () => {
  let db: TestDb;
  let c: PgClient;
  const DIR = path.resolve(__dirname, "../../../supabase/phase5");
  const runScript = async (file: string) => {
    const res = await c.query(fs.readFileSync(path.join(DIR, file), "utf8"));
    return (Array.isArray(res) ? res : [res]) as Array<{ fields?: Array<{ name: string }>; rows: Record<string, unknown>[] }>;
  };
  const byField = (results: Awaited<ReturnType<typeof runScript>>, name: string) => results.find((r) => r.fields?.some((f) => f.name === name));

  beforeAll(async () => {
    db = await createTestDb("phase5up", 38);
    c = await db.connect();
    await runCutover(c, "activated");
  }, 180_000);
  afterAll(async () => {
    await c?.end();
    await db?.drop();
  });

  it("preflight is read-only and reports 038 present, grants in place, 039 absent; postflight is all ok after 039 with no row changed", async () => {
    // Existing data from the deployed (pre-039) function, e.g. a Listening sync.
    const user = await createUser(c);
    const tr = await publishGappedTranscript(c, "vidRoll");
    const sid = (await rpcAs<{ studySessionId: string }>(c, user, "select fn_get_or_create_study_session($1, null)", ["vidRoll"])).studySessionId;
    await rpcAs(c, user, FLUSH_SQL, ["listening", sid, randomUUID(), "vidRoll", JSON.stringify([{ start: 0, end: 5 }]), tr, 5, null]);

    const pre = await runScript("00_preflight.sql");
    expect(byField(pre, "phase4_applied")?.rows[0]).toEqual({ phase4_applied: true });
    expect(byField(pre, "flush_granted")?.rows[0]).toEqual({ get_session_granted: true, flush_granted: true, flush_anon: false });
    expect(byField(pre, "phase5_applied")?.rows[0]).toEqual({ phase5_applied: false });

    // The 035 defect 039 fixes: a real wall-clock pulse is rejected.
    const now = Math.floor(Date.now() / 1000);
    const pulse = () => rpcAs<Flush>(c, user, FLUSH_SQL, ["activity", sid, randomUUID(), "vidRoll", JSON.stringify([{ start: now - 20, end: now }]), null, null, null]);
    expect((await errorOf(pulse()))?.message).toMatch(/invalid_interval_payload/);

    const snap = async () => ({
      progress: (await c.query("select * from listening_progress order by id")).rows,
      sessions: (await c.query("select * from study_sessions order by id")).rows,
      log: (await c.query("select * from activity_flush_log order by flush_batch_id")).rows,
    });
    const before = await snap();
    await applyMigration(c, 39);
    expect(await snap()).toEqual(before);
    expect(await pulse()).toMatchObject({ processed: true });

    const post = await runScript("01_postflight.sql");
    const checks = post.filter((r) => r.fields?.some((f) => f.name === "ok"));
    expect(checks).toHaveLength(3);
    for (const r of checks) expect(r.rows.filter((row) => !row.ok)).toEqual([]);
    expect(checks[0].rows).toHaveLength(3); // three functions, definer + search_path
    expect(checks[1].rows).toHaveLength(4); // permission matrix
    expect(checks[2].rows.length).toBeGreaterThan(0);
    expect(byField(post, "batch_index_present")?.rows[0]).toEqual({ batch_index_present: true });
    expect(byField(post, "invalid_ratios")?.rows[0]).toMatchObject({ revision_rows: "1", invalid_ratios: "0" });
    expect(byField(await runScript("00_preflight.sql"), "phase5_applied")?.rows[0]).toEqual({ phase5_applied: true });
  });
});
