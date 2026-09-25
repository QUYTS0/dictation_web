/**
 * Regression tests for the three confirmed Phase 3 review findings — real
 * PostgreSQL, every call AS `authenticated` (PostgREST style):
 *
 *   1. Dictation idempotency must compare the effective grading mode.
 *   2. Whitespace-only answers (any JS whitespace, not just ASCII space)
 *      never earn practice coverage or complete a round.
 *   3. Supplied and automatic study-session attribution follow ONE rule set
 *      (30-minute inactivity, ended sessions never reused, modes_used kept,
 *      retries side-effect free, delayed old-round submissions never
 *      disturb the current round's open session).
 *
 * Skipped unless LOCALDB_ADMIN_URL is set (see localdb/harness.ts).
 */
import { randomUUID } from "crypto";
import {
  HAS_LOCALDB,
  createTestDb,
  createUser,
  publishTranscript,
  rpcAs,
  errorOf,
  runCutover,
  type TestDb,
  type PgClient,
} from "./localdb/harness";

const d = HAS_LOCALDB ? describe : describe.skip;
if (!HAS_LOCALDB) console.warn("[phase3-review-fixes] skipped — LOCALDB_ADMIN_URL not set");

type Rec = {
  attemptId: string;
  wasInserted: boolean;
  isCorrect: boolean;
  errorType: string;
  matchMode?: string | null;
  roundCompletedByThisRequest: boolean;
  roundStatus: string;
  studySessionId: string | null;
  progress: { coveredSentences: { dictation: number; shadowing: number; overall: number } };
};

// Named notation, so "mode omitted" really omits the argument (DEFAULT applies).
const RECORD_WITH_MODE =
  "select fn_record_dictation_attempt(p_round_id => $1, p_youtube_video_id => $2, p_segment_index => $3, " +
  "p_client_attempt_id => $4, p_user_text => $5, p_match_mode => $6, p_study_session_id => $7)";
const RECORD_NO_MODE =
  "select fn_record_dictation_attempt(p_round_id => $1, p_youtube_video_id => $2, p_segment_index => $3, " +
  "p_client_attempt_id => $4, p_user_text => $5, p_study_session_id => $6)";
const SHADOW = "select fn_record_shadowing_attempt($1, $2, $3, $4, $5, null, $6)";

