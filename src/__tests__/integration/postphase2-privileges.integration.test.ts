/**
 * Real-Postgres verification of the Phase 2 function permission matrix after
 * 036_phase2_user_rpc_privilege_corrections.sql.
 *
 * NOT RUN by `npm test` in an environment without a local Supabase stack —
 * every test below is skipped (reported as skipped, never as passed) unless
 * the env vars are set. Same env vars and instance as the Phase 1/2 suites:
 *
 *   supabase start
 *   supabase db reset   # applies 001 through 036
 *   PHASE1_IT_URL=http://127.0.0.1:54321 \
 *   PHASE1_IT_ANON_KEY=<local anon key> \
 *   PHASE1_IT_SERVICE_ROLE_KEY=<local service_role key> \
 *   PHASE1_IT_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *   npx jest src/__tests__/integration/postphase2-privileges.integration.test.ts
 *
 * Never point these variables at the production project.
 *
 * Two layers, because mocked Supabase calls cannot verify grants:
 *   1. has_function_privilege() over every Phase 2 function signature —
 *      EFFECTIVE privilege, including PUBLIC and role inheritance — plus an
 *      overload census from pg_proc so no uncorrected overload can hide.
 *   2. Real PostgREST calls with the real anon / authenticated /
 *      service_role keys, asserting permission-denied (42501) vs. allowed.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";

const URL = process.env.PHASE1_IT_URL;
const ANON_KEY = process.env.PHASE1_IT_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.PHASE1_IT_SERVICE_ROLE_KEY;
const DATABASE_URL = process.env.PHASE1_IT_DATABASE_URL;
const HAS_ENV = !!URL && !!ANON_KEY && !!SERVICE_ROLE_KEY;
const HAS_PG = HAS_ENV && !!DATABASE_URL;
const describeIfEnv = HAS_ENV ? describe : describe.skip;
const describeIfPg = HAS_PG ? describe : describe.skip;

if (!HAS_PG) {
  console.warn(
    "[postphase2-privileges.integration.test.ts] Skipped (entirely or partly) — set PHASE1_IT_URL, " +
      "PHASE1_IT_ANON_KEY, PHASE1_IT_SERVICE_ROLE_KEY and PHASE1_IT_DATABASE_URL against a local " +
      "`supabase start` instance to execute."
  );
}

type Role = "anon" | "authenticated" | "service_role";
type Expectation = Record<Role, boolean>;
const NONE: Expectation = { anon: false, authenticated: false, service_role: false };
const USER_ONLY: Expectation = { anon: false, authenticated: true, service_role: false };
const BACKEND_ONLY: Expectation = { anon: false, authenticated: false, service_role: true };

/** The intended matrix at the end of Phase 2 (after 036). */
const MATRIX: Array<[string, Expectation]> = [
  // Dormant authoritative functions — activated only in Phase 3.
  ["fn_create_or_get_active_round(text)", NONE],
  ["fn_update_resume_position(uuid, integer, numeric)", NONE],
  ["fn_restart_round(text)", NONE],
  ["fn_record_dictation_attempt(uuid, text, integer, uuid, text, text, text, uuid, uuid, smallint)", NONE],
  ["fn_record_shadowing_attempt(uuid, text, integer, uuid, numeric, uuid, uuid)", NONE],
  // User-actor functions (036 removed the retained service_role grant).
  ["fn_get_or_create_study_session(text, uuid)", USER_ONLY],
  ["fn_flush_study_activity(text, uuid, uuid, text, jsonb, uuid, numeric, text)", USER_ONLY],
  ["fn_legacy_save_progress(uuid, text, uuid, integer, numeric, numeric, integer, text)", USER_ONLY],
  ["fn_legacy_restart_round(text, uuid)", USER_ONLY],
  // Backend-only functions.
  ["fn_persist_azure_result(uuid, integer, text, numeric, numeric, numeric, numeric, numeric, text, text)", BACKEND_ONLY],
  ["fn_persist_word_match_result(uuid, integer, text, numeric, numeric)", BACKEND_ONLY],
  ["fn_legacy_record_dictation_attempt(uuid, integer, text, text, text, text, boolean, text)", BACKEND_ONLY],
  // Private helpers — never directly callable by application roles.
  ["fn_check_write_gate()", NONE],
  ["fn_eligible_segment_count(uuid)", NONE],
  ["fn_merge_intervals(jsonb)", NONE],
  ["fn_intervals_union_length(jsonb)", NONE],
  ["fn_intervals_intersect(jsonb, jsonb)", NONE],
  ["fn_transcript_valid_union(uuid)", NONE],
  ["fn_normalize_dictation_text(text, text)", NONE],
  ["fn_round_coverage(uuid, integer)", NONE],
];

