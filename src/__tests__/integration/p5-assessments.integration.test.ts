/**
 * Learning Reports P5 — AI assessments on REAL PostgreSQL (044 + forward fix 045).
 *
 * 1. Upgrade from the actual P4 schema (001–043) with saved data: P4 notes,
 *    legacy ai_feedback copies and a legacy ai_assessment. Preflight → 044 →
 *    postflight, run as written. P4 payload hashes are unchanged (a P4-era
 *    retry is still `already_saved`).
 * 2. Generation rules: begin reuse / in_progress / busy (concurrent, lock wait
 *    observed), regeneration on a prompt/model change with unchanged data,
 *    outdated app, reverse finish order, tokens before/after acceptance and
 *    lease expiry, same vs conflicting payload, identity, abandon.
 * 3. Legacy race in BOTH genuinely concurrent lock orders; fallback after a
 *    failed first generation; the legacy mirror.
 * 4. Note kinds (minor / duplicate) and their honest coverage.
 * 5. Permissions, column privileges, RLS.
 *
 * Skipped unless LOCALDB_ADMIN_URL is set (see localdb/harness.ts).
 */
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import {
  HAS_LOCALDB,
  applyMigration,
  asRole,
  backendPid,
  createTestDb,
  createUser,
  errorOf,
  publishTranscript,
  rpcAs,
  runCutover,
  waitUntilBlocked,
  type PgClient,
  type TestDb,
} from "./localdb/harness";

const d = HAS_LOCALDB ? describe : describe.skip;
if (!HAS_LOCALDB) console.warn("[p5-assessments] skipped — LOCALDB_ADMIN_URL not set");

const SCRIPTS = path.resolve(__dirname, "../../../supabase/assessments_p5");
type Result = { fields?: Array<{ name: string }>; rows: Record<string, unknown>[] };
async function runScript(c: PgClient, file: string): Promise<Result[]> {
  const res = await c.query(fs.readFileSync(path.join(SCRIPTS, file), "utf8"));
  return (Array.isArray(res) ? res : [res]) as Result[];
}
const failedChecks = (results: Result[]) =>
  results.filter((r) => r.fields?.some((f) => f.name === "ok")).flatMap((r) => r.rows.filter((row) => row.ok !== true));

async function svc<T = Record<string, unknown>>(c: PgClient, sql: string, params: unknown[] = []): Promise<T> {
  return asRole(c, "service_role", null, async () => Object.values((await c.query(sql, params)).rows[0] ?? {})[0] as T);
}
const FP_A = "a".repeat(64);
const FP_B = "b".repeat(64);
const BEGIN = "select fn_assessment_begin($1, $2, $3, $4, $5)";
const FINISH = "select fn_assessment_finish($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)";
type Begin = { status: string; generation?: number; token?: string };
const begin = (c: PgClient, u: string, r: string, fp = FP_A, pv = 1, model = "m1") => svc<Begin>(c, BEGIN, [u, r, fp, pv, model]);
const payload = (overview = "Solid round.") => ({
  overview,
  strengths: [{ text: "Short sentences were right.", evidenceIds: ["S2"] }],
  priorities: [{ title: "Endings", explanation: "Plural -s dropped.", evidenceIds: ["S1"], practice: "Listen for final s." }],
  practicePlan: ["Replay sentence 1."],
  limitations: [],
});
const META = { generatedAt: "2026-10-05T00:00:00Z", evidence: { individual: 2, aggregateOnly: 0, total: 2 } };
function finish(c: PgClient, u: string, r: string, gen: number, token: string | null, opts: { fp?: string | null; pv?: number | null; model?: string | null; p?: unknown; meta?: unknown } = {}) {
  return svc<{ status: string }>(c, FINISH, [
    u,
    r,
    gen,
    token,
    opts.fp === undefined ? FP_A : opts.fp,
    opts.pv === undefined ? 1 : opts.pv,
    opts.model === undefined ? "m1" : opts.model,
    JSON.stringify(opts.p ?? payload()),
    JSON.stringify(opts.meta ?? META),
  ]);
}
const abandon = (c: PgClient, u: string, r: string, gen: number, token: string) =>
  svc<{ status: string }>(c, "select fn_assessment_abandon($1, $2, $3, $4, 'provider_failed')", [u, r, gen, token]);
