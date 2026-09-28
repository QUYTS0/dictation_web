/**
 * Phase 4 rollout rehearsal on real PostgreSQL, from the PRODUCTION state:
 * 001–037 applied and the Phase 3 cutover activated, with existing data
 * (including Shadowing attempts written by the already-granted Phase 3
 * function). Then: 00_preflight → apply 038 → 01_postflight, with the
 * operator scripts executed exactly as written. Skipped unless
 * LOCALDB_ADMIN_URL is set.
 */
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import {
  HAS_LOCALDB,
  applyMigration,
  createTestDb,
  createUser,
  publishTranscript,
  rpcAs,
  runCutover,
  type TestDb,
  type PgClient,
} from "./localdb/harness";

const d = HAS_LOCALDB ? describe : describe.skip;
if (!HAS_LOCALDB) console.warn("[phase4-upgrade] skipped — LOCALDB_ADMIN_URL not set");

const DIR = path.resolve(__dirname, "../../../supabase/phase4");
async function runScript(c: PgClient, file: string) {
  const res = await c.query(fs.readFileSync(path.join(DIR, file), "utf8"));
  return Array.isArray(res) ? res : [res];
}
const byField = (results: Array<{ fields?: Array<{ name: string }>; rows: Record<string, unknown>[] }>, name: string) =>
  results.find((r) => r.fields?.some((f) => f.name === name));

d("Phase 4 upgrade 037 → 038 (real PostgreSQL, production state)", () => {
  let db: TestDb;
  let c: PgClient;
  let user: string;
  let roundId = "";

  beforeAll(async () => {
    db = await createTestDb("phase4up", 37);
    c = await db.connect();
    user = await createUser(c);
    await runCutover(c, "activated");
    const tr = await publishTranscript(c, "vidU", ["Alpha.", "Beta."]);
    roundId = (await rpcAs<{ roundId: string }>(c, user, "select fn_create_or_get_active_round($1, $2)", ["vidU", tr])).roundId;
    await rpcAs(c, user, "select fn_record_dictation_attempt($1, 'vidU', 0, $2, 'alpha', 'relaxed', $3, null, null)", [roundId, randomUUID(), tr]);
    await rpcAs(c, user, "select fn_record_shadowing_attempt($1, 'vidU', 1, $2, 2.0, $3, null)", [roundId, randomUUID(), tr]);
  }, 180_000);
  afterAll(async () => {
    await c?.end();
    await db?.drop();
  });

  it("preflight (read-only) confirms Phase 3 is activated and 038 is not applied", async () => {
    const pre = await runScript(c, "00_preflight.sql");
    expect(byField(pre, "stage")?.rows[0]).toEqual({ stage: "activated", ok: true });
    expect(byField(pre, "authoritative_writes_active")?.rows[0].ok).toBe(true);
    expect(byField(pre, "shadow_attempt_granted")?.rows[0]).toEqual({ shadow_attempt_granted: true, create_round_granted: true });
    expect(byField(pre, "begin_fn")?.rows[0]).toEqual({ begin_fn: null, round_results_fn: null, new_columns: "0" });
    expect(byField(pre, "shadowing_attempts")?.rows[0]).toMatchObject({ shadowing_attempts: "1" });
  });

  it("038 applies on the populated database, changes no row, and keeps the Phase 3 app working", async () => {
    const snap = async () => ({
      rounds: (await c.query("select * from learning_sessions order by id")).rows,
      attempts: (await c.query("select * from attempt_logs order by id")).rows,
      shadow: (await c.query("select * from shadowing_attempts order by id")).rows,
      sessions: (await c.query("select * from study_sessions order by id")).rows,
    });
    const before = await snap();
    await applyMigration(c, 38);
    const after = await snap();
    expect(after.rounds).toEqual(before.rounds);
    expect(after.attempts).toEqual(before.attempts);
    expect(after.sessions).toEqual(before.sessions);
    const strip = (rows: Record<string, unknown>[]) =>
      rows.map((row) => {
        const rest = { ...row };
        for (const k of ["azure_detail", "azure_evaluated_at", "word_match_detail", "word_match_evaluated_at"]) {
          expect(rest[k]).toBeNull();
          delete rest[k];
        }
        return rest;
      });
    expect(strip(after.shadow)).toEqual(before.shadow);
    // The deployed Phase 3 app's calls still work unchanged after 038.
    const r = await rpcAs<{ wasInserted: boolean }>(c, user, "select fn_record_shadowing_attempt($1, 'vidU', 0, $2, 1.5, null, null)", [roundId, randomUUID()]);
    expect(r.wasInserted).toBe(true);
  });

  it("postflight (read-only) reports every check ok, including the unchanged Phase 3 privileges", async () => {
    const post = await runScript(c, "01_postflight.sql");
    const results = post.filter((r) => r.fields?.some((f: { name: string }) => f.name === "ok"));
    expect(results).toHaveLength(4);
    for (const r of results) expect(r.rows.filter((row: { ok: boolean }) => !row.ok)).toEqual([]);
    expect(results[0].rows).toHaveLength(4); // new columns
    expect(results[1].rows).toHaveLength(13); // function matrix (incl. the two revoked 035 writers)
    expect(results[2].rows).toHaveLength(9); // security definer / invoker + search_path
    expect(byField(post, "azure_overdue_pending")?.rows[0]).toMatchObject({ shadowing_attempts: "2", azure_overdue_pending: "0" });
  });
});
