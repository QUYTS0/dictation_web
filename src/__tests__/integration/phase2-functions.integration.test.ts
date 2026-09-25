/**
 * Real-Postgres integration tests for Phase 2 (migrations 031-035 — see
 * .claude/video-learning-management-plan.md §12, Phase 2 / PHASE2_RUNBOOK.md).
 *
 * NOT RUN as part of `npm test` and NOT executed while producing this
 * change — same reason as the Phase 0/1 suites: no supabase/docker CLI is
 * available in this environment. To run:
 *
 *   supabase start
 *   supabase db reset   # applies every migration, 001 through 035
 *   PHASE1_IT_URL=http://127.0.0.1:54321 \
 *   PHASE1_IT_ANON_KEY=<local anon key> \
 *   PHASE1_IT_SERVICE_ROLE_KEY=<local service_role key> \
 *   PHASE1_IT_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *   npx jest src/__tests__/integration/phase2-functions.integration.test.ts
 *
 * Deliberately reuses the Phase 1 suite's env var names (PHASE1_IT_*)
 * rather than introducing a fourth near-duplicate set — both suites target
 * the same single local `supabase start` instance.
 *
 * Two distinct connection strategies, used for different, non-overlapping
 * purposes:
 *   - @supabase/supabase-js (PostgREST-mediated), with REAL signed-up test
 *     users: exercises actual role-based GRANT/RLS enforcement exactly as
 *     a browser would experience it — used for privilege verification, the
 *     legacy bridges (granted to `authenticated`), and the write-fence
 *     test.
 *   - Raw `pg`, connected as the migration-owning role (the connection
 *     string's role, typically `postgres`, which owns every function this
 *     migration set creates and therefore always has implicit EXECUTE on
 *     its own functions regardless of any REVOKE targeting anon/
 *     authenticated/service_role): used ONLY for exercising the business
 *     logic of the five functions intentionally left dormant
 *     (fn_create_or_get_active_round, fn_update_resume_position,
 *     fn_restart_round, fn_record_dictation_attempt,
 *     fn_record_shadowing_attempt) — per the Phase 2 task's explicit
 *     allowance: "Business-logic tests for dormant functions may use an
 *     isolated migration-owner test connection with controlled auth
 *     context." `auth.uid()`/`auth.role()` are simulated by setting the
 *     `request.jwt.claims` GUC locally on that connection (the same
 *     mechanism PostgREST itself uses) — this does NOT touch or weaken any
 *     actual GRANT; the dormant functions remain genuinely uncallable by
 *     every real application role, verified separately via
 *     has_function_privilege() and real supabase-js .rpc() calls below.
 *
 * If the required env vars are absent, every test below is skipped with a
 * clear reason rather than silently reported as passing.
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

if (!HAS_ENV) {
  console.warn(
    "[phase2-functions.integration.test.ts] Skipped — PHASE1_IT_URL / PHASE1_IT_ANON_KEY / " +
      "PHASE1_IT_SERVICE_ROLE_KEY not set. Run against a local `supabase start` instance to execute."
  );
} else if (!HAS_PG) {
  console.warn(
    "[phase2-functions.integration.test.ts] PHASE1_IT_DATABASE_URL not set — the dormant-function " +
      "business-logic block (completion race, idempotency, listening race, provider staleness) is " +
      "skipped; every other test still runs."
  );
}

type PgClient = import("pg").Client;
function makePgClient(): PgClient {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Client } = require("pg");
  return new Client({ connectionString: DATABASE_URL });
}

async function setClaims(pg: PgClient, claims: Record<string, unknown>) {
  await pg.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
}
async function asUser(pg: PgClient, userId: string) {
  await setClaims(pg, { sub: userId, role: "authenticated" });
}

async function createTestUser(service: SupabaseClient, tag: string) {
  const email = `phase2-it-${tag}-${randomUUID()}@example.test`;
  const password = "Phase2Integration!23";
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`createTestUser(${tag}) failed: ${error?.message}`);
  const client = createClient(URL as string, ANON_KEY as string);
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`sign-in for ${tag} failed: ${signInError.message}`);
  return { client, id: data.user.id as string };
}

function seg(i: number, start: number, end: number, text: string) {
  return { segmentIndex: i, start, end, text, textNormalized: text.toLowerCase().replace(/[.?!]/g, "") };
}

/** Publishes a ready transcript with N one-second segments via the real Phase 0 RPC. */
async function publishTranscript(service: SupabaseClient, videoId: string, count: number) {
  const segments = Array.from({ length: count }, (_, i) => seg(i, i, i + 1, `Sentence number ${i}.`));
  const { data, error } = await service.rpc("fn_publish_transcript_revision", {
    p_youtube_video_id: videoId,
    p_language: "en",
    p_source: "manual",
    p_full_text: segments.map((s) => s.text).join(" "),
    p_segments: segments,
    p_content_fingerprint: `fp-${videoId}`,
  });
  if (error) throw new Error(`publishTranscript failed: ${error.message}`);
  return (data as { id: string }).id;
}

