/**
 * Real PostgreSQL: migrations 001–037 apply cleanly (on the Supabase shim),
 * and 037 by itself activates nothing. Skipped unless LOCALDB_ADMIN_URL
 * points at a local disposable server (see localdb/harness.ts).
 */
import { HAS_LOCALDB, createTestDb, type TestDb, type PgClient } from "./localdb/harness";

const d = HAS_LOCALDB ? describe : describe.skip;
if (!HAS_LOCALDB) console.warn("[phase3-migrations-apply] skipped — LOCALDB_ADMIN_URL not set");

d("migrations 001–037 on real PostgreSQL", () => {
  let db: TestDb;
  let c: PgClient;
  beforeAll(async () => {
    db = await createTestDb("apply");
    c = await db.connect();
  }, 120_000);
  afterAll(async () => {
    await c?.end();
    await db?.drop();
  });

  it("037 leaves the system in legacy mode: bridges present and granted, authoritative functions dormant", async () => {
    const gate = (await c.query("select * from app_write_gate where id = 1")).rows[0];
    expect(gate).toMatchObject({
      completion_writes_paused: false,
      legacy_writes_retired: false,
      authoritative_writes_active: false,
    });
    const stage = (await c.query("select stage from phase3_cutover_state")).rows[0].stage;
    expect(stage).toBe("prepared");
    const bridge = (
      await c.query(
        "select has_function_privilege('authenticated', 'fn_legacy_save_progress(uuid,text,uuid,integer,numeric,numeric,integer,text)', 'EXECUTE') as ok"
      )
    ).rows[0].ok;
    expect(bridge).toBe(true);
    const policies = (await c.query("select policyname from pg_policies where tablename = 'learning_sessions' order by 1")).rows.map(
      (r) => r.policyname
    );
    expect(policies).toEqual(expect.arrayContaining(["sessions_owner", "sessions_anon_insert"]));
  });
});
