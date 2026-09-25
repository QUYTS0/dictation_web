/**
 * Executes the operator scripts in supabase/phase3/ exactly as written, in
 * runbook order, on real PostgreSQL — so the reviewed SQL files are the
 * ones that were actually rehearsed. Skipped unless LOCALDB_ADMIN_URL is set.
 */
import fs from "fs";
import path from "path";
import { HAS_LOCALDB, createTestDb, createUser, publishTranscript, rpcAs, type TestDb, type PgClient } from "./localdb/harness";

const d = HAS_LOCALDB ? describe : describe.skip;
if (!HAS_LOCALDB) console.warn("[phase3-operator-scripts] skipped — LOCALDB_ADMIN_URL not set");

const DIR = path.resolve(__dirname, "../../../supabase/phase3");
async function runScript(c: PgClient, file: string) {
  const res = await c.query(fs.readFileSync(path.join(DIR, file), "utf8"));
  return Array.isArray(res) ? res : [res];
}

d("supabase/phase3 operator scripts (real PostgreSQL)", () => {
  let db: TestDb;
  let c: PgClient;
  let user: string;
  beforeAll(async () => {
    db = await createTestDb("scripts");
    c = await db.connect();
    user = await createUser(c);
    await publishTranscript(c, "vidS", ["Alpha.", "Beta."]);
    await rpcAs(c, user, `select fn_legacy_save_progress(p_session_id => null, p_youtube_video_id => 'vidS', p_transcript_id => null,
      p_current_segment_index => 1, p_video_current_time_sec => 2, p_accuracy => 0, p_total_attempts => 0, p_status => 'active')`);
  }, 180_000);
  afterAll(async () => {
    await c?.end();
    await db?.drop();
  });

  it("00 → 02 → 03 → 04 → (90 recovery) → 03 → 04 → 05 → 06 run cleanly and end activated with a clean matrix", async () => {
    const pre = await runScript(c, "00_preflight.sql");
    expect(pre.length).toBeGreaterThan(5);
    await runScript(c, "02_restrict_direct_writes.sql");
    await runScript(c, "03_close_gate.sql");
    await runScript(c, "90_recovery_reopen_legacy.sql");
    await runScript(c, "03_close_gate.sql");
    const bf = await runScript(c, "04_backfill.sql");
    const left = bf.find((r) => r.fields?.some((f: { name: string }) => f.name === "current_rounds_left"));
    expect(left?.rows[0].current_rounds_left).toBe("0");
    await runScript(c, "05_activate.sql");
    const post = await runScript(c, "06_postflight.sql");
    const status = post[0].rows[0].status;
    expect(status.stage).toBe("activated");
    const matrix = post.find((r) => r.fields?.some((f: { name: string }) => f.name === "ok"));
    expect(matrix?.rows.length).toBe(25);
    expect(matrix?.rows.filter((r: { ok: boolean }) => !r.ok)).toEqual([]);
    const legacy = post.find((r) => r.fields?.some((f: { name: string }) => f.name === "legacy_save"));
    expect(legacy?.rows[0]).toEqual({ legacy_save: null, legacy_restart: null, legacy_record: null });
    const grants = post.find((r) => r.fields?.some((f: { name: string }) => f.name === "privileges"));
    for (const row of grants?.rows ?? []) {
      expect({ ...row, privileges: row.privileges }).toMatchObject({ privileges: "SELECT" });
    }
  });
});
