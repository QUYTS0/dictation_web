/**
 * Learning Reports P4 — saved explanations on REAL PostgreSQL (migration 043).
 *
 * 1. Upgrade rehearsal from the 042 production state with legacy ai_feedback
 *    data: preflight → 043 applied WHILE a legacy INSERT runs on a second
 *    connection → postflight, with the operator scripts executed as written.
 *    Then the literal pre-P4 writer statements (DELETE → failing INSERT),
 *    mixed-version / rollback inserts, idempotent catch-up and its limit.
 * 2. Operations: begin/finish/abandon token and idempotency rules, lease
 *    expiry, validation, seq ordering, genuinely concurrent begins (lock wait
 *    observed in pg_stat_activity), the missing-only re-check (no paying twice)
 *    and explicit re-explain.
 * 3. Reuse identity: TS ⇔ SQL key parity, exact/relaxed/learning/unknown
 *    modes, same-round restore after reload, no cross-round/cross-user reuse,
 *    owner-only RLS and role permissions.
 *
 * Skipped unless LOCALDB_ADMIN_URL is set (see localdb/harness.ts).
 */
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import {
  HAS_LOCALDB,
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
import {
  explanationPatternKey,
  resolveExplanations,
  type ExplanationAttempt,
  type StoredExplanation,
} from "@/lib/practice/explanationIdentity";

const d = HAS_LOCALDB ? describe : describe.skip;
if (!HAS_LOCALDB) console.warn("[p4-saved-explanations] skipped — LOCALDB_ADMIN_URL not set");

const ROOT = path.resolve(__dirname, "../../..");
const MIGRATION = path.join(ROOT, "supabase", "migrations", "043_saved_explanations.sql");
const SCRIPTS = path.join(ROOT, "supabase", "explanations_p4");

type Result = { fields?: Array<{ name: string }>; rows: Record<string, unknown>[] };
async function runScript(c: PgClient, file: string): Promise<Result[]> {
  const res = await c.query(fs.readFileSync(path.join(SCRIPTS, file), "utf8"));
  return (Array.isArray(res) ? res : [res]) as Result[];
}
const byField = (results: Result[], name: string) => results.find((r) => r.fields?.some((f) => f.name === name));
/** Every result set that has an `ok` column has only ok=true rows. */
function failedChecks(results: Result[]): Record<string, unknown>[] {
  return results
    .filter((r) => r.fields?.some((f) => f.name === "ok"))
    .flatMap((r) => r.rows.filter((row) => row.ok !== true));
}

/** One statement as service_role (how the app's server routes call RPCs). */
async function svc<T = Record<string, unknown>>(c: PgClient, sql: string, params: unknown[] = []): Promise<T> {
  return asRole(c, "service_role", null, async () => {
    const r = await c.query(sql, params);
    return Object.values(r.rows[0] ?? {})[0] as T;
  });
}

type Begin = { status: string; operationId?: string; token?: string; seq?: number; targets?: string[]; covered?: string[] };
const BEGIN_SQL = "select fn_explanations_begin($1, $2, $3::uuid[], $4, $5, $6, $7)";
function begin(
  c: PgClient,
  user: string,
  round: string,
  targets: string[],
  opts: { kind?: string; intent?: string; promptVersion?: number; model?: string } = {}
) {
  return svc<Begin>(c, BEGIN_SQL, [
    user,
    round,
    targets,
    opts.kind ?? "batch",
    opts.intent ?? "missing",
    opts.promptVersion ?? 1,
    opts.model ?? "gemini-test",
  ]);
}
function finish(c: PgClient, user: string, round: string, op: string, token: string, items: unknown) {
  return svc<{ status: string; reason?: string; count?: number; seq?: number }>(
    c,
    "select fn_explanations_finish($1, $2, $3, $4, $5::jsonb)",
    [user, round, op, token, JSON.stringify(items)]
  );
}
function abandon(c: PgClient, user: string, round: string, op: string, token: string, reason = "provider_failed") {
  return svc<{ status: string }>(c, "select fn_explanations_abandon($1, $2, $3, $4, $5)", [user, round, op, token, reason]);
}
const note = (attemptId: string, explanation = `Note for ${attemptId.slice(0, 4)}`) => ({
  attemptId,
  explanation,
  correctedText: "Fixed.",
  example: "Example.",
});

async function answer(c: PgClient, user: string, round: string, video: string, seg: number, text: string, mode: string, tr: string) {
  const r = await rpcAs<{ attemptId: string; isCorrect: boolean }>(
    c,
    user,
    "select fn_record_dictation_attempt($1, $2, $3, $4, $5, $6, $7)",
    [round, video, seg, randomUUID(), text, mode, tr]
  );
  expect(r.isCorrect).toBe(false);
  return r.attemptId;
}
const count = async (c: PgClient, sql: string, params: unknown[] = []) => Number((await c.query(sql, params)).rows[0].n);

/** Notes of a round as the OWNER reads them (RLS), then resolved like the report route. */
async function reportView(c: PgClient, user: string, round: string) {
  return asRole(c, "authenticated", user, async () => {
    const notes = (await c.query(
      "select id, attempt_id, source, seq, explanation, corrected_text, example_text, tip, prompt_version, model, created_at from attempt_explanations where round_id = $1",
      [round]
    )).rows.map((r) => ({ ...r, created_at: new Date(r.created_at).toISOString() })) as StoredExplanation[];
    const attempts = (await c.query(
      "select id, segment_index, expected_text, user_text, match_mode, is_correct, created_at from attempt_logs where session_id = $1 order by segment_index, created_at",
      [round]
    )).rows.map((r) => ({ ...r, created_at: new Date(r.created_at).toISOString() })) as ExplanationAttempt[];
    return { notes, attempts, resolve: (ids: string[]) => resolveExplanations(attempts.filter((a) => ids.includes(a.id)), attempts, notes) };
  });
}

// ---------------------------------------------------------------------------
d("P4 upgrade 042 → 043 with legacy explanations (real PostgreSQL)", () => {
  let db: TestDb;
  let c: PgClient;
  let user = "";
  let round = "";
  let u0 = "";
  let u1 = "";
  let u2 = "";
  let w0 = "";
  const F = { f1: randomUUID(), f2: randomUUID(), f3: randomUUID(), f4: randomUUID(), f5: randomUUID(), f6: randomUUID() };

  beforeAll(async () => {
    db = await createTestDb("p4up", 42);
    c = await db.connect();
    user = await createUser(c);
    const other = await createUser(c);
    await runCutover(c, "activated");
    const tr = await publishTranscript(c, "vidP4u", ["Alpha beta.", "Gamma delta.", "Epsilon zeta."]);
    round = (await rpcAs<{ roundId: string }>(c, user, "select fn_create_or_get_active_round($1, $2)", ["vidP4u", tr])).roundId;
    u0 = await answer(c, user, round, "vidP4u", 0, "alpha bet", "relaxed", tr);
    u1 = await answer(c, user, round, "vidP4u", 1, "gamma delt", "relaxed", tr);
    u2 = await answer(c, user, round, "vidP4u", 2, "epsilon zet", "relaxed", tr);
    const otherRound = (await rpcAs<{ roundId: string }>(c, other, "select fn_create_or_get_active_round($1, $2)", ["vidP4u", tr])).roundId;
    w0 = await answer(c, other, otherRound, "vidP4u", 0, "alpa", "relaxed", tr);
    // A round whose owner is gone (users → learning_sessions is ON DELETE SET NULL).
    await c.query("update learning_sessions set user_id = null where id = $1", [otherRound]);

    // Legacy rows exactly as the old writers left them (service role).
    await asRole(c, "service_role", null, async () => {
      const ins = "insert into ai_feedback (id, attempt_id, explanation, corrected_text, example_text, created_at) values ($1, $2, $3, $4, $5, $6)";
      await c.query(ins, [F.f1, u0, "Older note for alpha.", "Alpha beta.", "Ex 1", "2026-09-01T10:00:00Z"]);
      await c.query(ins, [F.f2, u0, "Newer note for alpha.", "Alpha beta.", "Ex 2", "2026-09-02T10:00:00Z"]); // duplicate per attempt
      await c.query(ins, [F.f3, u1, "", "Gamma delta.", "", "2026-09-03T10:00:00Z"]); // blank (old route stored "" on a missing item)
      await c.query(ins, [F.f4, null, "Orphan note.", null, null, "2026-09-03T11:00:00Z"]); // no attempt
      await c.query(ins, [F.f5, w0, "Note in an ownerless round.", null, null, "2026-09-03T12:00:00Z"]);
    });
  }, 240_000);
  afterAll(async () => {
    await c?.end();
    await db?.drop();
  });

  it("preflight (read-only) sees 043 absent and inventories copyable / not-copyable legacy rows", async () => {
    const pre = await runScript(c, "00_preflight.sql");
    expect(failedChecks(pre)).toEqual([]);
    expect(byField(pre, "legacy_rows")?.rows[0]).toMatchObject({
      legacy_rows: "5",
      copyable: "2",
      not_copyable_no_attempt: "1",
      not_copyable_blank_explanation: "1",
      not_copyable_round_without_owner: "1",
    });
    expect(byField(pre, "attempts_with_duplicates")?.rows[0]).toMatchObject({ attempts_with_duplicates: "1", max_rows_per_attempt: "2" });
  });

  it("043 applies while a legacy INSERT runs concurrently: the INSERT waits, then is captured exactly once", async () => {
    const sql = fs.readFileSync(MIGRATION, "utf8");
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    const withoutCommit = sql.trimEnd().slice(0, -"commit;".length);

    const writer = await db.connect();
    const observer = await db.connect();
    try {
      await c.query(withoutCommit); // migration transaction left OPEN (lock held, trigger + backfill done)
      const pid = await backendPid(writer);
      const legacyInsert = asRole(writer, "service_role", null, () =>
        writer.query("insert into ai_feedback (id, attempt_id, explanation, corrected_text, example_text) values ($1, $2, 'Written during the migration.', null, null)", [F.f6, u2])
      );
      await waitUntilBlocked(observer, pid);
      await c.query("commit");
      await legacyInsert;
    } finally {
      await writer.end();
      await observer.end();
    }

    for (const id of [F.f1, F.f2, F.f6]) {
      expect(await count(c, "select count(*) n from attempt_explanations where legacy_feedback_id = $1", [id])).toBe(1);
    }
    for (const id of [F.f3, F.f4, F.f5]) {
      expect(await count(c, "select count(*) n from attempt_explanations where legacy_feedback_id = $1", [id])).toBe(0);
    }
    // Original legacy timestamp and the authoritative owner chain are kept.
    const f1 = (await c.query("select * from attempt_explanations where legacy_feedback_id = $1", [F.f1])).rows[0];
    expect(new Date(f1.created_at).toISOString()).toBe("2026-09-01T10:00:00.000Z");
    expect(f1).toMatchObject({ user_id: user, round_id: round, attempt_id: u0, source: "legacy_ai_feedback", seq: null, operation_id: null });
  });

  it("postflight passes and lists the rows that cannot be copied (kept, never given an invented owner)", async () => {
    const post = await runScript(c, "01_postflight.sql");
    expect(failedChecks(post)).toEqual([]);
    const sets = post.filter((r) => r.fields?.some((f) => f.name === "ok"));
    expect(sets.map((r) => r.rows.length).slice(0, 4)).toEqual([2, 6, 7, 1]);
    const uncopyable = byField(post, "reason")!.rows.map((r) => [r.ai_feedback_id, r.reason]);
    expect(uncopyable).toEqual(
      expect.arrayContaining([
        [F.f3, "blank_explanation"],
        [F.f4, "no_attempt"],
        [F.f5, "round_without_owner"],
      ])
    );
    expect(uncopyable).toHaveLength(3);
    expect(await count(c, "select count(*) n from ai_feedback where id in ($1, $2, $3)", [F.f3, F.f4, F.f5])).toBe(3);
  });

  it("the literal old writer (DELETE succeeds, INSERT fails) cannot remove a captured explanation", async () => {
    await asRole(c, "service_role", null, async () => {
      await c.query("delete from ai_feedback where attempt_id in ($1)", [u0]);
    });
    const insertError = await errorOf(
      asRole(c, "service_role", null, () =>
        c.query("insert into ai_feedback (attempt_id, explanation, corrected_text, example_text) values ($1, 'x', 'x', 'x')", [randomUUID()])
      )
    );
    expect(insertError?.code).toBe("23503"); // the replacing INSERT failed
    expect(await count(c, "select count(*) n from ai_feedback where attempt_id = $1", [u0])).toBe(0);

    // The owner's report still shows the newest legacy note for that answer.
    const view = await reportView(c, user, round);
    const shown = view.resolve([u0]).get(u0);
    expect(shown).toMatchObject({ explanation: "Newer note for alpha.", via: "attempt", legacy: true });

    // Source rows decreased; the per-row postflight still passes (no total-count comparison).
    const post = await runScript(c, "01_postflight.sql");
    expect(failedChecks(post)).toEqual([]);
    expect(Number(byField(post, "preserved_after_legacy_delete")!.rows[0].preserved_after_legacy_delete)).toBe(2);
  });

  it("old-writer inserts during a mixed deployment or after an app rollback are captured; catch-up reruns add nothing", async () => {
    const fNew = randomUUID();
    await asRole(c, "service_role", null, () =>
      c.query("insert into ai_feedback (id, attempt_id, explanation) values ($1, $2, 'Old app, mixed window.')", [fNew, u1])
    );
    expect(await count(c, "select count(*) n from attempt_explanations where legacy_feedback_id = $1", [fNew])).toBe(1);

    const before = await count(c, "select count(*) n from attempt_explanations");
    const r1 = (await c.query("select fn_copy_legacy_ai_feedback() v")).rows[0].v;
    const r2 = (await c.query("select fn_copy_legacy_ai_feedback() v")).rows[0].v;
    expect(r1.copiedNow).toBe(0);
    expect(r2.copiedNow).toBe(0);
    expect(await count(c, "select count(*) n from attempt_explanations")).toBe(before);
    expect(await count(c, "select count(*) - count(distinct legacy_feedback_id) n from attempt_explanations where legacy_feedback_id is not null")).toBe(0);

    for (const role of ["service_role", "authenticated", "anon"] as const) {
      const err = await errorOf(asRole(c, role, role === "authenticated" ? user : null, () => c.query("select fn_copy_legacy_ai_feedback()")));
      expect(err?.code).toBe("42501");
    }
  });

  it("new-mechanism notes survive an app rollback: old statements can't touch them (the old app just can't display them)", async () => {
    // u2 already has a legacy copy, so a new note needs the explicit intent.
    expect((await begin(c, user, round, [u2])).status).toBe("reuse");
    const b = await begin(c, user, round, [u2], { intent: "reexplain" });
    expect(b.status).toBe("started");
    expect(await finish(c, user, round, b.operationId!, b.token!, [note(u2, "New P4 note.")])).toMatchObject({ status: "saved" });

    // The old app's reader and writer only know ai_feedback.
    await asRole(c, "service_role", null, async () => {
      const oldRead = await c.query("select explanation from ai_feedback where attempt_id = $1", [u2]);
      expect(oldRead.rows.map((r) => r.explanation)).toEqual(["Written during the migration."]);
      await c.query("delete from ai_feedback where attempt_id in ($1)", [u2]);
    });
    const view = await reportView(c, user, round);
    expect(view.resolve([u2]).get(u2)).toMatchObject({ explanation: "New P4 note.", legacy: false, via: "attempt" });
    expect(view.notes.filter((n) => n.attempt_id === u2)).toHaveLength(2); // new note + preserved legacy copy
  });

  it("catch-up after capture was disabled copies only rows that still exist (documented limit)", async () => {
    await c.query("alter table ai_feedback disable trigger ai_feedback_capture");
    const gone = randomUUID();
    const kept = randomUUID();
    await asRole(c, "service_role", null, async () => {
      await c.query("insert into ai_feedback (id, attempt_id, explanation) values ($1, $2, 'Inserted and deleted while disabled.')", [gone, u1]);
      await c.query("delete from ai_feedback where id = $1", [gone]);
      await c.query("insert into ai_feedback (id, attempt_id, explanation) values ($1, $2, 'Inserted while disabled.')", [kept, u1]);
    });
    const disabled = await runScript(c, "01_postflight.sql");
    expect(failedChecks(disabled).length).toBeGreaterThan(0); // trigger check and the uncopied row are flagged

    await c.query("alter table ai_feedback enable trigger ai_feedback_capture");
    const r = (await c.query("select fn_copy_legacy_ai_feedback() v")).rows[0].v;
    expect(r.copiedNow).toBe(1);
    expect(await count(c, "select count(*) n from attempt_explanations where legacy_feedback_id = $1", [kept])).toBe(1);
    expect(await count(c, "select count(*) n from attempt_explanations where legacy_feedback_id = $1", [gone])).toBe(0);
    expect(failedChecks(await runScript(c, "01_postflight.sql"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
d("P4 explanation operations, reuse identity and permissions (real PostgreSQL)", () => {
  let db: TestDb;
  let c: PgClient;
  let userA = "";
  let userB = "";
  let tr = "";
  let round = "";
  // Round A attempts (transcript repeats sentence 0 at index 2).
  let a0 = "", a1 = "", a2 = "", a3 = "", a4 = "", a5 = "", a6 = "", a7 = "", a8 = "";
  const video = "vidP4ops";

  beforeAll(async () => {
    db = await createTestDb("p4ops");
    c = await db.connect();
    userA = await createUser(c);
    userB = await createUser(c);
    await runCutover(c, "activated");
    tr = await publishTranscript(c, video, ["Alpha beta.", "Gamma delta.", "Alpha beta.", "Epsilon zeta.", "Eta theta.", "Iota kappa."]);
    round = (await rpcAs<{ roundId: string }>(c, userA, "select fn_create_or_get_active_round($1, $2)", [video, tr])).roundId;
    a0 = await answer(c, userA, round, video, 0, "alpha bet", "relaxed", tr);
    a2 = await answer(c, userA, round, video, 2, "Alpha bet!", "relaxed", tr); // same relaxed mistake, other sentence
    a1 = await answer(c, userA, round, video, 1, "gamma delt", "relaxed", tr);
    a3 = await answer(c, userA, round, video, 1, "gamma delt", "learning", tr); // same texts, other rule
    a4 = await answer(c, userA, round, video, 3, "epsilon zeta.", "exact", tr); // case only
    a5 = await answer(c, userA, round, video, 3, "Epsilon zeta", "exact", tr); // punctuation only
    a6 = await answer(c, userA, round, video, 4, "eta thet", "relaxed", tr);
    a7 = await answer(c, userA, round, video, 4, "eta thet", "relaxed", tr); // will become legacy (unknown mode)
    a8 = await answer(c, userA, round, video, 5, "iota kap", "relaxed", tr);
    await c.query("update attempt_logs set match_mode = null where id = $1", [a7]);
  }, 240_000);
  afterAll(async () => {
    await c?.end();
    await db?.drop();
  });

  it("the TS key mirrors fn_explanation_pattern_key exactly (incl. unicode), and an unknown mode has no key", async () => {
    const cases: Array<[string, string, string | null]> = [
      ["Hello, World!", "hello world", "exact"],
      ["Hello, World!", "hello world", "relaxed"],
      ["Hello, World!", "hello world", "learning"],
      ["Café — déjà vu", "cafe deja vu", "relaxed"],
      ["It’s fine.", "it's fine", "exact"],
      ["I ❤️ NY 𝟘", "i love ny", "relaxed"],
      ["  spaced   out ", "spaced out", "exact"],
      ["Same", "Same", null],
    ];
    for (const [e, u, m] of cases) {
      const sqlKey = (await c.query("select fn_explanation_pattern_key($1, $2, $3) k", [e, u, m])).rows[0].k;
      expect(explanationPatternKey(e, u, m)).toBe(sqlKey);
    }
    expect(explanationPatternKey("Same", "Same", null)).toBeNull();
  });

  it("begin → finish saves; the same operation, token and payload is idempotent (no new rows), even reordered", async () => {
    const b = await begin(c, userA, round, [a0]);
    expect(b).toMatchObject({ status: "started", seq: 1, targets: [a0], covered: [] });
    const items = [note(a0, "Alpha explanation.")];
    expect(await finish(c, userA, round, b.operationId!, b.token!, items)).toMatchObject({ status: "saved", count: 1, seq: 1 });
    const rows = await count(c, "select count(*) n from attempt_explanations where operation_id = $1", [b.operationId]);
    expect(rows).toBe(1);
    // Same canonical payload with keys in another order and explicit nulls omitted → already_saved.
    const reordered = [{ example: "Example.", correctedText: "Fixed.", explanation: "Alpha explanation.", attemptId: a0.toUpperCase() }];
    expect(await finish(c, userA, round, b.operationId!, b.token!, reordered)).toMatchObject({ status: "already_saved", count: 1 });
    expect(await finish(c, userA, round, b.operationId!, b.token!, items)).toMatchObject({ status: "already_saved" });
    expect(await count(c, "select count(*) n from attempt_explanations where operation_id = $1", [b.operationId])).toBe(1);
    // The accepted operation keeps a verifiable token hash after its lease was cleared.
    const op = (await c.query("select status, lease_expires_at, token_hash from explanation_operations where id = $1", [b.operationId])).rows[0];
    expect(op).toMatchObject({ status: "accepted", lease_expires_at: null });
    expect(op.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a wrong token is rejected before and after acceptance; a different payload is a conflict and changes nothing", async () => {
    const b = await begin(c, userA, round, [a6]);
    expect(b.status).toBe("started");
    expect(await finish(c, userA, round, b.operationId!, randomUUID(), [note(a6)])).toEqual({ status: "invalid_token" });
    expect(await count(c, "select count(*) n from attempt_explanations where operation_id = $1", [b.operationId])).toBe(0);
    expect(await finish(c, userA, round, b.operationId!, b.token!, [note(a6, "Eta explanation.")])).toMatchObject({ status: "saved" });
    // After acceptance: wrong token still rejected — even with the identical payload.
    expect(await finish(c, userA, round, b.operationId!, randomUUID(), [note(a6, "Eta explanation.")])).toEqual({ status: "invalid_token" });
    expect(await finish(c, userA, round, b.operationId!, b.token!, [note(a6, "A different text.")])).toMatchObject({ status: "conflict" });
    const saved = await c.query("select explanation from attempt_explanations where operation_id = $1", [b.operationId]);
    expect(saved.rows.map((r) => r.explanation)).toEqual(["Eta explanation."]);
    // Another user's id, or another round, never reaches the operation.
    expect(await finish(c, userB, round, b.operationId!, b.token!, [note(a6, "Eta explanation.")])).toEqual({ status: "not_found" });
  });

  it("an expired lease keeps token validation: the right token still saves, a wrong one doesn't; abandoned can't finish", async () => {
    const b = await begin(c, userA, round, [a8]);
    expect(b.status).toBe("started");
    await c.query("update explanation_operations set lease_expires_at = clock_timestamp() - interval '1 minute' where id = $1", [b.operationId]);
    expect(await finish(c, userA, round, b.operationId!, randomUUID(), [note(a8)])).toEqual({ status: "invalid_token" });
    expect(await finish(c, userA, round, b.operationId!, b.token!, [note(a8, "Iota explanation.")])).toMatchObject({ status: "saved" });

    const b2 = await begin(c, userA, round, [a8], { intent: "reexplain" });
    expect(b2.status).toBe("started");
    expect(await abandon(c, userA, round, b2.operationId!, randomUUID())).toEqual({ status: "invalid_token" });
    expect(await abandon(c, userA, round, b2.operationId!, b2.token!)).toEqual({ status: "abandoned" });
    expect(await finish(c, userA, round, b2.operationId!, b2.token!, [note(a8, "Too late.")])).toMatchObject({ status: "invalid_state" });
    expect(await count(c, "select count(*) n from attempt_explanations where attempt_id = $1", [a8])).toBe(1); // abandon removed nothing
  });

  it("invalid, foreign, duplicate or too many targets and malformed items are refused with nothing written", async () => {
    const otherRound = (await rpcAs<{ roundId: string }>(c, userB, "select fn_create_or_get_active_round($1, $2)", [video, tr])).roundId;
    const foreign = await answer(c, userB, otherRound, video, 0, "alpa", "relaxed", tr);
    const opsBefore = await count(c, "select count(*) n from explanation_operations");
    expect(await begin(c, userA, round, [foreign])).toEqual({ status: "invalid_targets" });
    expect(await begin(c, userA, round, [a1, a1])).toEqual({ status: "invalid_targets" });
    expect(await begin(c, userA, round, [])).toEqual({ status: "invalid_targets" });
    expect(await begin(c, userA, round, Array.from({ length: 36 }, () => randomUUID()))).toEqual({ status: "invalid_targets" });
    expect(await begin(c, userA, round, [a1, a3], { kind: "single" })).toEqual({ status: "invalid_targets" });
    expect(await begin(c, userA, round, [a1], { intent: "everything" })).toEqual({ status: "invalid_request" });
    expect(await begin(c, userB, round, [a1])).toEqual({ status: "not_found" }); // not the owner
    expect(await count(c, "select count(*) n from explanation_operations")).toBe(opsBefore);

    const b = await begin(c, userA, round, [a1, a3]);
    expect(b.status).toBe("started");
    const bad: Array<[unknown, string]> = [
      [{ not: "an array" }, "not_an_array"],
      [[], "empty"],
      [[note(a1), note(a1)], "duplicate_attempt"],
      [[note(a4)], "not_a_target"],
      [[{ ...note(a1), explanation: "   " }], "malformed_item"],
      [[{ ...note(a1), extra: 1 }], "malformed_item"],
      [[{ ...note(a1), attemptId: "not-a-uuid" }], "malformed_item"],
      [[{ ...note(a1), example: 5 }], "malformed_item"],
    ];
    for (const [items, reason] of bad) {
      expect(await finish(c, userA, round, b.operationId!, b.token!, items)).toEqual({ status: "invalid_payload", reason });
    }
    expect(await count(c, "select count(*) n from attempt_explanations where operation_id = $1", [b.operationId])).toBe(0);
    await abandon(c, userA, round, b.operationId!, b.token!);
  });

  it("an older operation that finishes after a newer one stays historical (seq is allocated at begin)", async () => {
    const older = await begin(c, userA, round, [a5], { intent: "reexplain" });
    await c.query("update explanation_operations set lease_expires_at = clock_timestamp() - interval '1 second' where id = $1", [older.operationId]);
    const newer = await begin(c, userA, round, [a5], { intent: "reexplain" });
    expect(newer.seq!).toBeGreaterThan(older.seq!);
    expect(await finish(c, userA, round, newer.operationId!, newer.token!, [note(a5, "Newer note.")])).toMatchObject({ status: "saved" });
    expect(await finish(c, userA, round, older.operationId!, older.token!, [note(a5, "Older, finished late.")])).toMatchObject({ status: "saved" });

    const sqlEffective = (await c.query(
      "select explanation from attempt_explanations where attempt_id = $1 order by seq desc nulls last, created_at desc, id desc limit 1",
      [a5]
    )).rows[0].explanation;
    expect(sqlEffective).toBe("Newer note.");
    const view = await reportView(c, userA, round);
    expect(view.resolve([a5]).get(a5)?.explanation).toBe("Newer note.");
    expect(view.notes.filter((n) => n.attempt_id === a5).map((n) => n.explanation).sort()).toEqual(["Newer note.", "Older, finished late."]);
  });

  it("concurrent begins serialize on the per-round lock: one starts, the identical one is in_progress, another is busy; seqs are unique", async () => {
    const r2 = (await rpcAs<{ roundId: string }>(c, userA, "select fn_restart_round($1, $2)", [video, round])).roundId;
    const x = await answer(c, userA, r2, video, 0, "alfa", "relaxed", tr);
    const y = await answer(c, userA, r2, video, 1, "gama", "relaxed", tr);

    const first = await db.connect();
    const second = await db.connect();
    const observer = await db.connect();
    try {
      await first.query("begin");
      await first.query("set local role service_role");
      const started = (await first.query(BEGIN_SQL, [userA, r2, [x], "batch", "missing", 1, "m"])).rows[0].fn_explanations_begin;
      expect(started.status).toBe("started");
      const pid = await backendPid(second);
      const waiting = svc<Begin>(second, BEGIN_SQL, [userA, r2, [x], "batch", "missing", 1, "m"]);
      await waitUntilBlocked(observer, pid);
      await first.query("commit");
      expect(await waiting).toEqual({ status: "in_progress", operationId: started.operationId });
      expect(await begin(c, userA, r2, [y])).toEqual({ status: "busy" });
    } finally {
      await first.end();
      await second.end();
      await observer.end();
    }
    await c.query("update explanation_operations set lease_expires_at = clock_timestamp() - interval '1 second' where round_id = $1 and status = 'started'", [r2]);
    const nextA = await begin(c, userA, r2, [y]);
    await c.query("update explanation_operations set lease_expires_at = clock_timestamp() - interval '1 second' where id = $1", [nextA.operationId]);
    const nextB = await begin(c, userA, r2, [x, y]);
    const seqs = (await c.query("select seq from explanation_operations where round_id = $1 order by seq", [r2])).rows.map((r) => Number(r.seq));
    expect(seqs).toEqual([1, 2, 3]);
    expect(nextB.seq).toBe(3);
  });

  it("a request after another save completed pays nothing for covered targets; partial coverage begins only what's missing; reexplain is explicit", async () => {
    // a0 is saved (earlier test); a2 is the same relaxed mistake in another sentence → covered too.
    expect(await begin(c, userA, round, [a0])).toEqual({ status: "reuse", covered: [a0], targets: [] });
    expect(await begin(c, userA, round, [a2])).toEqual({ status: "reuse", covered: [a2], targets: [] });
    const opsBefore = await count(c, "select count(*) n from explanation_operations where round_id = $1", [round]);
    const partial = await begin(c, userA, round, [a2, a1]);
    expect(partial).toMatchObject({ status: "started", targets: [a1], covered: [a2] });
    expect(await count(c, "select count(*) n from explanation_operations where round_id = $1", [round])).toBe(opsBefore + 1);
    // The operation only accepts the authoritative remaining targets.
    expect(await finish(c, userA, round, partial.operationId!, partial.token!, [note(a2)])).toEqual({ status: "invalid_payload", reason: "not_a_target" });
    expect(await finish(c, userA, round, partial.operationId!, partial.token!, [note(a1, "Gamma (relaxed).")])).toMatchObject({ status: "saved" });

    const again = await begin(c, userA, round, [a0], { intent: "reexplain" });
    expect(again).toMatchObject({ status: "started", targets: [a0], covered: [] });
    await abandon(c, userA, round, again.operationId!, again.token!);
  });

  it("reuse identity is conservative: exact case vs punctuation, relaxed vs learning, and unknown mode never share", async () => {
    // a1 (relaxed) is saved; a3 has the same texts under 'learning' → still missing.
    const learning = await begin(c, userA, round, [a3]);
    expect(learning).toMatchObject({ status: "started", targets: [a3] });
    await abandon(c, userA, round, learning.operationId!, learning.token!);
    // a5 (exact, punctuation-only) is saved; a4 (exact, case-only) is a different exact mistake.
    const exact = await begin(c, userA, round, [a4]);
    expect(exact).toMatchObject({ status: "started", targets: [a4] });
    await abandon(c, userA, round, exact.operationId!, exact.token!);
    // a6 (relaxed) is saved; a7 has identical texts but an unknown (legacy) mode.
    const unknown = await begin(c, userA, round, [a7]);
    expect(unknown).toMatchObject({ status: "started", targets: [a7] });
    await abandon(c, userA, round, unknown.operationId!, unknown.token!);

    const view = await reportView(c, userA, round);
    const shown = view.resolve([a2, a3, a4, a7]);
    expect(shown.get(a2)).toMatchObject({ explanation: "Alpha explanation.", via: "pattern", viaSegmentIndex: 0, legacy: false });
    expect(shown.get(a3)?.via).not.toBe("pattern"); // learning ≠ relaxed
    expect(shown.get(a4)).toBeUndefined(); // case-only ≠ punctuation-only; a LATER answer's note is never shown as "earlier"
    // a7 (unknown mode) gets no cross-attempt match; it may only show an earlier answer's note, labelled historical.
    expect(shown.get(a7)).toMatchObject({ via: "earlier_answer", historical: true });
  });

  it("no reuse across rounds or users; RLS shows each owner only their notes; app roles can't write or call writers", async () => {
    const r2 = (await c.query("select id from learning_sessions where user_id = $1 and status = 'active'", [userA])).rows[0].id as string;
    const sameMistakeNewRound = await answer(c, userA, r2, video, 0, "alpha bet", "relaxed", tr);
    await c.query("update explanation_operations set lease_expires_at = clock_timestamp() - interval '1 second' where round_id = $1 and status = 'started'", [r2]);
    // Round A has a saved note for this exact mistake; the new round must not reuse it.
    const cross = await begin(c, userA, r2, [sameMistakeNewRound]);
    expect(cross).toMatchObject({ status: "started", covered: [], targets: [sameMistakeNewRound] });
    await abandon(c, userA, r2, cross.operationId!, cross.token!);
    const bRound = (await c.query("select id from learning_sessions where user_id = $1", [userB])).rows[0].id as string;
    const bSame = await answer(c, userB, bRound, video, 0, "alpha bet", "relaxed", tr);
    expect(await begin(c, userB, bRound, [bSame])).toMatchObject({ status: "started", covered: [] });

    const visibleToB = await asRole(c, "authenticated", userB, async () =>
      (await c.query("select count(*) n from attempt_explanations where round_id = $1", [round])).rows[0].n
    );
    expect(Number(visibleToB)).toBe(0);
    const visibleToA = await asRole(c, "authenticated", userA, async () =>
      (await c.query("select count(*) n from attempt_explanations where round_id = $1", [round])).rows[0].n
    );
    expect(Number(visibleToA)).toBeGreaterThan(0);

    for (const role of ["authenticated", "anon"] as const) {
      const who = role === "authenticated" ? userA : null;
      expect((await errorOf(asRole(c, role, who, () => c.query(BEGIN_SQL, [userA, round, [a3], "batch", "missing", 1, "m"]))))?.code).toBe("42501");
      expect((await errorOf(asRole(c, role, who, () =>
        c.query("insert into attempt_explanations (user_id, round_id, attempt_id, source, operation_id, seq, explanation, prompt_version, model, created_at) values ($1, $2, $3, 'batch', null, 1, 'x', 1, 'm', now())", [userA, round, a3])
      )))?.code).toBe("42501");
      expect((await errorOf(asRole(c, role, who, () => c.query("delete from attempt_explanations"))))?.code).toBe("42501");
      expect((await errorOf(asRole(c, role, who, () => c.query("select count(*) from explanation_operations"))))?.code).toBe("42501");
    }
    // service_role writes only through the RPCs, never directly; internal helpers are not callable.
    expect((await errorOf(asRole(c, "service_role", null, () => c.query("update attempt_explanations set explanation = 'x'")))) ?.code).toBe("42501");
    expect((await errorOf(asRole(c, "service_role", null, () =>
      c.query("select fn_capture_legacy_feedback_row($1, $2, 'x', null, null, now())", [randomUUID(), a3])
    )))?.code).toBe("42501");
  });
});
