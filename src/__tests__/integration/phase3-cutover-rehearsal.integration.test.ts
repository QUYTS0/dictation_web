/**
 * Phase 3 cutover REHEARSAL on real PostgreSQL, upgrading from 036.
 *
 * 1. Build a database at migration 036 (what the user's project runs today)
 *    and seed representative historical data through the paths that really
 *    existed: raw owner inserts (pre-Phase-2 era rows, incl. anomalies) and
 *    the Phase 2 bridges called AS `authenticated` / `service_role`.
 * 2. Apply 037 and prove it activated nothing.
 * 3. Walk the runbook: restrict → close (draining an admitted writer held
 *    open on another connection) → backfill (audited, rerun-safe) →
 *    activate (with a legacy call QUEUED behind the activation transaction)
 *    → authoritative writes work, legacy cannot write.
 * Every blocked-lock claim is observed via pg_stat_activity, not a sleep.
 * Skipped unless LOCALDB_ADMIN_URL is set (see localdb/harness.ts).
 */
import { randomUUID } from "crypto";
import {
  HAS_LOCALDB,
  createTestDb,
  applyMigration,
  createUser,
  publishTranscript,
  rpcAs,
  asRole,
  beginAs,
  backendPid,
  waitUntilBlocked,
  errorOf,
  type TestDb,
  type PgClient,
} from "./localdb/harness";

const d = HAS_LOCALDB ? describe : describe.skip;
if (!HAS_LOCALDB) console.warn("[phase3-cutover-rehearsal] skipped — LOCALDB_ADMIN_URL not set");

const SAVE = `select fn_legacy_save_progress(p_session_id => $1, p_youtube_video_id => $2, p_transcript_id => $3,
  p_current_segment_index => $4, p_video_current_time_sec => 1, p_accuracy => 50, p_total_attempts => 2, p_status => $5)`;
const RECORD_LEGACY = `select fn_legacy_record_dictation_attempt($1, $2, $3, $4, $5, $6, $7, null)`;