const expireLatest = (c: PgClient, r: string) =>
  c.query("update assessment_generations set lease_expires_at = clock_timestamp() - interval '1 second' where round_id = $1 and state = 'started'", [r]);
const legacyPersist = (c: PgClient, u: string, r: string, verdict: string) =>
  svc<boolean>(c, "select fn_persist_session_assessment($1, $2, $3::jsonb)", [r, u, JSON.stringify({ verdict, strengths: [], weaknesses: [], recommendation: "" })]);
const columnOf = async (c: PgClient, r: string) => (await c.query("select ai_assessment from learning_sessions where id = $1", [r])).rows[0].ai_assessment;

async function makeRound(c: PgClient, user: string, video: string, texts: string[]) {
  const tr = await publishTranscript(c, video, texts);
  const round = (await rpcAs<{ roundId: string }>(c, user, "select fn_create_or_get_active_round($1, $2)", [video, tr])).roundId;
  const answer = async (seg: number, text: string, mode = "relaxed") =>
    (await rpcAs<{ attemptId: string }>(c, user, "select fn_record_dictation_attempt($1, $2, $3, $4, $5, $6, $7)", [round, video, seg, randomUUID(), text, mode, tr])).attemptId;
  return { tr, round, answer };
}

// ---------------------------------------------------------------------------
d("P5 upgrade 043 → 044 with saved P4 data (real PostgreSQL)", () => {
  let db: TestDb;
  let c: PgClient;
  let user = "";
  let round = "";
  let a0 = "";
  let op: { operationId: string; token: string } = { operationId: "", token: "" };
  const p4Items = () => [{ attemptId: a0, explanation: "P4-era note.", correctedText: "Alpha beta.", example: "Ex." }];

  beforeAll(async () => {
    db = await createTestDb("p5up", 43);
    c = await db.connect();
    user = await createUser(c);
    await runCutover(c, "activated");
    const r = await makeRound(c, user, "vidP5u", ["Alpha beta.", "Gamma delta."]);
    round = r.round;
    a0 = await r.answer(0, "alpha bet");
    const b = await svc<{ operationId: string; token: string }>(c, "select fn_explanations_begin($1, $2, $3::uuid[], 'batch', 'missing', 1, 'gemini-p4')", [user, round, [a0]]);
    op = { operationId: b.operationId, token: b.token };
    expect(await svc(c, "select fn_explanations_finish($1, $2, $3, $4, $5::jsonb)", [user, round, op.operationId, op.token, JSON.stringify(p4Items())])).toMatchObject({ status: "saved" });
    expect(await legacyPersist(c, user, round, "Legacy verdict")).toBe(true);
  }, 240_000);
  afterAll(async () => {
    await c?.end();
    await db?.drop();
  });

  it("preflight passes on the P4 state; 044 applies; postflight passes", async () => {
    expect(failedChecks(await runScript(c, "00_preflight.sql"))).toEqual([]);
    const before = (await c.query("select id, explanation, created_at from attempt_explanations order by id")).rows;
    await applyMigration(c, 44);
    expect((await c.query("select id, explanation, created_at from attempt_explanations order by id")).rows).toEqual(before);
    expect((await c.query("select distinct note_kind from attempt_explanations")).rows).toEqual([{ note_kind: "explanation" }]);
    expect(failedChecks(await runScript(c, "01_postflight.sql"))).toEqual([]);
    expect(failedChecks(await runScript(c, "00_preflight.sql")).length).toBeGreaterThan(0); // 044 now present
  });

  it("a P4-era retry still hashes identically (already_saved), and the legacy assessment stays as the fallback", async () => {
    expect(await svc(c, "select fn_explanations_finish($1, $2, $3, $4, $5::jsonb)", [user, round, op.operationId, op.token, JSON.stringify(p4Items())])).toMatchObject({
      status: "already_saved",
    });
    expect((await columnOf(c, round)).verdict).toBe("Legacy verdict");
    // No accepted new-format assessment yet: the legacy writer still works.
    expect(await legacyPersist(c, user, round, "Legacy verdict 2")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
d("P5 forward upgrade 044 → 045 with an already accepted assessment (real PostgreSQL)", () => {
  let db: TestDb;
  let c: PgClient;
  let user = "";
  let otherUser = "";
  let round = "";
  let token = "";
  const identities = [
    ["different fingerprint", { fp: FP_B }],
    ["different prompt version", { pv: 2 }],
    ["different model", { model: "m2" }],
    ["NULL fingerprint", { fp: null }],
    ["NULL prompt version", { pv: null }],
    ["NULL model", { model: null }],
  ] as const;

  // Whole stored rows, including hashes and timestamps, must remain identical.
  async function dataSnapshot() {
    const snapshot: Record<string, unknown> = {};
    for (const table of ["learning_sessions", "assessment_generations", "round_assessments", "attempt_logs", "attempt_explanations", "explanation_operations", "ai_feedback"]) {
      snapshot[table] = (await c.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text), '[]'::jsonb) as data from ${table} t`)).rows[0].data;
    }
    return snapshot;
  }
  async function permissionSnapshot() {
    return {
      tables: (await c.query("select oid, relowner, relacl, relrowsecurity, relforcerowsecurity from pg_class where relnamespace = 'public'::regnamespace order by oid")).rows,
      columns: (await c.query("select attrelid, attnum, attacl from pg_attribute where attrelid in (select oid from pg_class where relnamespace = 'public'::regnamespace) order by attrelid, attnum")).rows,
      functions: (await c.query("select oid, proowner, proacl, prosecdef, provolatile, proconfig from pg_proc where pronamespace = 'public'::regnamespace order by oid")).rows,
      policies: (await c.query("select * from pg_policies where schemaname = 'public' order by tablename, policyname")).rows,
    };
  }
  const expectBadIdentity = async (opts: Parameters<typeof finish>[5]) => {
    expect(await finish(c, user, round, 1, token, opts)).toEqual({ status: "invalid_identity" });
  };

  beforeAll(async () => {
    // Explicitly stop at the unchanged 044, not a fresh schema with 045 baked in.
    db = await createTestDb("p5fix", 44);
    c = await db.connect();
    user = await createUser(c);
    otherUser = await createUser(c);
    await runCutover(c, "activated");
    const r = await makeRound(c, user, "vidP5fix", ["Alpha beta."]);
    round = r.round;
    const attempt = await r.answer(0, "alpha bet");
    const op = await svc<{ operationId: string; token: string }>(c, "select fn_explanations_begin($1, $2, $3::uuid[], 'batch', 'missing', 1, 'm1')", [user, round, [attempt]]);
    expect(await svc(c, "select fn_explanations_finish($1, $2, $3, $4, $5::jsonb)", [user, round, op.operationId, op.token, JSON.stringify([{ attemptId: attempt, explanation: "Saved before 045." }])])).toMatchObject({ status: "saved" });
    token = (await begin(c, user, round)).token!;
    expect(await finish(c, user, round, 1, token)).toEqual({ status: "accepted", generation: 1 });
  }, 240_000);
  afterAll(async () => {
    await c?.end();
    await db?.drop();
  });

  it("the same identity regression fails under original 044; 045 fixes it without changing stored data, OIDs, grants or RLS", async () => {
    const beforeData = await dataSnapshot();
    const beforePermissions = await permissionSnapshot();
    for (const [label, opts] of identities) {
      // Run exactly the assertion used below: it MUST fail on original 044.
      await expect(expectBadIdentity(opts)).rejects.toThrow("invalid_identity");
      const old = await finish(c, user, round, 1, token, opts);
      expect(old).toEqual({ status: "already_accepted", generation: 1 });
      console.info(`[044 regression] ${label}: expected invalid_identity, received ${old.status}`);
    }
    expect(await dataSnapshot()).toEqual(beforeData);
    await applyMigration(c, 45);
    expect(await dataSnapshot()).toEqual(beforeData);
    expect(await permissionSnapshot()).toEqual(beforePermissions);
    for (const [, opts] of identities) await expectBadIdentity(opts);
    expect(await dataSnapshot()).toEqual(beforeData);
    expect(failedChecks(await runScript(c, "01_postflight.sql"))).toEqual([]);
    expect(failedChecks(await runScript(c, "02_identity_postflight.sql"))).toEqual([]);
  });

  it.each(identities)("accepted retry rejects %s before idempotency or payload conflict", async (_label, opts) => {
    const before = await dataSnapshot();
    await expectBadIdentity(opts);
    await expectBadIdentity({ ...opts, p: payload("Changed payload") });
    expect(await dataSnapshot()).toEqual(before);
  });

  it("ownership and token validation precede identity, payload validation and accepted retry", async () => {
    const before = await dataSnapshot();
    for (const badToken of [null, randomUUID()]) {
      expect(await finish(c, user, round, 1, badToken, { fp: null, pv: null, model: null, p: [] })).toEqual({ status: "invalid_token" });
      expect(await finish(c, otherUser, round, 1, badToken, { fp: null })).toEqual({ status: "not_found" });
    }
    expect(await finish(c, otherUser, round, 1, token)).toEqual({ status: "not_found" });
    expect(await finish(c, user, round, 999, token, { fp: null })).toEqual({ status: "not_found" });
    expect(await finish(c, user, round, 1, token, { p: [] })).toEqual({ status: "invalid_payload" });
    expect(await dataSnapshot()).toEqual(before);
  });

  it("identical retry and canonical-key retry succeed; changed payload or metadata conflicts without writes", async () => {
    const before = await dataSnapshot();
    expect(await finish(c, user, round, 1, token)).toEqual({ status: "already_accepted", generation: 1 });
    const reordered = Object.fromEntries(Object.entries(payload()).reverse());
    expect(await finish(c, user, round, 1, token, { p: reordered })).toEqual({ status: "already_accepted", generation: 1 });
    expect(await finish(c, user, round, 1, token, { p: payload("Conflicting") })).toEqual({ status: "conflict", generation: 1 });
    expect(await finish(c, user, round, 1, token, { meta: { ...META, generatedAt: "2026-10-05T01:00:00Z" } })).toEqual({ status: "conflict", generation: 1 });
    expect(await dataSnapshot()).toEqual(before);
  });

  it("historical accepted retries use their own identity after a newer generation starts AND is accepted; never replace the newer mirror", async () => {
    const newer = { fp: FP_B, pv: 2, model: "m2", p: payload("New authoritative result") };
    const g2 = await begin(c, user, round, newer.fp, newer.pv, newer.model);
    expect(g2).toMatchObject({ status: "started", generation: 2 });
    for (const phase of ["started", "accepted"]) {
      if (phase === "accepted") {
        expect(await finish(c, user, round, 2, g2.token!, newer)).toEqual({ status: "accepted", generation: 2 });
        expect((await columnOf(c, round)).verdict).toBe(newer.p.overview);
      }
      const before = await dataSnapshot();
      expect(await finish(c, user, round, 1, token)).toEqual({ status: "already_accepted", generation: 1 });
      expect(await finish(c, user, round, 1, token, { p: payload("Historical conflict") })).toEqual({ status: "conflict", generation: 1 });
      expect(await finish(c, user, round, 1, token, newer)).toEqual({ status: "invalid_identity" });
      for (const [, opts] of identities) await expectBadIdentity(opts);
      expect(await finish(c, user, round, 1, g2.token!, newer)).toEqual({ status: "invalid_token" });
      expect(await dataSnapshot()).toEqual(before);
    }
  });

  it("started and expired generations reject all mismatched/NULL identity fields; valid superseded results still write nothing", async () => {
    const { round: r } = await makeRound(c, user, "vidP5fix2", ["Alpha beta."]);
    const g1 = await begin(c, user, r);
    for (const expired of [false, true]) {
      if (expired) await expireLatest(c, r);
      const before = await dataSnapshot();
      for (const [, opts] of identities) {
        expect(await finish(c, user, r, 1, g1.token!, opts)).toEqual({ status: "invalid_identity" });
        expect(await finish(c, user, r, 1, randomUUID(), opts)).toEqual({ status: "invalid_token" });
      }
      expect(await dataSnapshot()).toEqual(before);
    }
    await begin(c, user, r, FP_B);
    const before = await dataSnapshot();
    expect(await finish(c, user, r, 1, g1.token!)).toEqual({ status: "superseded", latestGeneration: 2 });
    expect(await dataSnapshot()).toEqual(before);
  });

  it("authenticated retains only granted columns and owner rows; service_role reads both hashes but cannot write tables directly", async () => {
    const cols = "round_id, generation, fingerprint, prompt_version, model, state, lease_expires_at, created_at, finished_at";
    expect((await asRole(c, "authenticated", user, () => c.query(`select ${cols} from assessment_generations where round_id = $1`, [round]))).rowCount).toBe(2);
    expect((await asRole(c, "authenticated", otherUser, () => c.query(`select ${cols} from assessment_generations where round_id = $1`, [round]))).rows).toEqual([]);
    for (const col of ["token_hash", "payload_hash", "*"]) {
      expect((await errorOf(asRole(c, "authenticated", user, () => c.query(`select ${col} from assessment_generations`))))?.code).toBe("42501");
    }
    const hashes = (await asRole(c, "service_role", null, () => c.query("select token_hash, payload_hash from assessment_generations where round_id = $1", [round]))).rows;
    expect(hashes).toHaveLength(2);
    for (const row of hashes) {
      expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.payload_hash).toMatch(/^[0-9a-f]{64}$/);
    }
    for (const role of ["anon", "authenticated", "service_role"] as const) {
      expect((await errorOf(asRole(c, role, user, () => c.query("update assessment_generations set model = 'denied' where false"))))?.code).toBe("42501");
      if (role !== "service_role") {
        expect((await errorOf(asRole(c, role, user, () => c.query(FINISH, [user, round, 1, token, FP_A, 1, "m1", JSON.stringify(payload()), JSON.stringify(META)]))))?.code).toBe("42501");
      }
    }
    expect(failedChecks(await runScript(c, "01_postflight.sql"))).toEqual([]);
    expect(failedChecks(await runScript(c, "02_identity_postflight.sql"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
d("P5 assessment generations, legacy race, note kinds and permissions (real PostgreSQL)", () => {
  let db: TestDb;
  let c: PgClient;
  let userA = "";
  let userB = "";
  let video = 0;
  const freshRound = async (user: string) => {
    video++;
    return makeRound(c, user, `vidP5o${video}`, ["Alpha beta.", "Gamma delta.", "Epsilon zeta."]);
  };

  beforeAll(async () => {
    db = await createTestDb("p5ops");
    c = await db.connect();
    userA = await createUser(c);
    userB = await createUser(c);
    await runCutover(c, "activated");
  }, 240_000);
  afterAll(async () => {
    await c?.end();
    await db?.drop();
  });

  it("begin → finish accepts and mirrors; same data and version → reuse; a new prompt/model on unchanged data → a new generation", async () => {
    const { round } = await freshRound(userA);
    const g1 = await begin(c, userA, round);
    expect(g1).toMatchObject({ status: "started", generation: 1 });
    expect(await finish(c, userA, round, 1, g1.token!)).toEqual({ status: "accepted", generation: 1 });
    expect(await columnOf(c, round)).toEqual({
      verdict: "Solid round.",
      strengths: ["Short sentences were right."],
      weaknesses: ["Endings: Plural -s dropped."],
      recommendation: "Replay sentence 1.",
    });
    expect(await begin(c, userA, round)).toEqual({ status: "reuse", generation: 1 });
    // Corrected prompt (pv 2) or another model on the SAME data: not reused.
    const g2 = await begin(c, userA, round, FP_A, 2);
    expect(g2).toMatchObject({ status: "started", generation: 2 });
    await abandon(c, userA, round, 2, g2.token!);
    const g3 = await begin(c, userA, round, FP_A, 1, "m2");
    expect(g3).toMatchObject({ status: "started", generation: 3 });
    await abandon(c, userA, round, 3, g3.token!);
    // Different learning data with the same version: not reused either.
    expect(await begin(c, userA, round, FP_B)).toMatchObject({ status: "started", generation: 4 });
    // Starting never touched the accepted result or the mirror.
    expect((await c.query("select accepted_generation from round_assessments where round_id = $1", [round])).rows[0].accepted_generation).toBe(1);
    expect((await columnOf(c, round)).verdict).toBe("Solid round.");
  });

  it("an older app (lower prompt version) is refused before spending, after a newer version was accepted", async () => {
    const { round } = await freshRound(userA);
    const g = await begin(c, userA, round, FP_A, 2);
    expect(await finish(c, userA, round, g.generation!, g.token!, { pv: 2 })).toMatchObject({ status: "accepted" });
    expect(await begin(c, userA, round, FP_B, 1)).toMatchObject({ status: "outdated_app", acceptedPromptVersion: 2 });
  });

  it("tokens are checked always: wrong token before and after acceptance, after lease expiry; same payload → already_accepted; different → conflict", async () => {
    const { round } = await freshRound(userA);
    const g = await begin(c, userA, round);
    expect(await finish(c, userA, round, 1, randomUUID())).toEqual({ status: "invalid_token" });
    await expireLatest(c, round);
    expect(await finish(c, userA, round, 1, randomUUID())).toEqual({ status: "invalid_token" });
    // Expired lease, no newer generation, right token: still accepted (late completion).
    expect(await finish(c, userA, round, 1, g.token!)).toMatchObject({ status: "accepted" });
    expect(await finish(c, userA, round, 1, randomUUID())).toEqual({ status: "invalid_token" });
    // Same payload and meta (reordered keys) → no write.
    const reordered = { limitations: [], practicePlan: ["Replay sentence 1."], priorities: payload().priorities, strengths: payload().strengths, overview: "Solid round." };
    expect(await finish(c, userA, round, 1, g.token!, { p: reordered })).toMatchObject({ status: "already_accepted" });
    expect(await finish(c, userA, round, 1, g.token!, { p: payload("Another text.") })).toMatchObject({ status: "conflict" });
    expect((await c.query("select accepted_payload->>'overview' o from round_assessments where round_id = $1", [round])).rows[0].o).toBe("Solid round.");
    // Another user can't reach the generation.
    expect(await finish(c, userB, round, 1, g.token!)).toEqual({ status: "not_found" });
  });

  it("identity must match the generation; abandoned can't finish; invalid payloads are refused", async () => {
    const { round } = await freshRound(userA);
    const g = await begin(c, userA, round);
    expect(await finish(c, userA, round, 1, g.token!, { fp: FP_B })).toEqual({ status: "invalid_identity" });
    expect(await finish(c, userA, round, 1, g.token!, { model: "other" })).toEqual({ status: "invalid_identity" });
    expect(await finish(c, userA, round, 1, g.token!, { p: { overview: "  " } })).toEqual({ status: "invalid_payload" });
    expect(await finish(c, userA, round, 1, g.token!, { p: ["not", "an", "object"] })).toEqual({ status: "invalid_payload" });
    expect(await abandon(c, userA, round, 1, randomUUID())).toEqual({ status: "invalid_token" });
    expect(await abandon(c, userA, round, 1, g.token!)).toEqual({ status: "abandoned" });
    expect(await finish(c, userA, round, 1, g.token!)).toMatchObject({ status: "invalid_state" });
    expect((await c.query("select accepted_generation from round_assessments where round_id = $1", [round])).rows[0].accepted_generation).toBeNull();
  });

  it("reverse finish order: the newer generation wins; the older one is superseded and writes nothing", async () => {
    const { round } = await freshRound(userA);
    const g1 = await begin(c, userA, round);
    await expireLatest(c, round);
    const g2 = await begin(c, userA, round, FP_B);
    expect(g2).toMatchObject({ status: "started", generation: 2 });
    expect(await finish(c, userA, round, 2, g2.token!, { fp: FP_B, p: payload("Newer.") })).toMatchObject({ status: "accepted" });
    expect(await finish(c, userA, round, 1, g1.token!, { p: payload("Older, late.") })).toMatchObject({ status: "superseded" });
    expect((await c.query("select accepted_generation, accepted_payload->>'overview' o from round_assessments where round_id = $1", [round])).rows[0]).toEqual({
      accepted_generation: 2,
      o: "Newer.",
    });
    expect((await columnOf(c, round)).verdict).toBe("Newer.");
  });

  it("concurrent begins serialize on the round lock: identical → in_progress, different → busy", async () => {
    const { round } = await freshRound(userA);
    const first = await db.connect();
    const second = await db.connect();
    const observer = await db.connect();
    try {
      await first.query("begin");
      await first.query("set local role service_role");
      const started = (await first.query(BEGIN, [userA, round, FP_A, 1, "m1"])).rows[0].fn_assessment_begin;
      expect(started.status).toBe("started");
      const pid = await backendPid(second);
      const waiting = svc<Begin>(second, BEGIN, [userA, round, FP_A, 1, "m1"]);
      await waitUntilBlocked(observer, pid);
      await first.query("commit");
      expect(await waiting).toEqual({ status: "in_progress", generation: 1 });
      expect(await begin(c, userA, round, FP_B)).toEqual({ status: "busy" });
    } finally {
      await first.end();
      await second.end();
      await observer.end();
    }
  });

  it("legacy writer vs new finish, legacy holds the lock first: both serialize, the new assessment ends authoritative", async () => {
    const { round } = await freshRound(userA);
    const g = await begin(c, userA, round);
    const legacyConn = await db.connect();
    const newConn = await db.connect();
    const observer = await db.connect();
    try {
      await legacyConn.query("begin");
      await legacyConn.query("set local role service_role");
      const wrote = (await legacyConn.query("select fn_persist_session_assessment($1, $2, $3::jsonb) v", [round, userA, JSON.stringify({ verdict: "Old tab", strengths: [], weaknesses: [], recommendation: "" })])).rows[0].v;
      expect(wrote).toBe(true);
      const pid = await backendPid(newConn);
      const finishing = svc<{ status: string }>(newConn, FINISH, [userA, round, g.generation, g.token, FP_A, 1, "m1", JSON.stringify(payload("New B")), JSON.stringify(META)]);
      await waitUntilBlocked(observer, pid);
      await legacyConn.query("commit");
      expect(await finishing).toMatchObject({ status: "accepted" });
    } finally {
      await legacyConn.end();
      await newConn.end();
      await observer.end();
    }
    expect((await columnOf(c, round)).verdict).toBe("New B");
    expect(await legacyPersist(c, userA, round, "Old tab, again")).toBe(false);
    expect((await columnOf(c, round)).verdict).toBe("New B");
  });

  it("legacy writer vs new finish, new holds the lock first: the legacy write is refused", async () => {
    const { round } = await freshRound(userA);
    const g = await begin(c, userA, round);
    const newConn = await db.connect();
    const legacyConn = await db.connect();
    const observer = await db.connect();
    try {
      await newConn.query("begin");
      await newConn.query("set local role service_role");
      const r = (await newConn.query(FINISH, [userA, round, g.generation, g.token, FP_A, 1, "m1", JSON.stringify(payload("New B")), JSON.stringify(META)])).rows[0].fn_assessment_finish;
      expect(r.status).toBe("accepted");
      const pid = await backendPid(legacyConn);
      const legacy = svc<boolean>(legacyConn, "select fn_persist_session_assessment($1, $2, $3::jsonb)", [round, userA, JSON.stringify({ verdict: "Old tab", strengths: [], weaknesses: [], recommendation: "" })]);
      await waitUntilBlocked(observer, pid);
      await newConn.query("commit");
      expect(await legacy).toBe(false);
    } finally {
      await newConn.end();
      await legacyConn.end();
      await observer.end();
    }
    expect((await columnOf(c, round)).verdict).toBe("New B");
  });

  it("fallback: a started, abandoned or expired generation never hides or blocks the legacy assessment", async () => {
    const { round } = await freshRound(userA);
    expect(await legacyPersist(c, userA, round, "Legacy v1")).toBe(true);
    const g = await begin(c, userA, round);
    expect(await legacyPersist(c, userA, round, "Legacy v2 while generating")).toBe(true);
    await abandon(c, userA, round, g.generation!, g.token!);
    expect(await legacyPersist(c, userA, round, "Legacy v3 after failed generation")).toBe(true);
    const g2 = await begin(c, userA, round);
    await expireLatest(c, round);
    expect(g2.status).toBe("started");
    expect(await legacyPersist(c, userA, round, "Legacy v4 after expiry")).toBe(true);
    const row = (await c.query("select accepted_generation, latest_started_generation from round_assessments where round_id = $1", [round])).rows[0];
    expect(row).toEqual({ accepted_generation: null, latest_started_generation: 2 });
    expect((await columnOf(c, round)).verdict).toBe("Legacy v4 after expiry");
  });

  it("note kinds: minor and duplicate are stored honestly; a duplicate must point at an explanation in the same payload", async () => {
    const { round, answer } = await freshRound(userA);
    const x = await answer(0, "alpha bet");
    const y = await answer(1, "gamma delt");
    const z = await answer(2, "epsilon zet");
    const b = await svc<{ status: string; operationId: string; token: string }>(c, "select fn_explanations_begin($1, $2, $3::uuid[], 'batch', 'missing', 2, 'm1')", [userA, round, [x, y, z]]);
    const fin = (items: unknown) => svc<{ status: string; reason?: string }>(c, "select fn_explanations_finish($1, $2, $3, $4, $5::jsonb)", [userA, round, b.operationId, b.token, JSON.stringify(items)]);
    const expl = { attemptId: x, explanation: "Beta, not bet.", correctedText: "Alpha beta.", example: null, tip: null };
    expect(await fin([expl, { attemptId: y, explanation: "Same issue.", kind: "duplicate", refAttemptId: z }])).toEqual({ status: "invalid_payload", reason: "bad_duplicate_ref" });
    expect(await fin([expl, { attemptId: y, explanation: "Same issue.", kind: "duplicate", refAttemptId: y }])).toEqual({ status: "invalid_payload", reason: "bad_duplicate_ref" });
    expect(await fin([expl, { attemptId: y, explanation: "  ", kind: "minor" }])).toEqual({ status: "invalid_payload", reason: "malformed_item" });
    expect(await fin([expl, { attemptId: y, explanation: "Ok", kind: "weird" }])).toEqual({ status: "invalid_payload", reason: "malformed_item" });
    expect(
      await fin([
        expl,
        { attemptId: y, explanation: "Same ending issue as sentence 1.", kind: "duplicate", refAttemptId: x },
        { attemptId: z, explanation: "A small slip, not a language issue.", kind: "minor" },
      ])
    ).toMatchObject({ status: "saved", count: 3 });
    const rows = (await c.query("select attempt_id, note_kind, ref_attempt_id from attempt_explanations where operation_id = $1 order by note_kind", [b.operationId])).rows;
    expect(rows).toEqual([
      { attempt_id: y, note_kind: "duplicate", ref_attempt_id: x },
      { attempt_id: x, note_kind: "explanation", ref_attempt_id: null },
      { attempt_id: z, note_kind: "minor", ref_attempt_id: null },
    ]);
    // All three count as covered: a later "missing" request has nothing to pay for.
    expect(await svc(c, "select fn_explanations_begin($1, $2, $3::uuid[], 'batch', 'missing', 2, 'm1')", [userA, round, [x, y, z]])).toMatchObject({ status: "reuse" });
    expect(failedChecks(await runScript(c, "01_postflight.sql"))).toEqual([]);
  });

  it("permissions: owners read state but never tokens; app roles can't write or call the writers; postflight passes", async () => {
    const { round } = await freshRound(userA);
    const g = await begin(c, userA, round);
    await finish(c, userA, round, g.generation!, g.token!);
    const own = await asRole(c, "authenticated", userA, async () =>
      (await c.query("select generation, state from assessment_generations where round_id = $1", [round])).rows
    );
    expect(own).toEqual([{ generation: 1, state: "accepted" }]);
    expect((await errorOf(asRole(c, "authenticated", userA, () => c.query("select token_hash from assessment_generations")))) ?.code).toBe("42501");
    expect((await errorOf(asRole(c, "authenticated", userA, () => c.query("select * from assessment_generations")))) ?.code).toBe("42501");
    const others = await asRole(c, "authenticated", userB, async () => (await c.query("select count(*) n from round_assessments where round_id = $1", [round])).rows[0].n);
    expect(Number(others)).toBe(0);
    for (const role of ["authenticated", "anon"] as const) {
      const who = role === "authenticated" ? userA : null;
      expect((await errorOf(asRole(c, role, who, () => c.query(BEGIN, [userA, round, FP_A, 1, "m1"]))))?.code).toBe("42501");
      expect((await errorOf(asRole(c, role, who, () => c.query("update round_assessments set accepted_payload = '{}'"))))?.code).toBe("42501");
      expect((await errorOf(asRole(c, role, who, () => c.query("select fn_assessment_legacy_mirror('{}'::jsonb)"))))?.code).toBe("42501");
    }
    expect((await errorOf(asRole(c, "service_role", null, () => c.query("delete from round_assessments"))))?.code).toBe("42501");
    expect((await errorOf(asRole(c, "service_role", null, () => c.query("select fn_assessment_legacy_mirror('{}'::jsonb)"))))?.code).toBe("42501");
    expect(failedChecks(await runScript(c, "01_postflight.sql"))).toEqual([]);
  });
});