describeIfPg("Phase 2 function privileges after 036 — effective (has_function_privilege)", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Client } = require("pg");
  const pg = new Client({ connectionString: DATABASE_URL });
  beforeAll(() => pg.connect());
  afterAll(() => pg.end());

  it.each(MATRIX)("%s matches the intended matrix", async (sig, expected) => {
    for (const role of ["anon", "authenticated", "service_role"] as Role[]) {
      const r = await pg.query("select has_function_privilege($1, $2, 'EXECUTE') as ok", [role, `public.${sig}`]);
      expect({ role, ok: r.rows[0].ok }).toEqual({ role, ok: expected[role] });
    }
  });

  it.each(MATRIX)("%s grants nothing to PUBLIC", async (sig) => {
    const r = await pg.query(
      `select count(*)::int as n
         from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        where p.oid = $1::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE'`,
      [`public.${sig}`]
    );
    expect(r.rows[0].n).toBe(0);
  });

  it("every Phase 2 function name has exactly one overload (none escaped the matrix)", async () => {
    const names = [...new Set(MATRIX.map(([sig]) => sig.slice(0, sig.indexOf("("))))];
    const r = await pg.query(
      `select p.proname, count(*)::int as n
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = any($1)
        group by p.proname`,
      [names]
    );
    expect(r.rows).toHaveLength(names.length);
    for (const row of r.rows) expect({ name: row.proname, n: row.n }).toEqual({ name: row.proname, n: 1 });
  });

  it("service_role is not a member of authenticated/anon (the corrected matrix doesn't rely on inheritance)", async () => {
    const r = await pg.query(
      `select pg_has_role('service_role', 'authenticated', 'member') as auth_member,
              pg_has_role('service_role', 'anon', 'member') as anon_member`
    );
    expect(r.rows[0]).toEqual({ auth_member: false, anon_member: false });
  });
});

describeIfEnv("Phase 2 function privileges after 036 — real role-based calls", () => {
  let service: SupabaseClient;
  let userClient: SupabaseClient;
  const videoId = `priv036-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    service = createClient(URL as string, SERVICE_ROLE_KEY as string, { auth: { persistSession: false } });
    const email = `priv036-${randomUUID()}@example.test`;
    const password = "Priv036Integration!23";
    const { error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw new Error(`createUser failed: ${error.message}`);
    userClient = createClient(URL as string, ANON_KEY as string);
    const { error: signInError } = await userClient.auth.signInWithPassword({ email, password });
    if (signInError) throw new Error(`signIn failed: ${signInError.message}`);
  });

  const userActorCalls: Array<[string, Record<string, unknown>]> = [
    ["fn_legacy_save_progress", { p_youtube_video_id: "x", p_current_segment_index: 0 }],
    ["fn_legacy_restart_round", { p_youtube_video_id: "x" }],
    ["fn_get_or_create_study_session", { p_youtube_video_id: "x" }],
    [
      "fn_flush_study_activity",
      { p_kind: "listening", p_study_session_id: randomUUID(), p_flush_batch_id: randomUUID(), p_youtube_video_id: "x" },
    ],
  ];

  it.each(userActorCalls)("service_role is denied %s (42501)", async (fn, args) => {
    const { error } = await service.rpc(fn, args);
    expect(error?.code).toBe("42501");
  });

  it.each(userActorCalls)("anon is denied %s (42501)", async (fn, args) => {
    const anon = createClient(URL as string, ANON_KEY as string);
    const { error } = await anon.rpc(fn, args);
    expect(error?.code).toBe("42501");
  });

  it("authenticated can still execute the user-actor bridge (restart on a video with no round is a no-op ok)", async () => {
    const { data, error } = await userClient.rpc("fn_legacy_restart_round", { p_youtube_video_id: videoId });
    expect(error).toBeNull();
    expect(data).toEqual({ status: "ok" });
  });

  it("service_role still reaches the backend-only provider persistence (no 42501)", async () => {
    const { error } = await service.rpc("fn_persist_word_match_result", {
      p_attempt_id: randomUUID(),
      p_seq: 1,
      p_status: "completed",
      p_accuracy: 80,
      p_completeness: 100,
    });
    expect(error?.code).not.toBe("42501");
    // A wrong signature would surface as "function not found", which must
    // not be mistaken for "permission granted".
    expect(error?.code).not.toBe("PGRST202");
  });

  it("authenticated is still denied the backend-only and dormant functions (42501)", async () => {
    const backend = await userClient.rpc("fn_persist_word_match_result", {
      p_attempt_id: randomUUID(),
      p_seq: 1,
      p_status: "completed",
      p_accuracy: 80,
      p_completeness: 100,
    });
    expect(backend.error?.code).toBe("42501");
    const dormant = await userClient.rpc("fn_create_or_get_active_round", { p_youtube_video_id: videoId });
    expect(dormant.error?.code).toBe("42501");
  });
});