d("Phase 3 review fixes (activated, real PostgreSQL)", () => {
  let db: TestDb;
  let owner: PgClient;
  let userA: string;
  let userB: string;
  let video = "";

  beforeAll(async () => {
    db = await createTestDb("reviewfix");
    owner = await db.connect();
    userA = await createUser(owner);
    userB = await createUser(owner);
    await runCutover(owner, "activated");
  }, 180_000);
  afterAll(async () => {
    await owner?.end().catch(() => {});
    await db?.drop();
  });

  const newVideo = async (texts: string[]) => {
    video = `v-${randomUUID().slice(0, 8)}`;
    await publishTranscript(owner, video, texts);
  };
  const create = async (user = userA) =>
    (await rpcAs<{ roundId: string }>(owner, user, "select fn_create_or_get_active_round($1)", [video])).roundId;
  const record = (
    roundId: string,
    seg: number,
    text: string,
    opts: { id?: string; mode?: string | null | "omit"; session?: string | null; user?: string } = {}
  ) =>
    opts.mode === "omit"
      ? rpcAs<Rec>(owner, opts.user ?? userA, RECORD_NO_MODE, [roundId, video, seg, opts.id ?? randomUUID(), text, opts.session ?? null])
      : rpcAs<Rec>(owner, opts.user ?? userA, RECORD_WITH_MODE, [
          roundId, video, seg, opts.id ?? randomUUID(), text, opts.mode ?? "relaxed", opts.session ?? null,
        ]);
  const shadow = (roundId: string, seg: number, dur: number, opts: { id?: string; session?: string | null } = {}) =>
    rpcAs<Rec>(owner, userA, SHADOW, [roundId, video, seg, opts.id ?? randomUUID(), dur, opts.session ?? null]);
  const sessionRow = async (id: string) =>
    (await owner.query("select id, round_id, ended_at, last_activity_at, modes_used from study_sessions where id = $1", [id])).rows[0];
  const videoSessions = async () =>
    (await owner.query(
      "select id, round_id, ended_at, last_activity_at, modes_used from study_sessions where youtube_video_id = $1 order by started_at, id",
      [video]
    )).rows;
  const age = (id: string, minutes: number) =>
    owner.query(`update study_sessions set last_activity_at = now() - make_interval(mins => $2) where id = $1`, [id, minutes]);

  // ------------------------------------------------ 1. grading-mode identity

  describe("dictation idempotency includes the effective grading mode", () => {
    beforeEach(() => newVideo(["Hello", "World"]));

    it("same id + different mode is a conflict; same id + same mode is a side-effect-free retry", async () => {
      const roundId = await create();
      const id = randomUUID();
      const first = await record(roundId, 0, "hello", { id, mode: "exact" });
      expect(first).toMatchObject({ wasInserted: true, isCorrect: false, errorType: "capitalization" });
      const stored = (await owner.query("select match_mode from attempt_logs where id = $1", [first.attemptId])).rows[0];
      expect(stored.match_mode).toBe("exact");

      const snap = async () => ({
        rows: (await owner.query("select id, created_at, is_correct from attempt_logs where session_id = $1 order by id", [roundId])).rows,
        round: (await owner.query("select total_attempts, accuracy, updated_at from learning_sessions where id = $1", [roundId])).rows[0],
        sessions: await videoSessions(),
      });
      const before = await snap();

      // Identical normalized text under 'relaxed' would be CORRECT — the
      // stored exact-mode verdict must not be handed back for it.
      const conflict = await errorOf(record(roundId, 0, "hello", { id, mode: "relaxed" }));
      expect(conflict?.message).toBe("idempotency_key_reused_with_different_payload");
      expect((await errorOf(record(roundId, 0, "hello", { id, mode: "learning" })))?.message).toBe(
        "idempotency_key_reused_with_different_payload"
      );
      expect(await snap()).toEqual(before);

      const retry = await record(roundId, 0, "hello", { id, mode: "exact" });
      expect(retry).toMatchObject({ attemptId: first.attemptId, wasInserted: false, isCorrect: false, matchMode: "exact" });
      expect(await snap()).toEqual(before);

      // A NEW id may submit the same text under another mode.
      const fresh = await record(roundId, 0, "hello", { mode: "relaxed" });
      expect(fresh).toMatchObject({ wasInserted: true, isCorrect: true, matchMode: "relaxed" });
    });

    it("an omitted / null / unknown mode is the effective default 'relaxed' — retries across those forms are the same request", async () => {
      const roundId = await create();
      const id = randomUUID();
      const first = await record(roundId, 0, "hello", { id, mode: "omit" });
      expect(first).toMatchObject({ wasInserted: true, isCorrect: true, matchMode: "relaxed" });
      for (const mode of ["relaxed", null, "bogus", "omit"] as const) {
        const r = await record(roundId, 0, "hello", { id, mode });
        expect(r).toMatchObject({ attemptId: first.attemptId, wasInserted: false });
      }
      expect((await errorOf(record(roundId, 0, "hello", { id, mode: "exact" })))?.message).toBe(
        "idempotency_key_reused_with_different_payload"
      );
    });

    it("a historical attempt with no recorded mode is never matched by inferring one", async () => {
      const roundId = await create();
      const first = await record(roundId, 0, "hello");
      // Simulate a row written before the mode was recorded.
      await owner.query("update attempt_logs set match_mode = null where id = $1", [first.attemptId]);
      const clientId = (await owner.query("select client_attempt_id from attempt_logs where id = $1", [first.attemptId])).rows[0].client_attempt_id;
      const e = await errorOf(record(roundId, 0, "hello", { id: clientId, mode: "relaxed" }));
      expect(e?.message).toBe("idempotency_key_reused_with_different_payload");
      expect((await owner.query("select match_mode from attempt_logs where id = $1", [first.attemptId])).rows[0].match_mode).toBeNull();
    });
  });

  // --------------------------------------------- 2. whitespace-only answers

  describe("whitespace-only answers earn no practice credit", () => {
    const WHITESPACE_ONLY: Array<[string, string]> = [
      ["empty", ""],
      ["space", "   "],
      ["tab", "\t"],
      ["CR/LF", "\r\n"],
      ["VT/FF", "\u000b\u000c"],
      ["NBSP", " "],
      ["em space + ideographic space", " 　"],
      ["line/paragraph separators", "  "],
      ["narrow NBSP + BOM", " ﻿"],
      ["mixed", " \t\r\n      "],
    ];

    it("no whitespace-only submission on the LAST uncovered sentence completes the round; real content does", async () => {
      await newVideo(["Hello there.", "How are you?"]);
      const roundId = await create();
      await record(roundId, 0, "hello there");
      for (const [label, text] of WHITESPACE_ONLY) {
        const r = await record(roundId, 1, text);
        expect({ label, inserted: r.wasInserted, covered: r.progress.coveredSentences.overall, completed: r.roundCompletedByThisRequest, status: r.roundStatus })
          .toEqual({ label, inserted: true, covered: 1, completed: false, status: "active" });
        const valid = (await owner.query("select is_practice_valid from attempt_logs where id = $1", [r.attemptId])).rows[0];
        expect({ label, valid: valid.is_practice_valid }).toEqual({ label, valid: false });
      }
      // Invalid submissions are still kept as history (existing policy).
      const kept = (await owner.query("select count(*)::int n from attempt_logs where session_id = $1 and not is_practice_valid", [roundId])).rows[0].n;
      expect(kept).toBe(WHITESPACE_ONLY.length);

      // A wrong, non-ASCII answer is real content: relaxed grading strips
      // it to nothing, but validity is judged on the raw answer.
      const real = await record(roundId, 1, " Ω\t");
      expect(real).toMatchObject({ isCorrect: false, roundCompletedByThisRequest: true, roundStatus: "completed" });
    });

    it("wrong and hinted non-empty answers keep their practice credit", async () => {
      await newVideo(["Hello there.", "How are you?"]);
      const roundId = await create();
      await rpcAs(owner, userA, "select fn_record_dictation_attempt($1, $2, 0, $3, 'totally wrong', 'relaxed', null, null, 4::smallint)", [roundId, video, randomUUID()]);
      const r = await record(roundId, 1, "\twho knows ");
      expect(r).toMatchObject({ isCorrect: false, roundCompletedByThisRequest: true });
    });
  });

  // ------------------------------------------ 3. study-session attribution

  describe("study-session attribution (supplied and automatic ids follow the same rules)", () => {
    beforeEach(() => newVideo(["Hello there.", "How are you?", "I am fine.", "Thanks."]));

    it("1+4. an active supplied session is reused and modes_used is kept for Dictation and Shadowing", async () => {
      const roundId = await create();
      const a = await record(roundId, 0, "hello there");
      const s = a.studySessionId!;
      await age(s, 5);
      const before = await sessionRow(s);
      const b = await record(roundId, 1, "how are you", { session: s });
      expect(b.studySessionId).toBe(s);
      const sh = await shadow(roundId, 2, 1.5, { session: s });
      expect(sh.studySessionId).toBe(s);
      const after = await sessionRow(s);
      expect(after.ended_at).toBeNull();
      expect(after.last_activity_at.getTime()).toBeGreaterThan(before.last_activity_at.getTime());
      expect(after.modes_used).toEqual(["dictation", "shadowing"]);
      expect(await videoSessions()).toHaveLength(1);
    });

    it("4. automatic attribution also records every mode used", async () => {
      const roundId = await create();
      const sh = await shadow(roundId, 0, 2);
      const dc = await record(roundId, 1, "how are you");
      expect(dc.studySessionId).toBe(sh.studySessionId);
      expect((await sessionRow(sh.studySessionId!)).modes_used).toEqual(["shadowing", "dictation"]);
    });

    it("2. an expired session (> 30 min idle) is never reused, supplied or not", async () => {
      const roundId = await create();
      const s = (await record(roundId, 0, "hello there")).studySessionId!;
      await age(s, 31);
      const viaSupplied = await record(roundId, 1, "how are you", { session: s });
      expect(viaSupplied.studySessionId).not.toBe(s);
      const old = await sessionRow(s);
      expect(old.ended_at).not.toBeNull();
      const fresh = await sessionRow(viaSupplied.studySessionId!);
      expect(fresh).toMatchObject({ round_id: roundId, ended_at: null, modes_used: ["dictation"] });

      // Automatic path: same boundary.
      await age(viaSupplied.studySessionId!, 45);
      const auto = await record(roundId, 2, "i am fine");
      expect(auto.studySessionId).not.toBe(viaSupplied.studySessionId);
      // Shadowing honours the same boundary.
      await age(auto.studySessionId!, 31);
      const sh = await shadow(roundId, 3, 1, { session: auto.studySessionId });
      expect(sh.studySessionId).not.toBe(auto.studySessionId);
      expect(await videoSessions()).toHaveLength(4);
    });

    it("2b. exactly at the 30-minute boundary the session is still reused", async () => {
      const roundId = await create();
      const s = (await record(roundId, 0, "hello there")).studySessionId!;
      await age(s, 29);
      expect((await record(roundId, 1, "how are you", { session: s })).studySessionId).toBe(s);
    });

    it("3. an ended session is never reopened or touched by a supplied id", async () => {
      const roundId = await create();
      const s = (await record(roundId, 0, "hello there")).studySessionId!;
      await owner.query("update study_sessions set ended_at = now() - interval '1 minute' where id = $1", [s]);
      const before = await sessionRow(s);
      const r = await record(roundId, 1, "how are you", { session: s });
      expect(r.studySessionId).not.toBe(s);
      expect(await sessionRow(s)).toEqual(before);
      const sh = await shadow(roundId, 2, 1.5, { session: s });
      expect(sh.studySessionId).toBe(r.studySessionId);
      expect(await sessionRow(s)).toEqual(before);
    });

    it("5. a genuine retry returns the original attempt and attribution with no session writes, even after closure", async () => {
      const roundId = await create();
      const stale = (await record(roundId, 0, "hello there")).studySessionId!;
      await age(stale, 40);
      const id = randomUUID();
      const first = await record(roundId, 1, "how are you", { id, session: stale });
      expect(first.studySessionId).not.toBe(stale); // server-assigned attribution
      const shId = randomUUID();
      const firstSh = await shadow(roundId, 2, 1.5, { id: shId, session: first.studySessionId });

      await owner.query("update study_sessions set ended_at = now() where ended_at is null and youtube_video_id = $1", [video]);
      const snapshot = await videoSessions();
      // Retry with the id the client originally supplied, with none, and
      // with the session the server actually assigned: all the same request.
      for (const session of [stale, null, first.studySessionId]) {
        const retry = await record(roundId, 1, "how are you", { id, session });
        expect(retry).toMatchObject({ attemptId: first.attemptId, wasInserted: false, studySessionId: first.studySessionId });
        const shRetry = await shadow(roundId, 2, 1.5, { id: shId, session });
        expect(shRetry).toMatchObject({ attemptId: firstSh.attemptId, wasInserted: false, studySessionId: firstSh.studySessionId });
      }
      expect(await videoSessions()).toEqual(snapshot);
    });

    it("6. a delayed submission for restarted round A never closes or replaces round B's open session", async () => {
      const roundA = await create();
      const sA = (await record(roundA, 0, "hello there")).studySessionId!;
      const restart = await rpcAs<{ roundId: string }>(owner, userA, "select fn_restart_round($1, $2)", [video, roundA]);
      const roundB = restart.roundId;
      const sB = (await record(roundB, 0, "hello there")).studySessionId!;
      expect(sB).not.toBe(sA);
      const sBBefore = await sessionRow(sB);
      const countBefore = (await videoSessions()).length;

      for (const session of [null, sA]) {
        const late = await record(roundA, 1, "how are you", { session });
        expect(late).toMatchObject({ wasInserted: true, roundStatus: "abandoned", roundCompletedByThisRequest: false, studySessionId: null });
        const lateSh = await shadow(roundA, 2, 2, { session });
        expect(lateSh).toMatchObject({ wasInserted: true, roundStatus: "abandoned", studySessionId: null });
      }
      expect(await sessionRow(sB)).toEqual(sBBefore);
      expect((await videoSessions()).length).toBe(countBefore);
      // Late attempts are kept as round A's history, unattributed.
      const lateRows = (await owner.query(
        "select count(*)::int n from attempt_logs where session_id = $1 and study_session_id is null", [roundA]
      )).rows[0].n;
      expect(lateRows).toBe(2);
      // B keeps using its own session.
      expect((await record(roundB, 1, "how are you")).studySessionId).toBe(sB);
    });

    it("a completed round that is still the latest round keeps attributing to its open session", async () => {
      await newVideo(["Hello there."]);
      const roundId = await create();
      const done = await record(roundId, 0, "hello there");
      expect(done.roundStatus).toBe("completed");
      const more = await record(roundId, 0, "hello there");
      expect(more.studySessionId).toBe(done.studySessionId);
    });

    it("a round-less Listening session is closed (never re-pointed) when round practice starts, supplied or not", async () => {
      const listening = await rpcAs<{ studySessionId: string }>(owner, userA, "select fn_get_or_create_study_session($1, null)", [video]);
      const roundId = await create();
      const r = await record(roundId, 0, "hello there", { session: listening.studySessionId });
      expect(r.studySessionId).not.toBe(listening.studySessionId);
      const l = await sessionRow(listening.studySessionId);
      expect(l.round_id).toBeNull();
      expect(l.ended_at).not.toBeNull();
      expect(await sessionRow(r.studySessionId!)).toMatchObject({ round_id: roundId, ended_at: null, modes_used: ["dictation"] });
    });

    it("rejects cross-user, cross-video and incompatible-round session ids (fresh submissions and retries)", async () => {
      const roundA = await create();
      const sA = (await record(roundA, 0, "hello there")).studySessionId!;
      const bRound = await create(userB);
      const sBUser = (await record(bRound, 0, "hello there", { user: userB })).studySessionId!;

      const otherVideo = video;
      await newVideo(["Other video."]);
      const r2 = await create();
      const sOtherVideo = (await record(r2, 0, "other video")).studySessionId!;
      video = otherVideo;

      const { roundId: roundNext } = await rpcAs<{ roundId: string }>(owner, userA, "select fn_restart_round($1, $2)", [video, roundA]);
      const id = randomUUID();
      await record(roundNext, 1, "how are you", { id });
      for (const session of [sBUser, sOtherVideo, sA]) {
        expect((await errorOf(record(roundNext, 2, "i am fine", { session })))?.message).toBe("study_session_mismatch");
        expect((await errorOf(record(roundNext, 1, "how are you", { id, session })))?.message).toBe("study_session_mismatch");
        expect((await errorOf(shadow(roundNext, 3, 1, { session })))?.message).toBe("study_session_mismatch");
      }
      expect((await errorOf(record(roundNext, 2, "x", { session: randomUUID() })))?.message).toBe("study_session_mismatch");
    });
  });
});