describeIfEnv("Phase 2 (real Postgres)", () => {
  let service: SupabaseClient;
  let userA: { client: SupabaseClient; id: string };
  let userB: { client: SupabaseClient; id: string };
  let videoId: string;

  beforeAll(async () => {
    service = createClient(URL as string, SERVICE_ROLE_KEY as string);
    userA = await createTestUser(service, "a");
    userB = await createTestUser(service, "b");
  });

  afterAll(async () => {
    await service.auth.admin.deleteUser(userA.id);
    await service.auth.admin.deleteUser(userB.id);
  });

  beforeEach(async () => {
    videoId = `p2-${randomUUID()}`;
    await service.from("videos").upsert({ youtube_video_id: videoId });
  });

  afterEach(async () => {
    await service.from("shadowing_attempts").delete().eq("youtube_video_id", videoId);
    await service.from("learning_sessions").delete().eq("youtube_video_id", videoId);
    await service.from("study_sessions").delete().eq("youtube_video_id", videoId);
    await service.from("listening_progress").delete().eq("youtube_video_id", videoId);
    await service.from("transcripts").delete().eq("youtube_video_id", videoId);
    await service.from("videos").delete().eq("youtube_video_id", videoId);
  });

  // -----------------------------------------------------------------
  // Corrected privileges (migration 031)
  // -----------------------------------------------------------------
  describe("corrected table privileges", () => {
    it("anon has no privilege on attempt_logs at all — not just RLS-blocked", async () => {
      const anonClient = createClient(URL as string, ANON_KEY as string);
      const res = await anonClient.from("attempt_logs").select("id").limit(1);
      expect(res.error).not.toBeNull(); // permission denied, not just empty
    });

    it("authenticated has SELECT only on attempt_logs — INSERT/UPDATE/DELETE all denied at the privilege layer", async () => {
      const insert = await userA.client.from("attempt_logs").insert({
        session_id: randomUUID(),
        segment_index: 0,
        expected_text: "x",
        user_text: "x",
        is_correct: true,
      });
      expect(insert.error).not.toBeNull();

      const update = await userA.client.from("attempt_logs").update({ is_correct: false }).eq("id", randomUUID());
      expect(update.error).not.toBeNull();

      const del = await userA.client.from("attempt_logs").delete().eq("id", randomUUID());
      expect(del.error).not.toBeNull();
    });

    it("service_role can still SELECT and INSERT attempt_logs (the Dictation writer keeps working)", async () => {
      const transcriptId = await publishTranscript(service, videoId, 3);
      const { data: round } = await service
        .from("learning_sessions")
        .insert({ user_id: userA.id, youtube_video_id: videoId, status: "active", transcript_id: transcriptId })
        .select("id")
        .single();
      const insert = await service.from("attempt_logs").insert({
        session_id: round!.id,
        segment_index: 0,
        expected_text: "Sentence number 0.",
        user_text: "Sentence number 0.",
        is_correct: true,
      });
      expect(insert.error).toBeNull();
      const read = await service.from("attempt_logs").select("id").eq("session_id", round!.id);
      expect(read.data).toHaveLength(1);
    });

    it("app_write_gate and migration_030_abandoned_rounds_log are unreachable by anon/authenticated", async () => {
      const anonClient = createClient(URL as string, ANON_KEY as string);
      for (const client of [anonClient, userA.client]) {
        expect((await client.from("app_write_gate").select("*")).error).not.toBeNull();
        expect((await client.from("migration_030_abandoned_rounds_log").select("*")).error).not.toBeNull();
      }
    });

    it("service_role can read the gate and update its pause flag, and can read (not write) the audit log", async () => {
      const read = await service.from("app_write_gate").select("*").eq("id", 1).single();
      expect(read.error).toBeNull();
      const auditRead = await service.from("migration_030_abandoned_rounds_log").select("*").limit(1);
      expect(auditRead.error).toBeNull();
      const auditInsert = await service
        .from("migration_030_abandoned_rounds_log")
        .insert({ round_id: randomUUID(), previous_status: "active", survivor_round_id: randomUUID(), youtube_video_id: videoId });
      expect(auditInsert.error).not.toBeNull(); // service_role is read-only on this table by design
    });
  });

  // -----------------------------------------------------------------
  // Function grants — dormant functions reject every application role;
  // backend-only functions reject ordinary callers
  // -----------------------------------------------------------------
  describe("function execution privileges", () => {
    it("the five dormant authoritative functions reject anon, authenticated, AND service_role", async () => {
      const anonClient = createClient(URL as string, ANON_KEY as string);
      for (const client of [anonClient, userA.client, service]) {
        const r1 = await client.rpc("fn_create_or_get_active_round", { p_youtube_video_id: videoId });
        expect(r1.error).not.toBeNull();
        const r2 = await client.rpc("fn_restart_round", { p_youtube_video_id: videoId });
        expect(r2.error).not.toBeNull();
      }
    });

    it("backend-only functions (fn_persist_azure_result, fn_persist_word_match_result, fn_legacy_record_dictation_attempt) reject anon and authenticated", async () => {
      const anonClient = createClient(URL as string, ANON_KEY as string);
      for (const client of [anonClient, userA.client]) {
        expect(
          (await client.rpc("fn_persist_azure_result", { p_attempt_id: randomUUID(), p_seq: 0, p_status: "failed" })).error
        ).not.toBeNull();
        expect(
          (await client.rpc("fn_legacy_record_dictation_attempt", {
            p_session_id: randomUUID(),
            p_segment_index: 0,
            p_expected_text: "x",
            p_user_text: "x",
            p_normalized_expected_text: "x",
            p_normalized_user_text: "x",
            p_is_correct: true,
          })).error
        ).not.toBeNull();
      }
    });

    it("user-actor RPCs reject a caller with no authenticated identity (anon)", async () => {
      const anonClient = createClient(URL as string, ANON_KEY as string);
      const res = await anonClient.rpc("fn_legacy_save_progress", { p_youtube_video_id: videoId, p_current_segment_index: 0 });
      expect(res.error).not.toBeNull();
    });
  });

  // -----------------------------------------------------------------
  // Legacy bridges — behavioral / current-route compatibility
  // -----------------------------------------------------------------
  describe("fn_legacy_save_progress — compatibility", () => {
    it("first touch resolves the current transcript server-side and pins it", async () => {
      const transcriptId = await publishTranscript(service, videoId, 3);
      const { data, error } = await userA.client.rpc("fn_legacy_save_progress", {
        p_youtube_video_id: videoId,
        p_current_segment_index: 0,
      });
      expect(error).toBeNull();
      const { data: row } = await service.from("learning_sessions").select("transcript_id").eq("id", (data as { sessionId: string }).sessionId).single();
      expect(row?.transcript_id).toBe(transcriptId);
    });

    it("rejects a stale client-believed transcriptId on first touch (regeneration race)", async () => {
      await publishTranscript(service, videoId, 3);
      const res = await userA.client.rpc("fn_legacy_save_progress", {
        p_youtube_video_id: videoId,
        p_transcript_id: randomUUID(), // not the real current transcript
        p_current_segment_index: 0,
      });
      expect(res.error?.message).toBe("stale_transcript_revision");
    });

    it("an ordinary update never repins an already-pinned round's transcript_id", async () => {
      const transcriptId = await publishTranscript(service, videoId, 3);
      const first = await userA.client.rpc("fn_legacy_save_progress", { p_youtube_video_id: videoId, p_current_segment_index: 0 });
      const sessionId = (first.data as { sessionId: string }).sessionId;
      await userA.client.rpc("fn_legacy_save_progress", {
        p_session_id: sessionId,
        p_youtube_video_id: videoId,
        p_current_segment_index: 2,
      });
      const { data: row } = await service.from("learning_sessions").select("transcript_id").eq("id", sessionId).single();
      expect(row?.transcript_id).toBe(transcriptId);
    });

    it("rejects an existing session update whose transcriptId mismatches the pin", async () => {
      await publishTranscript(service, videoId, 3);
      const first = await userA.client.rpc("fn_legacy_save_progress", { p_youtube_video_id: videoId, p_current_segment_index: 0 });
      const sessionId = (first.data as { sessionId: string }).sessionId;
      const res = await userA.client.rpc("fn_legacy_save_progress", {
        p_session_id: sessionId,
        p_youtube_video_id: videoId,
        p_transcript_id: randomUUID(),
        p_current_segment_index: 2,
      });
      expect(res.error?.message).toBe("stale_transcript_revision");
    });

    it("12. concurrent first-saves for the same (user, video) resolve to ONE round, and the winner-reuse path rejects a mismatched transcriptId", async () => {
      const transcriptId = await publishTranscript(service, videoId, 3);
      const [r1, r2] = await Promise.all([
        userA.client.rpc("fn_legacy_save_progress", { p_youtube_video_id: videoId, p_transcript_id: transcriptId, p_current_segment_index: 0 }),
        userA.client.rpc("fn_legacy_save_progress", { p_youtube_video_id: videoId, p_transcript_id: transcriptId, p_current_segment_index: 0 }),
      ]);
      expect(r1.error).toBeNull();
      expect(r2.error).toBeNull();
      expect((r1.data as { sessionId: string }).sessionId).toBe((r2.data as { sessionId: string }).sessionId);

      const { data: rounds } = await service.from("learning_sessions").select("id").eq("youtube_video_id", videoId).eq("status", "active");
      expect(rounds).toHaveLength(1);

      // A THIRD concurrent-shaped call believing a different (stale) revision
      // must be rejected, never silently attached to the winner's round.
      const stale = await userA.client.rpc("fn_legacy_save_progress", {
        p_youtube_video_id: videoId, p_transcript_id: randomUUID(), p_current_segment_index: 0,
      });
      expect(stale.error?.message).toBe("stale_transcript_revision");
    });
  });

  describe("fn_legacy_restart_round — compatibility", () => {
    it("abandons the active round without creating a new one (mirrors today's route exactly)", async () => {
      await publishTranscript(service, videoId, 3);
      const created = await userA.client.rpc("fn_legacy_save_progress", { p_youtube_video_id: videoId, p_current_segment_index: 0 });
      const sessionId = (created.data as { sessionId: string }).sessionId;

      const res = await userA.client.rpc("fn_legacy_restart_round", { p_youtube_video_id: videoId });
      expect(res.error).toBeNull();

      const { data: row } = await service.from("learning_sessions").select("status").eq("id", sessionId).single();
      expect(row?.status).toBe("abandoned");
      const { data: rounds } = await service.from("learning_sessions").select("id").eq("youtube_video_id", videoId);
      expect(rounds).toHaveLength(1); // no new round created by restart itself
    });
  });

  // -----------------------------------------------------------------
  // Write-fence: real independent connections, deterministic
  // synchronization. Mutates the GLOBAL app_write_gate singleton — must
  // not run concurrently with any other test hitting a real bridge call.
  // Cleans up in a finally block regardless of assertion outcome.
  // -----------------------------------------------------------------
  describeIfPg("write-fence (mutates the global app_write_gate singleton — run in isolation)", () => {
    it("13. a fence that pauses the gate blocks admission of new writers only after draining the one it waited for; later bridge calls reject without writing", async () => {
      const writerConn = makePgClient();
      const fenceConn = makePgClient();
      await writerConn.connect();
      await fenceConn.connect();
      try {
        await publishTranscript(service, videoId, 3);

        // 1. The writer holds the gate's SHARE lock while "writing" (a
        //    real fn_legacy_save_progress call, held open by wrapping it
        //    in an explicit transaction that we don't commit immediately).
        await writerConn.query("BEGIN");
        await asUser(writerConn, userA.id);
        const writerPromise = writerConn.query(
          `select fn_legacy_save_progress(p_youtube_video_id => $1, p_current_segment_index => 0)`,
          [videoId]
        );

        // Give the writer a moment to acquire its FOR SHARE lock inside
        // fn_check_write_gate before the fence tries to acquire FOR UPDATE.
        await new Promise((r) => setTimeout(r, 150));

        // 2. The fence requests the EXCLUSIVE (FOR UPDATE) lock and waits
        //    — SHARE and UPDATE locks conflict, so this genuinely blocks
        //    until the writer's transaction ends.
        await fenceConn.query("BEGIN");
        let fenceAdmitted = false;
        const fencePromise = fenceConn.query(`select * from app_write_gate where id = 1 for update`).then((r: unknown) => {
          fenceAdmitted = true;
          return r;
        });

        await new Promise((r) => setTimeout(r, 200));
        expect(fenceAdmitted).toBe(false); // still blocked — the writer hasn't committed yet

        // 3. The admitted writer completes.
        await writerConn.query("COMMIT");
        await writerPromise;

        // Now the fence is admitted.
        await fencePromise;
        expect(fenceAdmitted).toBe(true);

        // 4. The fence sets paused and commits.
        await fenceConn.query(`update app_write_gate set completion_writes_paused = true, paused_at = now() where id = 1`);
        await fenceConn.query("COMMIT");

        // 5. Later bridge calls reject without writing.
        const before = await service.from("learning_sessions").select("id").eq("youtube_video_id", videoId);
        const rejected = await userA.client.rpc("fn_legacy_save_progress", { p_youtube_video_id: videoId, p_current_segment_index: 1 });
        expect(rejected.error?.message).toBe("write_gate_paused");
        const after = await service.from("learning_sessions").select("id").eq("youtube_video_id", videoId);
        expect(after.data?.length).toBe(before.data?.length); // nothing written
      } finally {
        await service.from("app_write_gate").update({ completion_writes_paused: false, paused_at: null }).eq("id", 1);
        await writerConn.end().catch(() => {});
        await fenceConn.end().catch(() => {});
      }
    }, 30000);
  });

  // -----------------------------------------------------------------
  // Dormant-function business logic — raw pg, migration-owner connection,
  // simulated auth context (see file header for why this is the correct,
  // grant-preserving way to test these).
  // -----------------------------------------------------------------
  describeIfPg("dormant authoritative functions — business logic", () => {
    let pg: PgClient;
    beforeEach(async () => {
      pg = makePgClient();
      await pg.connect();
    });
    afterEach(async () => {
      await pg.end();
    });

    it("has_function_privilege confirms authenticated/anon/service_role all lack EXECUTE on fn_record_dictation_attempt", async () => {
      const sig = "fn_record_dictation_attempt(uuid, text, integer, uuid, text, text, text, uuid, uuid, smallint)";
      for (const role of ["anon", "authenticated", "service_role"]) {
        const r = await pg.query(`select has_function_privilege($1, $2, 'EXECUTE') as ok`, [role, sig]);
        expect(r.rows[0].ok).toBe(false);
      }
    });

    it("16. concurrent submissions of the final two required sentences complete the round exactly once", async () => {
      const transcriptId = await publishTranscript(service, videoId, 10);
      await asUser(pg, userA.id);
      const created = await pg.query(`select fn_create_or_get_active_round($1) as r`, [videoId]);
      const roundId = created.rows[0].r.roundId;

      // Practice sentences 0-7 sequentially first.
      for (let i = 0; i < 8; i++) {
        await pg.query(
          `select fn_record_dictation_attempt($1,$2,$3,$4,$5,'relaxed',null,$6,null,null) as r`,
          [roundId, videoId, i, randomUUID(), `Sentence number ${i}.`, transcriptId]
        );
      }

      // 9 and 10 concurrently, on two separate connections both simulating userA.
      const pg2 = makePgClient();
      await pg2.connect();
      await asUser(pg2, userA.id);
      try {
        const [r9, r10] = await Promise.all([
          pg.query(`select fn_record_dictation_attempt($1,$2,8,$3,$4,'relaxed',null,$5,null,null) as r`,
            [roundId, videoId, randomUUID(), "Sentence number 8.", transcriptId]),
          pg2.query(`select fn_record_dictation_attempt($1,$2,9,$3,$4,'relaxed',null,$5,null,null) as r`,
            [roundId, videoId, randomUUID(), "Sentence number 9.", transcriptId]),
        ]);
        const completions = [r9.rows[0].r.roundCompletedByThisRequest, r10.rows[0].r.roundCompletedByThisRequest];
        expect(completions.filter(Boolean)).toHaveLength(1); // exactly once

        const { data: round } = await service.from("learning_sessions").select("status").eq("id", roundId).single();
        expect(round?.status).toBe("completed");
      } finally {
        await pg2.end();
      }
    }, 30000);

    it("17. a genuine retry (same clientAttemptId, same payload) returns the same attempt with unchanged timestamps and never re-completes", async () => {
      const transcriptId = await publishTranscript(service, videoId, 2);
      await asUser(pg, userA.id);
      const created = await pg.query(`select fn_create_or_get_active_round($1) as r`, [videoId]);
      const roundId = created.rows[0].r.roundId;
      const clientAttemptId = randomUUID();

      const first = await pg.query(
        `select fn_record_dictation_attempt($1,$2,0,$3,$4,'relaxed',null,$5,null,null) as r`,
        [roundId, videoId, clientAttemptId, "Sentence number 0.", transcriptId]
      );
      const { data: before } = await service.from("attempt_logs").select("id, created_at").eq("session_id", roundId).eq("segment_index", 0).single();

      const retry = await pg.query(
        `select fn_record_dictation_attempt($1,$2,0,$3,$4,'relaxed',null,$5,null,null) as r`,
        [roundId, videoId, clientAttemptId, "Sentence number 0.", transcriptId]
      );
      expect(retry.rows[0].r.wasInserted).toBe(false);
      expect(retry.rows[0].r.roundCompletedByThisRequest).toBe(false);
      expect(retry.rows[0].r.attemptId).toBe(first.rows[0].r.attemptId);

      const { data: rows } = await service.from("attempt_logs").select("id, created_at").eq("session_id", roundId).eq("segment_index", 0);
      expect(rows).toHaveLength(1);
      expect(rows![0].created_at).toBe(before!.created_at);
    });

    it("18. reusing a clientAttemptId with a different payload is rejected", async () => {
      const transcriptId = await publishTranscript(service, videoId, 2);
      await asUser(pg, userA.id);
      const created = await pg.query(`select fn_create_or_get_active_round($1) as r`, [videoId]);
      const roundId = created.rows[0].r.roundId;
      const clientAttemptId = randomUUID();

      await pg.query(`select fn_record_dictation_attempt($1,$2,0,$3,$4,'relaxed',null,$5,null,null) as r`,
        [roundId, videoId, clientAttemptId, "Sentence number 0.", transcriptId]);

      await expect(
        pg.query(`select fn_record_dictation_attempt($1,$2,0,$3,$4,'relaxed',null,$5,null,null) as r`,
          [roundId, videoId, clientAttemptId, "A totally different answer.", transcriptId])
      ).rejects.toThrow(/idempotency_key_reused_with_different_payload/);
    });

    it("a wrong or hinted submission still counts as practice; correctness is recomputed server-side, never trusted from the caller", async () => {
      const transcriptId = await publishTranscript(service, videoId, 2);
      await asUser(pg, userA.id);
      const created = await pg.query(`select fn_create_or_get_active_round($1) as r`, [videoId]);
      const roundId = created.rows[0].r.roundId;

      const wrong = await pg.query(
        `select fn_record_dictation_attempt($1,$2,0,$3,$4,'relaxed',null,$5,null,1) as r`,
        [roundId, videoId, randomUUID(), "completely wrong text", transcriptId]
      );
      expect(wrong.rows[0].r.isCorrect).toBe(false);
      const { data: row } = await service.from("attempt_logs").select("is_practice_valid, hint_level_used").eq("id", wrong.rows[0].r.attemptId).single();
      expect(row?.is_practice_valid).toBe(true); // still counts as practice
      expect(row?.hint_level_used).toBe(1);
    });

    it("segment text is server-resolved from the pinned transcript — a request cannot fabricate correctness by lying about the reference text", async () => {
      // fn_record_dictation_attempt never accepts an expected_text
      // parameter at all (only p_user_text) — resolved internally from
      // (round.transcript_id, segment_index). Submitting the segment's
      // REAL text must grade correct.
      const transcriptId = await publishTranscript(service, videoId, 1);
      await asUser(pg, userA.id);
      const created = await pg.query(`select fn_create_or_get_active_round($1) as r`, [videoId]);
      const roundId = created.rows[0].r.roundId;
      const res = await pg.query(
        `select fn_record_dictation_attempt($1,$2,0,$3,$4,'relaxed',null,$5,null,null) as r`,
        [roundId, videoId, randomUUID(), "Sentence number 0.", transcriptId]
      );
      expect(res.rows[0].r.isCorrect).toBe(true);
    });

    it("zero required sentences never auto-completes and never divides by zero", async () => {
      // A transcript with no eligible segments (0 required) — publish
      // with one malformed (empty-text) segment only.
      const { data: t } = await service
        .from("transcripts")
        .insert({ youtube_video_id: videoId, language: "en", source: "manual", status: "ready", is_current: true })
        .select("id")
        .single();
      await service.from("transcript_segments").insert({ transcript_id: t!.id, segment_index: 0, start_sec: 0, end_sec: 1, duration_sec: 1, text_raw: "", text_normalized: "" });

      await asUser(pg, userA.id);
      const created = await pg.query(`select fn_create_or_get_active_round($1) as r`, [videoId]);
      expect(created.rows[0].r.requiredSentenceCount).toBe(0);
      const { data: round } = await service.from("learning_sessions").select("status").eq("id", created.rows[0].r.roundId).single();
      expect(round?.status).toBe("active"); // never auto-completed
    });

    it("19. concurrent round creation for a brand-new (user, video) resolves to exactly one active round", async () => {
      await publishTranscript(service, videoId, 3);
      const pg2 = makePgClient();
      await pg2.connect();
      await asUser(pg, userA.id);
      await asUser(pg2, userA.id);
      try {
        const [r1, r2] = await Promise.all([
          pg.query(`select fn_create_or_get_active_round($1) as r`, [videoId]),
          pg2.query(`select fn_create_or_get_active_round($1) as r`, [videoId]),
        ]);
        expect(r1.rows[0].r.roundId).toBe(r2.rows[0].r.roundId);
        const { data: rounds } = await service.from("learning_sessions").select("id").eq("youtube_video_id", videoId).eq("status", "active");
        expect(rounds).toHaveLength(1);
      } finally {
        await pg2.end();
      }
    }, 30000);

    it("a late attempt against an abandoned round never reactivates it", async () => {
      const transcriptId = await publishTranscript(service, videoId, 2);
      await asUser(pg, userA.id);
      const created = await pg.query(`select fn_create_or_get_active_round($1) as r`, [videoId]);
      const roundId = created.rows[0].r.roundId;
      await service.from("learning_sessions").update({ status: "abandoned" }).eq("id", roundId);

      const res = await pg.query(
        `select fn_record_dictation_attempt($1,$2,0,$3,$4,'relaxed',null,$5,null,null) as r`,
        [roundId, videoId, randomUUID(), "Sentence number 0.", transcriptId]
      );
      expect(res.rows[0].r.wasInserted).toBe(true); // honest history still recorded
      expect(res.rows[0].r.roundCompletedByThisRequest).toBe(false);
      const { data: round } = await service.from("learning_sessions").select("status").eq("id", roundId).single();
      expect(round?.status).toBe("abandoned"); // never resurrected
    });

    it("mixed-mode coverage deduplicates overlapping sentences (union, not sum)", async () => {
      const transcriptId = await publishTranscript(service, videoId, 4);
      await asUser(pg, userA.id);
      const created = await pg.query(`select fn_create_or_get_active_round($1) as r`, [videoId]);
      const roundId = created.rows[0].r.roundId;

      await pg.query(`select fn_record_dictation_attempt($1,$2,0,$3,$4,'relaxed',null,$5,null,null) as r`,
        [roundId, videoId, randomUUID(), "Sentence number 0.", transcriptId]);
      await pg.query(`select fn_record_dictation_attempt($1,$2,1,$3,$4,'relaxed',null,$5,null,null) as r`,
        [roundId, videoId, randomUUID(), "Sentence number 1.", transcriptId]);
      const res = await pg.query(`select fn_record_shadowing_attempt($1,$2,1,$3,2.0,$4,null) as r`,
        [roundId, videoId, randomUUID(), transcriptId]);
      // segment 1 practiced in BOTH modes — overall coverage counts it once: {0,1} = 2/4.
      expect(res.rows[0].r.coverage.overall).toBeCloseTo(0.5);
      expect(res.rows[0].r.coverage.dictation).toBeCloseTo(0.5);
      expect(res.rows[0].r.coverage.shadowing).toBeCloseTo(0.25);
    });

    it("Shadowing validity is computed from duration server-side, never trusted from the caller", async () => {
      const transcriptId = await publishTranscript(service, videoId, 1);
      await asUser(pg, userA.id);
      const created = await pg.query(`select fn_create_or_get_active_round($1) as r`, [videoId]);
      const roundId = created.rows[0].r.roundId;
      const tooShort = await pg.query(`select fn_record_shadowing_attempt($1,$2,0,$3,0.2,$4,null) as r`,
        [roundId, videoId, randomUUID(), transcriptId]);
      expect(tooShort.rows[0].r.isPracticeValid).toBe(false);
    });

    it("20. two different study sessions concurrently observing overlapping Listening intervals credit deltas that sum to the real union increase", async () => {
      const transcriptId = await publishTranscript(service, videoId, 5); // 5s of valid union
      const { data: s1 } = await service.from("study_sessions").insert({ user_id: userA.id, youtube_video_id: videoId }).select("id").single();
      const { data: s2 } = await service.from("study_sessions").insert({ user_id: userA.id, youtube_video_id: videoId }).select("id").single();

      const pg2 = makePgClient();
      await pg2.connect();
      await asUser(pg, userA.id);
      await asUser(pg2, userA.id);
      try {
        const [r1, r2] = await Promise.all([
          pg.query(
            `select fn_flush_study_activity('listening',$1,$2,$3,$4,$5,2.5,null) as r`,
            [s1!.id, randomUUID(), videoId, JSON.stringify([{ start: 0, end: 3 }]), transcriptId]
          ),
          pg2.query(
            `select fn_flush_study_activity('listening',$1,$2,$3,$4,$5,4.0,null) as r`,
            [s2!.id, randomUUID(), videoId, JSON.stringify([{ start: 2, end: 5 }]), transcriptId]
          ),
        ]);
        // Real union of [0,3] and [2,5] is [0,5] = 5s, exactly the whole
        // transcript -- coveredSec on the LATER-applied flush must read 5.
        const finalCovered = Math.max(r1.rows[0].r.coveredSec, r2.rows[0].r.coveredSec);
        expect(finalCovered).toBeCloseTo(5);

        const { data: sessions } = await service.from("study_sessions").select("listening_newly_covered_sec").in("id", [s1!.id, s2!.id]);
        const creditedSum = sessions!.reduce((acc, s) => acc + Number(s.listening_newly_covered_sec), 0);
        expect(creditedSum).toBeCloseTo(5); // sums to the ACTUAL increase, not 3+3=6
      } finally {
        await pg2.end();
      }
    }, 30000);

    it("21. the null-transcript transition is concurrency-safe and happens exactly once", async () => {
      const { data: s0 } = await service.from("study_sessions").insert({ user_id: userA.id, youtube_video_id: videoId }).select("id").single();
      await asUser(pg, userA.id);
      // Observe 4s with no transcript yet.
      await pg.query(`select fn_flush_study_activity('listening',$1,$2,$3,$4,null,4.0,null) as r`,
        [s0!.id, randomUUID(), videoId, JSON.stringify([{ start: 0, end: 4 }])]);

      const transcriptId = await publishTranscript(service, videoId, 5);
      const { data: s1 } = await service.from("study_sessions").insert({ user_id: userA.id, youtube_video_id: videoId }).select("id").single();
      const { data: s2 } = await service.from("study_sessions").insert({ user_id: userA.id, youtube_video_id: videoId }).select("id").single();
      const pg2 = makePgClient();
      await pg2.connect();
      await asUser(pg2, userA.id);
      try {
        // Two concurrent flushes both targeting the NEW transcript_id for
        // the first time.
        await Promise.all([
          pg.query(`select fn_flush_study_activity('listening',$1,$2,$3,$4,$5,4.5,null) as r`,
            [s1!.id, randomUUID(), videoId, JSON.stringify([{ start: 4, end: 4.5 }]), transcriptId]),
          pg2.query(`select fn_flush_study_activity('listening',$1,$2,$3,$4,$5,4.6,null) as r`,
            [s2!.id, randomUUID(), videoId, JSON.stringify([{ start: 4.6, end: 4.8 }]), transcriptId]),
        ]);
        const { data: nullRow } = await service.from("listening_progress").select("superseded_at").eq("user_id", userA.id).eq("youtube_video_id", videoId).is("transcript_id", null).single();
        expect(nullRow?.superseded_at).not.toBeNull(); // transitioned exactly once
        const { data: revRow } = await service.from("listening_progress").select("covered_sec").eq("user_id", userA.id).eq("youtube_video_id", videoId).eq("transcript_id", transcriptId).single();
        // Carried-forward [0,4] intersected with the 5s valid union, plus
        // the two small new observations -- must be > the 0.5s directly
        // observed by session s1 alone, proving the carry-forward applied.
        expect(Number(revRow?.covered_sec)).toBeGreaterThan(4);
      } finally {
        await pg2.end();
      }
    }, 30000);

    it("duplicate flushes (same batch id, same payload) do not duplicate counters", async () => {
      const { data: s1 } = await service.from("study_sessions").insert({ user_id: userA.id, youtube_video_id: videoId }).select("id").single();
      const batchId = randomUUID();
      await asUser(pg, userA.id);
      await pg.query(`select fn_flush_study_activity('activity',$1,$2,$3,$4) as r`,
        [s1!.id, batchId, videoId, JSON.stringify([{ start: 0, end: 10 }])]);
      const retry = await pg.query(`select fn_flush_study_activity('activity',$1,$2,$3,$4) as r`,
        [s1!.id, batchId, videoId, JSON.stringify([{ start: 0, end: 10 }])]);
      expect(retry.rows[0].r.processed).toBe(false);
      const { data: session } = await service.from("study_sessions").select("activity_intervals").eq("id", s1!.id).single();
      expect(session?.activity_intervals).toHaveLength(1);
    });

    it("a reused batch id with a DIFFERENT payload is rejected, not silently applied or ignored", async () => {
      const { data: s1 } = await service.from("study_sessions").insert({ user_id: userA.id, youtube_video_id: videoId }).select("id").single();
      const batchId = randomUUID();
      await asUser(pg, userA.id);
      await pg.query(`select fn_flush_study_activity('activity',$1,$2,$3,$4) as r`,
        [s1!.id, batchId, videoId, JSON.stringify([{ start: 0, end: 10 }])]);
      await expect(
        pg.query(`select fn_flush_study_activity('activity',$1,$2,$3,$4) as r`,
          [s1!.id, batchId, videoId, JSON.stringify([{ start: 100, end: 110 }])])
      ).rejects.toThrow(/flush_batch_id_reused_with_different_payload/);
    });

    it("a failed flush (invalid payload) leaves no marker and no partial update", async () => {
      const { data: s1 } = await service.from("study_sessions").insert({ user_id: userA.id, youtube_video_id: videoId }).select("id").single();
      const batchId = randomUUID();
      await asUser(pg, userA.id);
      await expect(
        pg.query(`select fn_flush_study_activity('activity',$1,$2,$3,$4) as r`,
          [s1!.id, batchId, videoId, JSON.stringify([{ start: 10, end: 5 }])]) // end < start
      ).rejects.toThrow(/invalid_interval_payload/);
      const { data: marker } = await service.from("activity_flush_log").select("*").eq("study_session_id", s1!.id).eq("flush_batch_id", batchId);
      expect(marker).toEqual([]); // no marker-only state
    });

    it("22. a stale provider response (older seq) never overwrites a newer result", async () => {
      const transcriptId = await publishTranscript(service, videoId, 1);
      const { data: round } = await service.from("learning_sessions").insert({ user_id: userA.id, youtube_video_id: videoId, status: "active", transcript_id: transcriptId }).select("id").single();
      const { data: attempt } = await service
        .from("shadowing_attempts")
        .insert({ user_id: userA.id, round_id: round!.id, youtube_video_id: videoId, transcript_id: transcriptId, segment_index: 0, recording_duration_sec: 2, is_practice_valid: true, azure_eval_request_seq: 2 })
        .select("id")
        .single();

      const stale = await service.rpc("fn_persist_azure_result", {
        p_attempt_id: attempt!.id, p_seq: 1, p_status: "completed",
        p_accuracy_score: 99, p_fluency_score: 99, p_completeness_score: 99, p_pronunciation_score: 99,
      });
      expect((stale.data as { applied: boolean }).applied).toBe(false);

      const fresh = await service.rpc("fn_persist_azure_result", {
        p_attempt_id: attempt!.id, p_seq: 2, p_status: "completed",
        p_accuracy_score: 80, p_fluency_score: 80, p_completeness_score: 80, p_pronunciation_score: 80,
      });
      expect((fresh.data as { applied: boolean }).applied).toBe(true);

      const { data: row } = await service.from("shadowing_attempts").select("azure_accuracy_score").eq("id", attempt!.id).single();
      expect(Number(row?.azure_accuracy_score)).toBe(80); // the stale write never landed
    });

    it("a failed evaluation never fabricates a completed score", async () => {
      const transcriptId = await publishTranscript(service, videoId, 1);
      const { data: round } = await service.from("learning_sessions").insert({ user_id: userA.id, youtube_video_id: videoId, status: "active", transcript_id: transcriptId }).select("id").single();
      const { data: attempt } = await service
        .from("shadowing_attempts")
        .insert({ user_id: userA.id, round_id: round!.id, youtube_video_id: videoId, transcript_id: transcriptId, segment_index: 0, recording_duration_sec: 2, is_practice_valid: true })
        .select("id")
        .single();
      const res = await service.rpc("fn_persist_azure_result", { p_attempt_id: attempt!.id, p_seq: 0, p_status: "failed", p_error_reason: "quota_exceeded" });
      expect((res.data as { applied: boolean }).applied).toBe(true);
      const { data: row } = await service.from("shadowing_attempts").select("azure_eval_status, azure_accuracy_score, azure_error_reason").eq("id", attempt!.id).single();
      expect(row?.azure_eval_status).toBe("failed");
      expect(row?.azure_accuracy_score).toBeNull();
      expect(row?.azure_error_reason).toBe("quota_exceeded");
    });

    it("Word Match staleness is independent of Azure's sequence (word_match_request_seq, migration 034)", async () => {
      const transcriptId = await publishTranscript(service, videoId, 1);
      const { data: round } = await service.from("learning_sessions").insert({ user_id: userA.id, youtube_video_id: videoId, status: "active", transcript_id: transcriptId }).select("id").single();
      const { data: attempt } = await service
        .from("shadowing_attempts")
        .insert({ user_id: userA.id, round_id: round!.id, youtube_video_id: videoId, transcript_id: transcriptId, segment_index: 0, recording_duration_sec: 2, is_practice_valid: true, azure_eval_request_seq: 5, word_match_request_seq: 1 })
        .select("id")
        .single();
      // A stale AZURE seq must not block a fresh WORD MATCH write, and vice versa.
      const wm = await service.rpc("fn_persist_word_match_result", { p_attempt_id: attempt!.id, p_seq: 1, p_status: "completed", p_accuracy: 90, p_completeness: 90 });
      expect((wm.data as { applied: boolean }).applied).toBe(true);
      const az = await service.rpc("fn_persist_azure_result", { p_attempt_id: attempt!.id, p_seq: 5, p_status: "completed", p_accuracy_score: 70, p_fluency_score: 70, p_completeness_score: 70, p_pronunciation_score: 70 });
      expect((az.data as { applied: boolean }).applied).toBe(true);
      const { data: row } = await service.from("shadowing_attempts").select("word_match_status, azure_eval_status").eq("id", attempt!.id).single();
      expect(row?.word_match_status).toBe("completed");
      expect(row?.azure_eval_status).toBe("completed");
    });
  });
});
