/**
 * Phase 4 — Shadowing persistence on real PostgreSQL (001–038 applied, the
 * Phase 3 cutover run to `activated`, exactly the production state). Every
 * call runs as the role PostgREST would use: user RPCs as `authenticated`
 * with a JWT subject, backend RPCs as `service_role`.
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
if (!HAS_LOCALDB) console.warn("[phase4-shadowing] skipped — LOCALDB_ADMIN_URL not set");

type Progress = { coveredSentences: { dictation: number; shadowing: number; overall: number }; requiredSentenceCount: number };
type ShadowRec = {
  attemptId: string;
  wasInserted: boolean;
  isPracticeValid: boolean;
  studySessionId: string | null;
  roundCompletedByThisRequest: boolean;
  roundStatus: string;
  progress: Progress;
};
type Finish = { applied: boolean; outcome: string; currentSeq: number; status: string };

const CREATE = "select fn_create_or_get_active_round($1, $2)";
const SHADOW = "select fn_record_shadowing_attempt($1, $2, $3, $4, $5, $6, $7)";
const DICTATE = "select fn_record_dictation_attempt($1, $2, $3, $4, $5, 'relaxed', $6, null, null)";
const BEGIN = "select fn_begin_azure_evaluation($1, $2, $3)";
const FINISH =
  "select fn_finish_azure_evaluation($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)";
const EXPIRE = "select fn_expire_azure_evaluation($1, $2, $3)";
const WORD_MATCH = "select fn_record_word_match($1, $2, $3, $4, $5, $6::jsonb)";

d("Phase 4 Shadowing persistence (real PostgreSQL, activated)", () => {
  let db: TestDb;
  let owner: PgClient;
  let c2: PgClient;
  let c3: PgClient;
  let userA: string;
  let userB: string;
  let video = "";
  let transcriptId = "";
  const TEXTS = ["Hello there.", "How are you?", "…", "I am fine."]; // index 2 is ineligible

  beforeAll(async () => {
    db = await createTestDb("phase4");
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

  const round = async (user = userA) =>
    (await rpcAs<{ roundId: string }>(owner, user, CREATE, [video, transcriptId])).roundId;
  const shadow = (
    roundId: string,
    seg: number,
    dur: number,
    o: { id?: string; user?: string; video?: string; transcript?: string | null; session?: string | null; c?: PgClient } = {}
  ) =>
    rpcAs<ShadowRec>(o.c ?? owner, o.user ?? userA, SHADOW, [
      roundId, o.video ?? video, seg, o.id ?? randomUUID(), dur, o.transcript === undefined ? transcriptId : o.transcript, o.session ?? null,
    ]);
  const svc = <T = Record<string, unknown>>(sql: string, params: unknown[]) => rpcAs<T>(owner, userA, sql, params, "service_role");
  type Begin = { admitted: boolean; outcome: string; seq: number; referenceText: string; recordingDurationSec: string };
  const begin = (attemptId: string, user = userA, audioSec = 2) => svc<Begin>(BEGIN, [attemptId, user, audioSec]);
  /** Makes the live pending request of `attemptId` overdue, so a replacement is admitted. */
  const expireLive = (attemptId: string) =>
    owner.query("update shadowing_attempts set eval_requested_at = clock_timestamp() - interval '10 minutes' where id = $1", [attemptId]);
  const finish = (attemptId: string, seq: number, status: "completed" | "failed", o: { user?: string; pron?: number; reason?: string; detail?: unknown } = {}) =>
    svc<Finish>(FINISH, [
      attemptId, o.user ?? userA, seq, status,
      status === "completed" ? (o.pron ?? 81) : null,
      status === "completed" ? 90 : null,
      status === "completed" ? 70 : null,
      status === "completed" ? 100 : null,
      null, // prosody not returned → stays unavailable
      status === "completed" ? JSON.stringify(o.detail ?? { recognizedText: "hello there", words: [{ word: "hello", accuracyScore: 95, errorType: "None" }] }) : null,
      status === "failed" ? (o.reason ?? "provider_error") : null,
      "test-engine",
    ]);
  const row = async (attemptId: string) =>
    (await owner.query("select * from shadowing_attempts where id = $1", [attemptId])).rows[0];
  const age = (attemptId: string, seconds: number) =>
    owner.query("update shadowing_attempts set eval_requested_at = clock_timestamp() - make_interval(secs => $2) where id = $1", [attemptId, seconds]);

  // ------------------------------------------------------ practice credit

  it("1. a saved recording earns practice credit with no evaluation at all; validity basis stays client_reported", async () => {
    const roundId = await round();
    const r = await shadow(roundId, 0, 2.4);
    expect(r).toMatchObject({ wasInserted: true, isPracticeValid: true, roundStatus: "active" });
    expect(r.progress.coveredSentences).toMatchObject({ shadowing: 1, overall: 1 });
    const stored = await row(r.attemptId);
    expect(stored).toMatchObject({ validity_basis: "client_reported", azure_eval_status: "not_evaluated", word_match_status: null });
  });

  it("2. a too-short recording is stored as history but earns no coverage and cannot be evaluated", async () => {
    const roundId = await round();
    const r = await shadow(roundId, 0, 0.3);
    expect(r).toMatchObject({ wasInserted: true, isPracticeValid: false });
    expect(r.progress.coveredSentences.overall).toBe(0);
    expect((await errorOf(begin(r.attemptId)))?.message).toBe("attempt_not_evaluable");
    expect((await errorOf(shadow(roundId, 0, -1)))?.message).toBe("invalid_payload");
  });

  it("3. retry returns the same attempt with no side effects; conflicting reuse is refused", async () => {
    const roundId = await round();
    const id = randomUUID();
    const first = await shadow(roundId, 0, 2, { id });
    const snap = async () => ({
      rows: (await owner.query("select id, created_at, updated_at, study_session_id from shadowing_attempts where round_id = $1", [roundId])).rows,
      round: (await owner.query("select updated_at, status from learning_sessions where id = $1", [roundId])).rows[0],
      sessions: (await owner.query("select id, last_activity_at, modes_used from study_sessions where youtube_video_id = $1", [video])).rows,
    });
    const before = await snap();
    const retry = await shadow(roundId, 0, 2, { id });
    expect(retry).toMatchObject({ attemptId: first.attemptId, wasInserted: false, studySessionId: first.studySessionId, roundCompletedByThisRequest: false });
    expect(await snap()).toEqual(before);
    for (const p of [() => shadow(roundId, 0, 3, { id }), () => shadow(roundId, 1, 2, { id })]) {
      expect((await errorOf(p()))?.message).toBe("idempotency_key_reused_with_different_payload");
    }
    // A new recording of the same sentence is a new attempt.
    expect((await shadow(roundId, 0, 2)).wasInserted).toBe(true);
  });

  it("4. cross-user, wrong-video, wrong-segment and revision mismatches are rejected", async () => {
    const roundId = await round();
    expect((await errorOf(shadow(roundId, 0, 2, { user: userB })))?.message).toBe("round_not_found");
    expect((await errorOf(shadow(roundId, 0, 2, { video: "other-video" })))?.message).toBe("round_not_found");
    expect((await errorOf(shadow(roundId, 99, 2)))?.message).toBe("segment_not_found");
    expect((await errorOf(shadow(roundId, 0, 2, { transcript: randomUUID() })))?.message).toBe("stale_transcript_revision");
    // Relationship check on evaluation too: another user's attempt does not exist for them.
    const mine = await shadow(roundId, 0, 2);
    expect((await errorOf(begin(mine.attemptId, userB)))?.message).toBe("attempt_not_found");
    expect((await errorOf(svc(WORD_MATCH, [mine.attemptId, userB, "failed", null, null, null])))?.message).toBe("attempt_not_found");
  });

  it("5. the reference text comes from the attempt's pinned sentence, even after a newer revision is published", async () => {
    const roundId = await round();
    const a = await shadow(roundId, 1, 2);
    await publishTranscript(owner, video, ["Totally different.", "Other words now."]);
    const b = await begin(a.attemptId);
    expect(b).toMatchObject({ seq: 1, referenceText: "How are you?" });
    expect(Number(b.recordingDurationSec)).toBe(2);
  });

  it("6. Dictation + Shadowing on the same sentence count once; the round completes through Shadowing", async () => {
    const roundId = await round();
    await rpcAs(owner, userA, DICTATE, [roundId, video, 0, randomUUID(), "hello there", transcriptId]);
    const s0 = await shadow(roundId, 0, 2);
    expect(s0.progress.coveredSentences).toEqual({ dictation: 1, shadowing: 1, overall: 1 });
    await shadow(roundId, 1, 2);
    const last = await shadow(roundId, 3, 2);
    expect(last).toMatchObject({ roundCompletedByThisRequest: true, roundStatus: "completed" });
    const retry = await shadow(roundId, 3, 2); // new id, round already complete
    expect(retry.roundCompletedByThisRequest).toBe(false);
  });

  it("7. concurrent final-sentence submissions (Dictation + Shadowing) complete the round exactly once", async () => {
    const roundId = await round();
    await shadow(roundId, 0, 2);
    await beginAs(c2, "authenticated", userA);
    const r1 = Object.values((await c2.query(SHADOW, [roundId, video, 1, randomUUID(), 2, transcriptId, null])).rows[0])[0] as ShadowRec;
    const pid = await backendPid(c3);
    const p2 = rpcAs<{ roundCompletedByThisRequest: boolean; roundStatus: string }>(c3, userA, DICTATE, [roundId, video, 3, randomUUID(), "i am fine", transcriptId]);
    await waitUntilBlocked(owner, pid);
    await c2.query("commit");
    const r2 = await p2;
    expect([r1.roundCompletedByThisRequest, r2.roundCompletedByThisRequest].filter(Boolean)).toHaveLength(1);
    expect(r2.roundStatus).toBe("completed");
  });

  // -------------------------------------------------- evaluation lifecycle

  it("8. Azure and Word Match sequences are independent", async () => {
    const roundId = await round();
    const a = await shadow(roundId, 0, 2);
    const b1 = await begin(a.attemptId);
    const wm = await svc<{ seq: number; applied: boolean }>(WORD_MATCH, [a.attemptId, userA, "completed", 50, 100, JSON.stringify({ recognizedText: "hello" })]);
    expect(wm).toMatchObject({ applied: true, seq: 1 });
    await expireLive(a.attemptId);
    const b2 = await begin(a.attemptId);
    expect([b1.seq, b2.seq]).toEqual([1, 2]);
    const stored = await row(a.attemptId);
    expect(stored).toMatchObject({ azure_eval_request_seq: 2, word_match_request_seq: 1, word_match_status: "completed", azure_eval_status: "pending" });
    // A Word Match write never touched the Azure state and vice versa.
    await finish(a.attemptId, 2, "failed");
    expect(await row(a.attemptId)).toMatchObject({ word_match_status: "completed", word_match_accuracy: "50" });
  });

  it("9. an older success or failure can never overwrite the newer request's result", async () => {
    const roundId = await round();
    const a = await shadow(roundId, 0, 2);
    await begin(a.attemptId); // seq 1
    await expireLive(a.attemptId); // seq 1 never finished in time
    await begin(a.attemptId); // seq 2 replaces it
    expect(await finish(a.attemptId, 1, "completed", { pron: 10 })).toMatchObject({ applied: false, outcome: "superseded", currentSeq: 2 });
    expect(await finish(a.attemptId, 1, "failed")).toMatchObject({ applied: false, outcome: "superseded" });
    expect(await row(a.attemptId)).toMatchObject({ azure_eval_status: "pending", azure_pronunciation_score: null });
    expect(await finish(a.attemptId, 2, "completed", { pron: 81 })).toMatchObject({ applied: true, outcome: "applied" });
    // A late failure for the same seq keeps the stored success.
    expect(await finish(a.attemptId, 2, "failed")).toMatchObject({ applied: false, outcome: "conflict", status: "completed" });
    const stored = await row(a.attemptId);
    expect(stored).toMatchObject({ azure_eval_status: "completed", azure_pronunciation_score: "81", azure_prosody_score: null });
    expect(stored.azure_evaluated_at).not.toBeNull();
    // One successful evaluation per recording: no paid re-score, nothing changes.
    expect(await begin(a.attemptId)).toMatchObject({ admitted: false, outcome: "already_evaluated", seq: 2 });
    expect((await row(a.attemptId)).azure_eval_request_seq).toBe(2);
  });

  it("10. timeout recovery only expires its own overdue seq, never a newer request", async () => {
    const roundId = await round();
    const a = await shadow(roundId, 0, 2);
    await begin(a.attemptId); // seq 1
    await age(a.attemptId, 600);
    await begin(a.attemptId); // seq 2, fresh (seq 1 was overdue)
    expect(await svc(EXPIRE, [a.attemptId, userA, 1])).toEqual({ expired: false }); // superseded seq
    expect(await svc(EXPIRE, [a.attemptId, userA, 2])).toEqual({ expired: false }); // not overdue
    expect((await row(a.attemptId)).azure_eval_status).toBe("pending");
    await age(a.attemptId, 600);
    expect(await svc(EXPIRE, [a.attemptId, userA, 2])).toEqual({ expired: true });
    expect(await row(a.attemptId)).toMatchObject({ azure_eval_status: "failed", azure_error_reason: "expired" });
    // The real (paid) result of that same newest request still lands.
    expect(await finish(a.attemptId, 2, "completed")).toMatchObject({ applied: true });
    // And the read path reports an overdue pending request as expired without writing.
    const b = await shadow(roundId, 1, 2);
    await begin(b.attemptId);
    await age(b.attemptId, 600);
    const dto = await rpcAs<{ azure: { status: string; errorReason: string } }>(owner, userA, "select fn_get_shadowing_attempt($1)", [b.attemptId]);
    expect(dto.azure).toMatchObject({ status: "failed", errorReason: "expired" });
    expect((await row(b.attemptId)).azure_eval_status).toBe("pending");
  });

  it("11. a provider failure keeps practice credit and every other attempt's results", async () => {
    const roundId = await round();
    const good = await shadow(roundId, 0, 2);
    await begin(good.attemptId);
    await finish(good.attemptId, 1, "completed");
    const bad = await shadow(roundId, 1, 2);
    await begin(bad.attemptId);
    expect(await finish(bad.attemptId, 1, "failed", { reason: "No speech was recognized" })).toMatchObject({ applied: true });
    expect(await row(bad.attemptId)).toMatchObject({ is_practice_valid: true, azure_eval_status: "failed", azure_error_reason: "No speech was recognized" });
    expect((await row(good.attemptId)).azure_eval_status).toBe("completed");
    // A failed evaluation can be retried on the same saved recording.
    expect((await begin(bad.attemptId)).seq).toBe(2);
    const progress = (await shadow(roundId, 1, 2)).progress; // new take on sentence 1
    expect(progress.coveredSentences.shadowing).toBe(2);
  });

  it("12–13. recovery writes are idempotent and refused once superseded", async () => {
    const roundId = await round();
    const a = await shadow(roundId, 0, 2);
    await begin(a.attemptId);
    // First write "lost" (never happened); the recovery write lands once…
    expect(await finish(a.attemptId, 1, "completed", { pron: 77 })).toMatchObject({ outcome: "applied" });
    const after = await row(a.attemptId);
    // …and a replay of the same token is reported, not re-applied.
    expect(await finish(a.attemptId, 1, "completed", { pron: 77 })).toMatchObject({ applied: false, outcome: "already_applied" });
    expect((await row(a.attemptId)).updated_at).toEqual(after.updated_at);
    // Supersession: a token for seq 1 after the user re-evaluated (seq 2).
    const b = await shadow(roundId, 1, 2);
    await begin(b.attemptId);
    await expireLive(b.attemptId);
    await begin(b.attemptId);
    expect(await finish(b.attemptId, 1, "completed")).toMatchObject({ applied: false, outcome: "superseded" });
    // Account mismatch: the token's attempt is not the other user's.
    expect((await errorOf(finish(b.attemptId, 2, "completed", { user: userB })))?.message).toBe("attempt_not_found");
    // Out-of-range or incomplete scores are refused.
    expect((await errorOf(finish(b.attemptId, 2, "completed", { pron: 180 })))?.message).toBe("invalid_payload");
  });

  it("Word Match: server-computed result stored once per recording; identical retry is a no-op", async () => {
    const roundId = await round();
    const a = await shadow(roundId, 0, 2);
    const detail = JSON.stringify({ recognizedText: "hello", problemWords: [{ word: "there", errorType: "missing" }] });
    expect(await svc(WORD_MATCH, [a.attemptId, userA, "completed", 50, 50, detail])).toMatchObject({ applied: true, seq: 1 });
    expect(await svc(WORD_MATCH, [a.attemptId, userA, "completed", 50, 50, detail])).toMatchObject({ applied: false, outcome: "already_applied" });
    expect((await errorOf(svc(WORD_MATCH, [a.attemptId, userA, "completed", 100, 100, detail])))?.message).toBe("word_match_already_recorded");
    expect((await errorOf(svc(WORD_MATCH, [a.attemptId, userA, "completed", 120, 100, detail])))?.message).toBe("invalid_payload");
    // An unsupported/failed recognition can later be replaced by a real result.
    const b = await shadow(roundId, 1, 2);
    await svc(WORD_MATCH, [b.attemptId, userA, "unsupported", null, null, null]);
    expect(await svc(WORD_MATCH, [b.attemptId, userA, "completed", 100, 100, null])).toMatchObject({ applied: true, seq: 2 });
  });

  // --------------------------------------------------------------- reads

  it("14. a reload restores every saved result from the server; the three 'latest' pointers stay distinct and chronological", async () => {
    const roundId = await round();
    const old = await shadow(roundId, 0, 2);
    await begin(old.attemptId);
    await finish(old.attemptId, 1, "completed", { pron: 95 });
    const mid = await shadow(roundId, 0, 2);
    await svc(WORD_MATCH, [mid.attemptId, userA, "completed", 60, 80, JSON.stringify({ recognizedText: "hello" })]);
    await begin(mid.attemptId);
    await finish(mid.attemptId, 1, "completed", { pron: 40 }); // lower score but later
    const latest = await shadow(roundId, 0, 2); // not evaluated
    for (let i = 0; i < 5; i++) {
      const extra = await shadow(roundId, 1, 2);
      await begin(extra.attemptId);
      await finish(extra.attemptId, 1, "completed", { pron: 50 + i });
    }
    type Seg = {
      segmentIndex: number;
      attemptCount: number;
      latestAttempt: { attemptId: string; azure: { status: string; detail: unknown } };
      latestSuccessfulAzureAttempt: { attemptId: string; azure: { pronunciationScore: number; prosodyScore: number | null; detail: { words: unknown[] } } };
      latestWordMatchAttempt: { attemptId: string; wordMatch: { accuracy: number; detail: { recognizedText: string } } };
      azureHistory: Array<{ attemptId: string; pronunciationScore: number }>;
    };
    const res = await rpcAs<{ transcriptId: string; roundStatus: string; segments: Seg[] }>(owner, userA, "select fn_shadowing_round_results($1)", [roundId]);
    expect(res).toMatchObject({ transcriptId, roundStatus: "active" });
    const s0 = res.segments.find((s) => s.segmentIndex === 0)!;
    expect(s0.attemptCount).toBe(3);
    expect(s0.latestAttempt.attemptId).toBe(latest.attemptId);
    expect(s0.latestAttempt.azure.status).toBe("not_evaluated");
    expect(s0.latestAttempt.azure.detail).toBeNull(); // light pointer
    expect(s0.latestSuccessfulAzureAttempt.attemptId).toBe(mid.attemptId); // chronological, not best (95)
    expect(s0.latestSuccessfulAzureAttempt.azure).toMatchObject({ pronunciationScore: 40, prosodyScore: null });
    expect(s0.latestSuccessfulAzureAttempt.azure.detail.words).toHaveLength(1);
    expect(s0.latestWordMatchAttempt).toMatchObject({ attemptId: mid.attemptId, wordMatch: { accuracy: 60, detail: { recognizedText: "hello" } } });
    expect(s0.azureHistory.map((h) => h.pronunciationScore)).toEqual([95, 40]);
    const s1 = res.segments.find((s) => s.segmentIndex === 1)!;
    expect(s1.azureHistory.map((h) => h.pronunciationScore)).toEqual([50, 51, 52, 53, 54]); // capped at 5, oldest first

    // Owner-only: another user sees neither the round nor the attempt.
    expect((await errorOf(rpcAs(owner, userB, "select fn_shadowing_round_results($1)", [roundId])))?.message).toBe("round_not_found");
    expect((await errorOf(rpcAs(owner, userB, "select fn_get_shadowing_attempt($1)", [latest.attemptId])))?.message).toBe("attempt_not_found");
  });

  it("15. a delayed recording for a restarted round stays with that round and never touches the new one", async () => {
    const roundA = await round();
    const firstA = await shadow(roundA, 0, 2);
    const { roundId: roundB } = await rpcAs<{ roundId: string }>(owner, userA, "select fn_restart_round($1, $2)", [video, roundA]);
    const inB = await shadow(roundB, 0, 2);
    const late = await shadow(roundA, 1, 2);
    expect(late).toMatchObject({ wasInserted: true, roundStatus: "abandoned", studySessionId: null });
    expect(late.progress.coveredSentences.shadowing).toBe(2);
    const b = await rpcAs<{ segments: Array<{ segmentIndex: number; latestAttempt: { attemptId: string } }> }>(owner, userA, "select fn_shadowing_round_results($1)", [roundB]);
    expect(b.segments.map((s) => s.latestAttempt.attemptId)).toEqual([inB.attemptId]);
    // Evaluating the old round's recording still resolves ITS sentence.
    expect((await begin(firstA.attemptId)).referenceText).toBe("Hello there.");
  });

  it("permissions: backend lifecycle functions are service_role-only; reads are authenticated-only", async () => {
    const roundId = await round();
    const a = await shadow(roundId, 0, 2);
    for (const [sql, params] of [
      [BEGIN, [a.attemptId, userA, 2]],
      [FINISH, [a.attemptId, userA, 1, "failed", null, null, null, null, null, null, "x", null]],
      [EXPIRE, [a.attemptId, userA, 1]],
      [WORD_MATCH, [a.attemptId, userA, "failed", null, null, null]],
    ] as const) {
      for (const role of ["authenticated", "anon"] as const) {
        expect((await errorOf(rpcAs(owner, userA, sql, [...params], role)))?.code).toBe("42501");
      }
    }
    for (const sql of ["select fn_get_shadowing_attempt($1)", "select fn_shadowing_round_results($1)"]) {
      const arg = sql.includes("round") ? roundId : a.attemptId;
      for (const role of ["anon", "service_role"] as const) {
        expect((await errorOf(rpcAs(owner, userA, sql, [arg], role)))?.code).toBe("42501");
      }
    }
    // Direct table writes stay closed for users.
    expect((await errorOf(rpcAs(owner, userA, "update shadowing_attempts set azure_pronunciation_score = 100 where id = $1", [a.attemptId])))?.code).toBe("42501");
    // Phase 3's matrix is untouched: learning_sessions/attempt_logs remain SELECT-only.
    const grants = (await owner.query(
      `select table_name, string_agg(privilege_type, ',' order by privilege_type) p from information_schema.role_table_grants
        where table_schema='public' and table_name in ('learning_sessions','attempt_logs') and grantee='authenticated' group by 1 order by 1`
    )).rows;
    expect(grants).toEqual([{ table_name: "attempt_logs", p: "SELECT" }, { table_name: "learning_sessions", p: "SELECT" }]);
  });
});
