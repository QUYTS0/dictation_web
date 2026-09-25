/**
 * Recovery boundaries of the Phase 3 cutover on real PostgreSQL (the ones
 * not already exercised by phase3-cutover-rehearsal): out-of-order calls,
 * a gate close that times out while a writer holds the gate, and returning
 * to legacy after the pause but before any backfill.
 * Skipped unless LOCALDB_ADMIN_URL is set (see localdb/harness.ts).
 */
import {
  HAS_LOCALDB,
  createTestDb,
  createUser,
  publishTranscript,
  rpcAs,
  beginAs,
  errorOf,
  type TestDb,
  type PgClient,
} from "./localdb/harness";

const d = HAS_LOCALDB ? describe : describe.skip;
if (!HAS_LOCALDB) console.warn("[phase3-recovery] skipped — LOCALDB_ADMIN_URL not set");

const SAVE = `select fn_legacy_save_progress(p_session_id => null, p_youtube_video_id => 'vidR', p_transcript_id => null,
  p_current_segment_index => $1, p_video_current_time_sec => 0, p_accuracy => 0, p_total_attempts => 0, p_status => 'active')`;

d("Phase 3 recovery boundaries (real PostgreSQL)", () => {
  let db: TestDb;
  let owner: PgClient;
  let c2: PgClient;
  let user: string;

  beforeAll(async () => {
    db = await createTestDb("recovery");
    owner = await db.connect();
    c2 = await db.connect();
    user = await createUser(owner);
    await publishTranscript(owner, "vidR", ["One.", "Two."]);
  }, 180_000);
  afterAll(async () => {
    for (const c of [owner, c2]) await c?.end().catch(() => {});
    await db?.drop();
  });

  it("stages cannot run out of order before restriction (nothing changes)", async () => {
    for (const fn of ["fn_phase3_close_gate", "fn_phase3_backfill", "fn_phase3_activate", "fn_phase3_reopen_legacy"]) {
      expect((await errorOf(owner.query(`select ${fn}()`)))?.message).toMatch(/precondition_failed/);
    }
    const st = (await owner.query("select fn_phase3_status() s")).rows[0].s;
    expect(st.stage).toBe("prepared");
    expect(st.gate.completion_writes_paused).toBe(false);
    // Legacy keeps working: failing before restriction needs no recovery.
    await rpcAs(owner, user, SAVE, [0]);
  });

  it("restriction is idempotent", async () => {
    await owner.query("select fn_phase3_restrict_direct_writes()");
    const again = (await owner.query("select fn_phase3_restrict_direct_writes() s")).rows[0].s;
    expect(again.stage).toBe("restricted");
    expect(again.learningSessionsPolicies).toEqual(["learning_sessions_owner_select"]);
  });

  it("a gate close that cannot get the lock in time fails cleanly: gate stays open, legacy keeps working", async () => {
    await beginAs(c2, "authenticated", user);
    await c2.query(SAVE, [1]); // an admitted writer holding FOR SHARE, stuck
    await owner.query("set lock_timeout = '300ms'"); // the operator's own bound is honored
    const e = await errorOf(owner.query("select fn_phase3_close_gate()"));
    await owner.query("reset lock_timeout");
    expect(e?.code).toBe("55P03"); // lock_not_available → the whole transaction rolled back
    await c2.query("commit");
    const st = (await owner.query("select fn_phase3_status() s")).rows[0].s;
    expect(st).toMatchObject({ stage: "restricted", cutoverAt: null });
    expect(st.gate.completion_writes_paused).toBe(false);
    await rpcAs(owner, user, SAVE, [1]);
  });

  it("paused but not backfilled: returning to legacy is a plain reopen and loses nothing", async () => {
    const closed = (await owner.query("select fn_phase3_close_gate() s")).rows[0].s;
    expect(closed.stage).toBe("paused");
    expect((await errorOf(rpcAs(owner, user, SAVE, [0])))?.message).toBe("write_gate_paused");
    const reopened = (await owner.query("select fn_phase3_reopen_legacy() s")).rows[0].s;
    expect(reopened.stage).toBe("restricted");
    expect(reopened.gate.completion_writes_paused).toBe(false);
    expect((await owner.query("select count(*)::int n from phase3_backfill_rounds")).rows[0].n).toBe(0);
    await rpcAs(owner, user, SAVE, [0]);
    // Closing again records a new boundary and the full cutover still completes.
    await owner.query("select fn_phase3_close_gate()");
    await owner.query("select fn_phase3_backfill()");
    const active = (await owner.query("select fn_phase3_activate() s")).rows[0].s;
    expect(active.stage).toBe("activated");
    const r = await rpcAs<{ created: boolean }>(owner, user, "select fn_create_or_get_active_round('vidR')");
    expect(r.created).toBe(false); // the legacy active round (now legacy_unverified) is reused
    const events = (await owner.query("select event from phase3_cutover_log order by id")).rows.map((x) => x.event);
    expect(events.filter((e: string) => e === "close_gate")).toHaveLength(2);
  });
});