d("Phase 3 cutover rehearsal (036 → 037 → activated)", () => {
  let db: TestDb;
  let owner: PgClient;
  let c2: PgClient;
  let c3: PgClient;
  let userA: string;
  let userB: string;
  let tA: string; // current transcript of video "vidA"
  const ids: Record<string, string> = {};
  let cutoverAt: Date;

  beforeAll(async () => {
    db = await createTestDb("rehearsal", 36);
    owner = await db.connect();
    c2 = await db.connect();
    c3 = await db.connect();
    userA = await createUser(owner);
    userB = await createUser(owner);
    tA = await publishTranscript(owner, "vidA", ["Hello there.", "How are you?", "I am fine.", "Thanks!"]);
    await publishTranscript(owner, "vidB", ["One.", "Two."]);
  }, 180_000);

  afterAll(async () => {
    for (const c of [owner, c2, c3]) await c?.end().catch(() => {});
    await db?.drop();
  });

  it("seeds historical data at 036 through the paths that existed", async () => {
    // Pre-Phase-2-era rows written directly (as the old routes did), incl. anomalies.
    const ins = async (user: string | null, video: string, status: string, started: string, updated: string, transcript: string | null) =>
      (
        await owner.query(
          `insert into learning_sessions (user_id, youtube_video_id, status, started_at, updated_at, transcript_id, accuracy, total_attempts)
           values ($1, $2, $3, $4, $5, $6, 80, 5) returning id`,
          [user, video, status, started, updated, transcript]
        )
      ).rows[0].id as string;
    ids.completedOld = await ins(userA, "vidA", "completed", "2026-01-01T10:00:00Z", "2026-01-01T11:00:00Z", tA);
    ids.abandonedOld = await ins(userA, "vidA", "abandoned", "2026-01-02T10:00:00Z", "2026-01-02T10:30:00Z", tA);
    ids.unpinned = await ins(userB, "vidA", "completed", "2026-01-03T10:00:00Z", "2026-01-03T09:00:00Z", null); // updated < started
    ids.anon1 = await ins(null, "vidA", "active", "2026-01-04T10:00:00Z", "2026-01-04T10:00:00Z", tA);
    ids.anon2 = await ins(null, "vidA", "active", "2026-01-04T09:00:00Z", "2026-01-04T09:00:00Z", tA);
    ids.future = await ins(userB, "vidB", "abandoned", "2999-01-01T00:00:00Z", "2999-01-01T00:00:00Z", null);

    // Attempts on the old completed round: one matches the pinned text, one doesn't.
    await owner.query(
      `insert into attempt_logs (session_id, segment_index, expected_text, user_text, is_correct)
       values ($1, 0, 'Hello there.', 'hello there', true), ($1, 1, 'How r u', 'how are you', false), ($1, 9, 'Gone', 'gone', true)`,
      [ids.completedOld]
    );

    // Phase 2 era: the active round via the bridge AS the user, attempts via the service bridge.
    const r = await rpcAs<{ sessionId: string }>(owner, userA, SAVE, [null, "vidA", tA, 1, "active"]);
    ids.activeA = r.sessionId;
    await asRole(owner, "service_role", null, async () => {
      await owner.query(RECORD_LEGACY, [ids.activeA, 0, "Hello there.", "hello there", "hello there", "hello there", true]);
      await owner.query(RECORD_LEGACY, [ids.activeA, 1, "How are you?", "how are u", "how are you", "how are u", false]);
    });
    const counts = (await owner.query("select count(*)::int n from learning_sessions")).rows[0].n;
    expect(counts).toBe(7);
  });

  it("037 applies on top of 036 with data and activates nothing", async () => {
    const before = (await owner.query("select id, provenance, status, round_number, updated_at from learning_sessions order by id")).rows;
    const attemptsBefore = (await owner.query("select * from attempt_logs order by id")).rows;
    await applyMigration(owner, 37);
    const after = (await owner.query("select id, provenance, status, round_number, updated_at from learning_sessions order by id")).rows;
    expect(after).toEqual(before); // no row touched
    // The new match_mode column is NULL (= never recorded) on every existing attempt; nothing else changed.
    const attemptsAfter = (await owner.query("select * from attempt_logs order by id")).rows;
    expect(attemptsAfter.map(({ match_mode, ...rest }) => { expect(match_mode).toBeNull(); return rest; })).toEqual(attemptsBefore);

    // Legacy bridge still serves the app...
    const r = await rpcAs<{ sessionId: string }>(owner, userA, SAVE, [ids.activeA, "vidA", tA, 2, "active"]);
    expect(r.sessionId).toBe(ids.activeA);
    // ...authoritative functions are not callable by any app role...
    for (const role of ["authenticated", "anon", "service_role"] as const) {
      const e = await errorOf(rpcAs(owner, userA, "select fn_create_or_get_active_round($1)", ["vidA"], role));
      expect(e?.code).toBe("42501");
    }
    // ...and refuse even the owner until activation.
    await owner.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: userA, role: "authenticated" })]);
    const ownerCall = await errorOf(owner.query("select fn_create_or_get_active_round('vidA')"));
    expect(ownerCall?.message).toBe("write_gate_paused");
    await owner.query(`select set_config('request.jwt.claims', '', false)`);
  });

  it("step 1 prerequisite: explain-all's replacement works for service_role only", async () => {
    const ok = await rpcAs<boolean>(owner, userA, "select fn_persist_session_assessment($1, $2, $3::jsonb)", [ids.completedOld, userA, '{"summary":"x"}'], "service_role");
    expect(ok).toBe(true);
    const wrongUser = await rpcAs<boolean>(owner, userB, "select fn_persist_session_assessment($1, $2, $3::jsonb)", [ids.completedOld, userB, '{"summary":"y"}'], "service_role");
    expect(wrongUser).toBe(false);
    const denied = await errorOf(rpcAs(owner, userA, "select fn_persist_session_assessment($1, $2, $3::jsonb)", [ids.completedOld, userA, "{}"]));
    expect(denied?.code).toBe("42501");
    const row = (await owner.query("select ai_assessment, updated_at from learning_sessions where id = $1", [ids.completedOld])).rows[0];
    expect(row.ai_assessment).toEqual({ summary: "x" });
    expect(new Date(row.updated_at).toISOString()).toBe("2026-01-01T11:00:00.000Z"); // not practice activity
  });

  it("step 2: direct writes to learning_sessions are closed; owner SELECT and bridges keep working", async () => {
    // Before: the old owner policy allows a direct lifecycle write.
    await asRole(owner, "authenticated", userA, () => owner.query("update learning_sessions set status = status where id = $1", [ids.activeA]), { rollback: true });

    await owner.query("select fn_phase3_restrict_direct_writes()");

    for (const sql of [
      "update learning_sessions set status = 'completed' where id = $1",
      "delete from learning_sessions where id = $1",
    ]) {
      const e = await errorOf(asRole(owner, "authenticated", userA, () => owner.query(sql, [ids.activeA])));
      expect(e?.code).toBe("42501");
    }
    const insertErr = await errorOf(
      asRole(owner, "authenticated", userA, () => owner.query("insert into learning_sessions (user_id, youtube_video_id) values ($1, 'vidZ')", [userA]))
    );
    expect(insertErr?.code).toBe("42501");
    const anonErr = await errorOf(asRole(owner, "anon", null, () => owner.query("insert into learning_sessions (user_id, youtube_video_id) values (null, 'vidZ')")));
    expect(anonErr?.code).toBe("42501");
    const serviceErr = await errorOf(asRole(owner, "service_role", null, () => owner.query("update learning_sessions set status = 'completed' where id = $1", [ids.activeA])));
    expect(serviceErr?.code).toBe("42501");
    const serviceAttemptErr = await errorOf(
      asRole(owner, "service_role", null, () =>
        owner.query("insert into attempt_logs (session_id, segment_index, expected_text, user_text) values ($1, 0, 'a', 'a')", [ids.activeA])
      )
    );
    expect(serviceAttemptErr?.code).toBe("42501");

    const own = await asRole(owner, "authenticated", userA, () => owner.query("select id from learning_sessions"));
    expect(own.rows.map((r) => r.id).sort()).toEqual([ids.completedOld, ids.abandonedOld, ids.activeA].sort());

    // explain-all replacement still works after restriction.
    expect(await rpcAs(owner, userA, "select fn_persist_session_assessment($1, $2, '{\"s\":1}'::jsonb)", [ids.completedOld, userA], "service_role")).toBe(true);
    // Bridges are SECURITY DEFINER and unaffected.
    await rpcAs(owner, userA, SAVE, [ids.activeA, "vidA", tA, 3, "active"]);
  });

  it("step 3: closing the gate drains an admitted bridge writer, then paused calls are refused without writing", async () => {
    // c2: a bridge call already admitted (holds FOR SHARE), not yet committed.
    await beginAs(c2, "authenticated", userA);
    await c2.query(SAVE, [ids.activeA, "vidA", tA, 3, "active"]);
    const closePid = await backendPid(c3);
    const closing = c3.query("select fn_phase3_close_gate() as s");
    await waitUntilBlocked(owner, closePid); // the fence really waits for c2
    await c2.query("commit");
    const status = (await closing).rows[0].s;
    expect(status.stage).toBe("paused");
    cutoverAt = new Date(status.cutoverAt);
    const drained = (await owner.query("select updated_at from learning_sessions where id = $1", [ids.activeA])).rows[0].updated_at;
    expect(new Date(drained).getTime()).toBeLessThanOrEqual(cutoverAt.getTime());

    // Later bridge calls: refused, nothing written.
    const before = (await owner.query("select count(*)::int n, max(updated_at) m from learning_sessions")).rows[0];
    for (const call of [
      () => rpcAs(owner, userA, SAVE, [null, "vidB", null, 0, "active"]),
      () => rpcAs(owner, userA, "select fn_legacy_restart_round('vidA', null)"),
      () => rpcAs(owner, userA, RECORD_LEGACY, [ids.activeA, 2, "I am fine.", "i am fine", "i am fine", "i am fine", true], "service_role"),
    ]) {
      expect((await errorOf(call()))?.message).toBe("write_gate_paused");
    }
    const after = (await owner.query("select count(*)::int n, max(updated_at) m from learning_sessions")).rows[0];
    expect(after).toEqual(before);

    // Retrying the close keeps the recorded boundary.
    const again = (await owner.query("select fn_phase3_close_gate() as s")).rows[0].s;
    expect(new Date(again.cutoverAt).getTime()).toBe(cutoverAt.getTime());
  });

  it("step 4 failure: a backfill that aborts leaves no trace, and can be retried", async () => {
    await owner.query("create function noop_trg() returns trigger language plpgsql as $$ begin return new; end $$");
    await owner.query("create trigger stray_trg before update on learning_sessions for each row execute function noop_trg()");
    const e = await errorOf(owner.query("select fn_phase3_backfill()"));
    expect(e?.message).toMatch(/unexpected triggers present/);
    expect((await owner.query("select stage from phase3_cutover_state")).rows[0].stage).toBe("paused");
    expect((await owner.query("select count(*)::int n from phase3_backfill_rounds")).rows[0].n).toBe(0);
    expect((await owner.query("select count(*)::int n from learning_sessions where provenance = 'legacy_unverified'")).rows[0].n).toBe(0);
    await owner.query("drop trigger stray_trg on learning_sessions");
  });

  it("step 4: the backfill classifies the whole cohort, keeps originals, and never touches updated_at", async () => {
    const before = new Map(
      (await owner.query("select id, updated_at, status, total_attempts from learning_sessions")).rows.map((r) => [r.id, r])
    );
    const status = (await owner.query("select fn_phase3_backfill() as s")).rows[0].s;
    expect(status.stage).toBe("backfilled");
    const summary = status.backfillSummary;
    expect(summary.rounds).toBe(7);
    expect(summary.completedAtInferred).toBe(2);
    expect(summary.anomalies).toMatchObject({
      anonymous_row: 2,
      no_transcript_pin: 2,
      started_after_cutover: 1,
      updated_before_started: 1,
      updated_after_cutover: 1,
    });
    expect(summary.attemptIdentity).toMatchObject({
      resolved_text_match: 3, // 1 old + 2 written through the Phase 2 bridge
      unresolved_text_mismatch: 1,
      unresolved_no_segment: 1,
    });

    const rows = (await owner.query("select * from learning_sessions")).rows;
    for (const r of rows) {
      expect(r.provenance).toBe("legacy_unverified");
      expect(new Date(r.updated_at).getTime()).toBe(new Date(before.get(r.id).updated_at).getTime());
      expect(r.status).toBe(before.get(r.id).status);
    }
    const byId = new Map(rows.map((r) => [r.id, r]));
    // Deterministic numbering per (user, video) by started_at; anonymous rows never grouped.
    expect(byId.get(ids.completedOld).round_number).toBe(1);
    expect(byId.get(ids.abandonedOld).round_number).toBe(2);
    expect(byId.get(ids.activeA).round_number).toBe(3);
    expect(byId.get(ids.anon1).round_number).toBe(1);
    expect(byId.get(ids.anon2).round_number).toBe(1);
    // Required counts by the same eligibility rule; unknown stays null.
    expect(byId.get(ids.activeA).required_sentence_count).toBe(4);
    expect(byId.get(ids.unpinned).required_sentence_count).toBeNull();
    // Completion time inferred from the last update, bounded, and flagged approximate.
    expect(new Date(byId.get(ids.completedOld).completed_at).toISOString()).toBe("2026-01-01T11:00:00.000Z");
    expect(byId.get(ids.completedOld).completed_at_approximate).toBe(true);
    expect(new Date(byId.get(ids.unpinned).completed_at).toISOString()).toBe("2026-01-03T10:00:00.000Z"); // max(updated, started)

    // Originals captured.
    const orig = (await owner.query("select * from phase3_backfill_rounds where round_id = $1", [ids.completedOld])).rows[0];
    expect(orig).toMatchObject({ orig_provenance: "current", orig_round_number: 1, orig_completed_at: null });

    // Attempts: identity only filled on a verified text match; hint stays unknown.
    const atts = (await owner.query("select segment_index, segment_identity_provenance, segment_id, hint_level_used from attempt_logs where session_id = $1 order by segment_index", [ids.completedOld])).rows;
    expect(atts.map((a) => a.segment_identity_provenance)).toEqual(["legacy_unverified", "legacy_unverified", "legacy_unverified"]);
    expect(atts[0].segment_id).not.toBeNull();
    expect(atts[1].segment_id).toBeNull(); // text mismatch → not repinned
    expect(atts.every((a) => a.hint_level_used === null)).toBe(true);
    // No grading mode is inferred for historical attempts.
    expect((await owner.query("select count(*)::int n from attempt_logs where match_mode is not null")).rows[0].n).toBe(0);

    // Rerun is a no-op.
    const snapshot = (await owner.query("select * from phase3_backfill_rounds order by round_id")).rows;
    const rerun = (await owner.query("select fn_phase3_backfill() as s")).rows[0].s;
    expect(rerun.backfillRuns).toBe(1);
    expect((await owner.query("select * from phase3_backfill_rounds order by round_id")).rows).toEqual(snapshot);
  });

  it("recovery: return to legacy before activation, new legacy writes are captured by the next batch only", async () => {
    await owner.query("select fn_phase3_reopen_legacy()");
    const r = await rpcAs<{ sessionId: string }>(owner, userB, SAVE, [null, "vidB", null, 0, "active"]);
    ids.interimB = r.sessionId;
    expect((await owner.query("select provenance from learning_sessions where id = $1", [ids.interimB])).rows[0].provenance).toBe("current");

    const status = (await owner.query("select fn_phase3_close_gate() as s")).rows[0].s;
    expect(new Date(status.cutoverAt).getTime()).toBeGreaterThan(cutoverAt.getTime()); // a new, recorded boundary
    cutoverAt = new Date(status.cutoverAt);
    const firstBatch = (await owner.query("select * from phase3_backfill_rounds where batch = 1 order by round_id")).rows;
    const s2 = (await owner.query("select fn_phase3_backfill() as s")).rows[0].s;
    expect(s2.backfillSummary.batch).toBe(2);
    expect(s2.backfillSummary.rounds).toBe(1);
    expect((await owner.query("select * from phase3_backfill_rounds where batch = 1 order by round_id")).rows).toEqual(firstBatch);
    const interim = (await owner.query("select provenance, round_number from learning_sessions where id = $1", [ids.interimB])).rows[0];
    expect(interim).toEqual({ provenance: "legacy_unverified", round_number: 2 }); // continues after the earlier batch (future row = 1)
    const log = (await owner.query("select event from phase3_cutover_log order by id")).rows.map((x) => x.event);
    expect(log).toEqual(expect.arrayContaining(["close_gate", "backfill", "reopen_legacy"]));
  });

  it("steps 5–6: a legacy call queued behind activation cannot write after the gate reopens", async () => {
    // c3 runs the activation transaction and keeps it open.
    await c3.query("begin");
    await c3.query("select fn_phase3_activate()");
    // c2: a legacy request that already started executing the bridge body
    // now waits for the gate row the activation transaction holds.
    const legacyPid = await backendPid(c2);
    const legacy = rpcAs(c2, userA, SAVE, [ids.activeA, "vidA", tA, 3, "active"]).then(
      () => null,
      (e: { message: string }) => e
    );
    await waitUntilBlocked(owner, legacyPid);
    const before = (await owner.query("select updated_at, current_segment_index from learning_sessions where id = $1", [ids.activeA])).rows[0];
    await c3.query("commit"); // gate reopens, legacy retired, bridges dropped
    const err = await legacy;
    expect(err?.message).toBe("legacy_writes_retired");
    const after = (await owner.query("select updated_at, current_segment_index from learning_sessions where id = $1", [ids.activeA])).rows[0];
    expect(after).toEqual(before);

    // A delayed legacy request arriving later finds no function at all.
    const late = await errorOf(rpcAs(owner, userA, SAVE, [ids.activeA, "vidA", tA, 3, "active"]));
    expect(late?.code).toBe("42883");

    const gate = (await owner.query("select * from app_write_gate")).rows[0];
    expect(gate).toMatchObject({ completion_writes_paused: false, legacy_writes_retired: true, authoritative_writes_active: true });
    const st = (await owner.query("select fn_phase3_status() as s")).rows[0].s;
    expect(st.stage).toBe("activated");
    expect(Object.values(st.legacyBridgesPresent)).toEqual([false, false, false]);
  });

  it("after activation: authoritative writes work for the owner of the round only; roles match the final matrix", async () => {
    const sigs = [
      "fn_create_or_get_active_round(text,uuid,integer,numeric)",
      "fn_update_resume_position(uuid,text,integer,numeric,uuid)",
      "fn_restart_round(text,uuid)",
      "fn_record_dictation_attempt(uuid,text,integer,uuid,text,text,uuid,uuid,smallint)",
      "fn_record_shadowing_attempt(uuid,text,integer,uuid,numeric,uuid,uuid)",
    ];
    for (const s of sigs) {
      const r = (
        await owner.query(
          `select has_function_privilege('authenticated', $1, 'EXECUTE') as auth, has_function_privilege('anon', $1, 'EXECUTE') as anon,
                  has_function_privilege('service_role', $1, 'EXECUTE') as svc`,
          [s]
        )
      ).rows[0];
      expect({ sig: s, ...r }).toEqual({ sig: s, auth: true, anon: false, svc: false });
    }

    // The legacy active round keeps its provenance even with new verified attempts.
    const rec = await rpcAs<{ wasInserted: boolean }>(
      owner,
      userA,
      "select fn_record_dictation_attempt($1, 'vidA', 2, $2, 'I am fine.')",
      [ids.activeA, randomUUID()]
    );
    expect(rec.wasInserted).toBe(true);
    const row = (await owner.query("select provenance from learning_sessions where id = $1", [ids.activeA])).rows[0];
    expect(row.provenance).toBe("legacy_unverified");
    const newest = (await owner.query("select segment_identity_provenance from attempt_logs where session_id = $1 and segment_index = 2", [ids.activeA])).rows[0];
    expect(newest.segment_identity_provenance).toBe("verified");

    // Another user cannot write to it.
    const e = await errorOf(rpcAs(owner, userB, "select fn_record_dictation_attempt($1, 'vidA', 3, $2, 'Thanks!')", [ids.activeA, randomUUID()]));
    expect(e?.message).toBe("round_not_found");

    // Post-activation backfill/reopen are refused; the retirement flag is permanent.
    expect((await errorOf(owner.query("select fn_phase3_backfill()")))?.message).toMatch(/precondition_failed/);
    expect((await errorOf(owner.query("select fn_phase3_reopen_legacy()")))?.message).toMatch(/precondition_failed/);
    expect((await errorOf(owner.query("update app_write_gate set legacy_writes_retired = false")))?.message).toBe(
      "legacy_writes_retired_is_permanent"
    );
    // service_role may operate the pause flag but not the activation flags.
    const flip = await errorOf(asRole(owner, "service_role", null, () => owner.query("update app_write_gate set authoritative_writes_active = false")));
    expect(flip?.code).toBe("42501");
  });

  it("a later maintenance pause fences the authoritative writers too", async () => {
    await owner.query("update app_write_gate set completion_writes_paused = true");
    const e = await errorOf(rpcAs(owner, userA, "select fn_update_resume_position($1, 'vidA', 1, 1)", [ids.activeA]));
    expect(e?.message).toBe("write_gate_paused");
    const status = await rpcAs<{ available: boolean }>(owner, userA, "select fn_practice_write_status()");
    expect(status.available).toBe(false);
    await owner.query("update app_write_gate set completion_writes_paused = false");
    expect((await rpcAs<{ available: boolean }>(owner, userA, "select fn_practice_write_status()")).available).toBe(true);
  });
});
