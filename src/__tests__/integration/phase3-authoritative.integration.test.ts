/**
 * Authoritative round/attempt functions after activation — real PostgreSQL,
 * every call made AS `authenticated` with a real user identity (PostgREST
 * style: SET LOCAL ROLE + request.jwt.claims). Concurrency uses separate
 * connections with lock waits observed in pg_stat_activity.
 * Skipped unless LOCALDB_ADMIN_URL is set (see localdb/harness.ts).
 */
import { randomUUID } from "crypto";
import {
  HAS_LOCALDB,
  createTestDb,
  createUser,
  publishTranscript,
  rpcAs,
  beginAs,
  backendPid,
  waitUntilBlocked,
  errorOf,
  runCutover,
  type TestDb,
  type PgClient,
} from "./localdb/harness";

const d = HAS_LOCALDB ? describe : describe.skip;
if (!HAS_LOCALDB) console.warn("[phase3-authoritative] skipped — LOCALDB_ADMIN_URL not set");

type Rec = {
  attemptId: string;
  wasInserted: boolean;
  isCorrect: boolean;
  errorType: string;
  roundCompletedByThisRequest: boolean;
  roundStatus: string;
  studySessionId: string;
  progress: {
    requiredSentenceCount: number | null;
    coveredSentences: { dictation: number; shadowing: number; overall: number };
    attemptCount: number;
    sentenceAccuracy: { correct: number; practiced: number; percent: number | null };
  };
};
const CREATE = "select fn_create_or_get_active_round($1, $2, $3, $4)";
const RECORD = "select fn_record_dictation_attempt($1, $2, $3, $4, $5, 'relaxed', $6, $7, $8)";
const SHADOW = "select fn_record_shadowing_attempt($1, $2, $3, $4, $5)";

d("authoritative functions (activated, real PostgreSQL)", () => {
  let db: TestDb;
  let owner: PgClient;
  let c2: PgClient;
  let c3: PgClient;
  let userA: string;
  let userB: string;
  let video = "";
  let transcriptId = "";
  const TEXTS = ["Hello there.", "How are you?", "…", "I am fine."]; // index 2 has no eligible text

  beforeAll(async () => {
    db = await createTestDb("authoritative");
    owner = await db.connect();
    c2 = await db.connect();
    c3 = await db.connect();
    userA = await createUser(owner);
    userB = await createUser(owner);
    await runCutover(owner, "activated");
  }, 180_000);
  afterAll(async () => {
    for (const c of [owner, c2, c3]) await c?.end().catch(() => {});
    await db?.drop();
  });
  beforeEach(async () => {
    video = `v-${randomUUID().slice(0, 8)}`;
    transcriptId = await publishTranscript(owner, video, TEXTS);
  });

  const create = (user = userA, expected: string | null = null, seg: number | null = null, t: number | null = null) =>
    rpcAs<{ roundId: string; created: boolean; transcriptId: string; requiredSentenceCount: number; roundNumber: number }>(
      owner, user, CREATE, [video, expected, seg, t]
    );
  const record = (roundId: string, seg: number, text: string, id = randomUUID(), opts: { user?: string; transcript?: string | null; session?: string | null; hint?: number | null; c?: PgClient } = {}) =>
    rpcAs<Rec>(opts.c ?? owner, opts.user ?? userA, RECORD, [roundId, video, seg, id, text, opts.transcript ?? null, opts.session ?? null, opts.hint ?? null]);

  // ---------------------------------------------------------------- rounds

  it("create: required count uses the eligibility rule; checkpoint applied atomically; get returns the same round", async () => {
    const r = await create(userA, transcriptId, 1, 3.5);
    expect(r).toMatchObject({ created: true, transcriptId, requiredSentenceCount: 3, roundNumber: 1 });
    const row = (await owner.query("select current_segment_index, video_current_time, provenance from learning_sessions where id = $1", [r.roundId])).rows[0];
    expect(row).toEqual({ current_segment_index: 1, video_current_time: "3.5", provenance: "current" });
    const again = await create(userA, transcriptId, 2, 5);
    expect(again).toMatchObject({ roundId: r.roundId, created: false });
  });

  it("create: a stale client transcript is rejected BEFORE any round exists (no partial mutation)", async () => {
    const e = await errorOf(create(userA, randomUUID()));
    expect(e?.message).toBe("stale_transcript_revision");
    const n = (await owner.query("select count(*)::int n from learning_sessions where youtube_video_id = $1", [video])).rows[0].n;
    expect(n).toBe(0);
  });

  it("create: two concurrent first saves produce exactly one active round", async () => {
    await beginAs(c2, "authenticated", userA);
    await c2.query(CREATE, [video, transcriptId, 0, 0]);
    const pid = await backendPid(c3);
    const second = rpcAs<{ roundId: string; created: boolean }>(c3, userA, CREATE, [video, transcriptId, 0, 0]);
    await waitUntilBlocked(owner, pid);
    await c2.query("commit");
    const r2 = await second;
    expect(r2.created).toBe(false);
    const n = (await owner.query("select count(*)::int n from learning_sessions where youtube_video_id = $1 and status = 'active'", [video])).rows[0].n;
    expect(n).toBe(1);
  });

  it("resume: owner-only, pin-checked, never writes a non-active round, never touches lifecycle fields", async () => {
    const { roundId } = await create();
    const other = await errorOf(rpcAs(owner, userB, "select fn_update_resume_position($1, $2, 1, 2)", [roundId, video]));
    expect(other?.message).toBe("round_not_found");
    const stale = await errorOf(rpcAs(owner, userA, "select fn_update_resume_position($1, $2, 1, 2, $3)", [roundId, video, randomUUID()]));
    expect(stale?.message).toBe("stale_transcript_revision");
    const bad = await errorOf(rpcAs(owner, userA, "select fn_update_resume_position($1, $2, -1, 2)", [roundId, video]));
    expect(bad?.message).toBe("invalid_payload");
    const ok = await rpcAs<{ applied: boolean }>(owner, userA, "select fn_update_resume_position($1, $2, 3, 7.25, $3)", [roundId, video, transcriptId]);
    expect(ok.applied).toBe(true);
    await rpcAs(owner, userA, "select fn_restart_round($1, $2)", [video, roundId]);
    const late = await rpcAs<{ applied: boolean; roundStatus: string }>(owner, userA, "select fn_update_resume_position($1, $2, 0, 0)", [roundId, video]);
    expect(late).toEqual({ roundId, applied: false, roundStatus: "abandoned" });
  });

  it("restart: preserves history, is retry-safe, closes the study session, and resolves the transcript first", async () => {
    const { roundId } = await create();
    const rec = await record(roundId, 0, "hello there");
    const first = await rpcAs<{ roundId: string; created: boolean; roundNumber: number; abandonedRoundId: string }>(
      owner, userA, "select fn_restart_round($1, $2)", [video, roundId]
    );
    expect(first).toMatchObject({ created: true, roundNumber: 2, abandonedRoundId: roundId });
    const retry = await rpcAs<{ roundId: string; created: boolean }>(owner, userA, "select fn_restart_round($1, $2)", [video, roundId]);
    expect(retry).toMatchObject({ roundId: first.roundId, created: false });
    const rows = (await owner.query("select id, status from learning_sessions where youtube_video_id = $1 order by round_number", [video])).rows;
    expect(rows).toEqual([{ id: roundId, status: "abandoned" }, { id: first.roundId, status: "active" }]);
    const kept = (await owner.query("select count(*)::int n from attempt_logs where session_id = $1", [roundId])).rows[0].n;
    expect(kept).toBe(1);
    const ss = (await owner.query("select ended_at from study_sessions where id = $1", [rec.studySessionId])).rows[0];
    expect(ss.ended_at).not.toBeNull();

    // No ready transcript → nothing is abandoned.
    await owner.query("update transcripts set is_current = false where youtube_video_id = $1", [video]);
    const e = await errorOf(rpcAs(owner, userA, "select fn_restart_round($1, $2)", [video, first.roundId]));
    expect(e?.message).toBe("transcript_not_ready");
    expect((await owner.query("select status from learning_sessions where id = $1", [first.roundId])).rows[0].status).toBe("active");
  });

  it("restart: two concurrent restarts of the same round create exactly one new round", async () => {
    const { roundId } = await create();
    await beginAs(c2, "authenticated", userA);
    await c2.query("select fn_restart_round($1, $2)", [video, roundId]);
    const pid = await backendPid(c3);
    const second = rpcAs<{ created: boolean }>(c3, userA, "select fn_restart_round($1, $2)", [video, roundId]);
    await waitUntilBlocked(owner, pid);
    await c2.query("commit");
    expect((await second).created).toBe(false);
    const n = (await owner.query("select count(*)::int n from learning_sessions where youtube_video_id = $1", [video])).rows[0].n;
    expect(n).toBe(2);
  });

  // -------------------------------------------------------------- attempts

  it("attempts: correctness is computed server-side from the pinned segment; relationships are validated", async () => {
    const { roundId } = await create();
    const wrong = await record(roundId, 0, "Hello their");
    expect(wrong).toMatchObject({ wasInserted: true, isCorrect: false, errorType: "wrong_form" });
    const right = await record(roundId, 1, "how are you");
    expect(right.isCorrect).toBe(true);

    expect((await errorOf(record(roundId, 0, "x", randomUUID(), { user: userB })))?.message).toBe("round_not_found");
    expect((await errorOf(record(roundId, 0, "x", randomUUID(), { transcript: randomUUID() })))?.message).toBe("stale_transcript_revision");
    expect((await errorOf(record(roundId, 99, "x")))?.message).toBe("segment_not_found");
    const bRound = await create(userB);
    const bSession = await rpcAs<Rec>(owner, userB, RECORD, [bRound.roundId, video, 0, randomUUID(), "hi", null, null, null]);
    expect((await errorOf(record(roundId, 0, "x", randomUUID(), { session: bSession.studySessionId })))?.message).toBe("study_session_mismatch");
    expect((await errorOf(record(roundId, 0, "x", randomUUID(), { hint: 9 })))?.message).toBe("invalid_payload");
    // Anonymous and service_role callers are refused outright.
    for (const role of ["anon", "service_role"] as const) {
      const e = await errorOf(rpcAs(owner, userA, RECORD, [roundId, video, 0, randomUUID(), "x", null, null, null], role));
      expect(e?.code).toBe("42501");
    }
  });

  it("idempotency: a retry returns the original attempt with no new row, timestamp or counter change", async () => {
    const { roundId } = await create();
    const id = randomUUID();
    const first = await record(roundId, 0, "hello there", id, { hint: 1 });
    const snap = async () => ({
      rows: (await owner.query("select id, created_at from attempt_logs where session_id = $1", [roundId])).rows,
      round: (await owner.query("select total_attempts, accuracy, updated_at from learning_sessions where id = $1", [roundId])).rows[0],
      sessions: (await owner.query("select id, last_activity_at from study_sessions where round_id = $1", [roundId])).rows,
    });
    const before = await snap();
    const retry = await record(roundId, 0, "hello there", id, { hint: 1 });
    expect(retry).toMatchObject({ attemptId: first.attemptId, wasInserted: false, roundCompletedByThisRequest: false, studySessionId: first.studySessionId });
    expect(await snap()).toEqual(before);

    // Same key, different payload → stable conflict.
    for (const p of [
      () => record(roundId, 0, "hello THERE!", id, { hint: 1 }),
      () => record(roundId, 1, "hello there", id, { hint: 1 }),
      () => record(roundId, 0, "hello there", id, { hint: 2 }),
    ]) {
      expect((await errorOf(p()))?.message).toBe("idempotency_key_reused_with_different_payload");
    }
    // A genuinely new submission on the same sentence is a new attempt.
    const again = await record(roundId, 0, "hello there");
    expect(again.wasInserted).toBe(true);
    expect(again.progress.attemptCount).toBe(2);
    expect(again.progress.sentenceAccuracy).toEqual({ correct: 1, practiced: 1, percent: 100 });
  });

  it("accuracy: latest attempt per sentence; counters keep their legacy attempt-based meaning", async () => {
    const { roundId } = await create();
    await record(roundId, 0, "wrong words here");
    await record(roundId, 0, "hello there");
    const r = await record(roundId, 1, "how are u");
    expect(r.progress.sentenceAccuracy).toEqual({ correct: 1, practiced: 2, percent: 50 });
    expect(r.progress.attemptCount).toBe(3);
    const row = (await owner.query("select total_attempts, accuracy from learning_sessions where id = $1", [roundId])).rows[0];
    expect(row).toEqual({ total_attempts: 3, accuracy: "33" }); // 1 correct ÷ 3 submissions
  });

  it("completion: wrong/hinted practice counts; ineligible sentences don't; completes exactly once; never resurrected", async () => {
    const { roundId } = await create();
    await record(roundId, 0, "totally wrong", randomUUID(), { hint: 3 });
    const mid = await record(roundId, 2, "…"); // ineligible sentence (no text) — never counts
    expect(mid.progress.coveredSentences.overall).toBe(1);
    await record(roundId, 1, "how are you");
    const last = await record(roundId, 3, "nope");
    expect(last).toMatchObject({ roundCompletedByThisRequest: true, roundStatus: "completed" });
    const completedAt = (await owner.query("select completed_at from learning_sessions where id = $1", [roundId])).rows[0].completed_at;
    const late = await record(roundId, 3, "i am fine");
    expect(late).toMatchObject({ wasInserted: true, roundCompletedByThisRequest: false, roundStatus: "completed" });
    expect((await owner.query("select completed_at from learning_sessions where id = $1", [roundId])).rows[0].completed_at).toEqual(completedAt);
  });

  it("completion race: two concurrent final submissions complete the round exactly once", async () => {
    const { roundId } = await create();
    await record(roundId, 0, "hello there");
    await beginAs(c2, "authenticated", userA);
    const r1 = (await c2.query(RECORD, [roundId, video, 1, randomUUID(), "how are you", null, null, null])).rows[0];
    const pid = await backendPid(c3);
    const p2 = rpcAs<Rec>(c3, userA, RECORD, [roundId, video, 3, randomUUID(), "i am fine", null, null, null]);
    await waitUntilBlocked(owner, pid);
    await c2.query("commit");
    const r2 = await p2;
    const first = Object.values(r1)[0] as Rec;
    const flags = [first.roundCompletedByThisRequest, r2.roundCompletedByThisRequest];
    expect(flags.filter(Boolean)).toHaveLength(1);
    expect(r2.roundStatus).toBe("completed");
  });

  it("mixed-mode coverage counts a sentence practiced in both modes once; Shadowing validity is server-computed", async () => {
    const { roundId } = await create();
    await record(roundId, 0, "hello there");
    const s = await rpcAs<Rec & { isPracticeValid: boolean }>(owner, userA, SHADOW, [roundId, video, 0, randomUUID(), 2.0]);
    expect(s.progress.coveredSentences).toEqual({ dictation: 1, shadowing: 1, overall: 1 });
    const tooShort = await rpcAs<{ isPracticeValid: boolean }>(owner, userA, SHADOW, [roundId, video, 1, randomUUID(), 0.2]);
    expect(tooShort.isPracticeValid).toBe(false);
    const s2 = await rpcAs<Rec>(owner, userA, SHADOW, [roundId, video, 1, randomUUID(), 1.5]);
    expect(s2.progress.coveredSentences.overall).toBe(2);
  });

  it("an empty/unknown required count never auto-completes", async () => {
    const v = `v-${randomUUID().slice(0, 8)}`;
    await publishTranscript(owner, v, ["…"]);
    video = v;
    const { roundId, requiredSentenceCount } = await create();
    expect(requiredSentenceCount).toBe(0);
    const r = await record(roundId, 0, "anything");
    expect(r).toMatchObject({ roundCompletedByThisRequest: false, roundStatus: "active" });
    expect(r.progress.coveredSentences.overall).toBe(0);
  });

  it("abandoned rounds accept history but are never reactivated", async () => {
    const { roundId } = await create();
    await rpcAs(owner, userA, "select fn_restart_round($1, $2)", [video, roundId]);
    for (const [i, t] of [[0, "hello there"], [1, "how are you"], [3, "i am fine"]] as const) {
      const r = await record(roundId, i, t);
      expect(r).toMatchObject({ roundCompletedByThisRequest: false, roundStatus: "abandoned" });
    }
  });

  it("study sessions: attribution reuses the open session for the round and is created only by real practice", async () => {
    const { roundId } = await create();
    expect((await owner.query("select count(*)::int n from study_sessions where round_id = $1", [roundId])).rows[0].n).toBe(0);
    const a = await record(roundId, 0, "hello there");
    const b = await record(roundId, 1, "how are you");
    expect(b.studySessionId).toBe(a.studySessionId);
    const modes = (await owner.query("select modes_used from study_sessions where id = $1", [a.studySessionId])).rows[0].modes_used;
    expect(modes).toEqual(["dictation"]);
  });

  it("owner SELECT only: users see their own rounds/attempts, nobody writes tables directly", async () => {
    const { roundId } = await create();
    await record(roundId, 0, "hello there");
    const seenByB = await rpcAs<number>(owner, userB, "select count(*)::int from attempt_logs where session_id = $1", [roundId]);
    expect(seenByB).toBe(0);
    const seenByA = await rpcAs<number>(owner, userA, "select count(*)::int from attempt_logs where session_id = $1", [roundId]);
    expect(seenByA).toBe(1);
    const direct = await errorOf(rpcAs(owner, userA, "update attempt_logs set is_correct = true where session_id = $1 returning 1", [roundId]));
    expect(direct?.code).toBe("42501");
  });
});
