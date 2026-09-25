/**
 * Real-Postgres integration tests for Phase 1 ("all new schema, plus
 * duplicate-active-round reconciliation" — migrations 022-030). See
 * .claude/video-learning-management-plan.md §12, Phase 1.
 *
 * NOT RUN as part of `npm test` and NOT executed while producing this
 * change — same reason, and same gating discipline, as the Phase 0 suite
 * (src/__tests__/integration/transcript-revision-publish.integration.test.ts):
 * this environment has no supabase/docker CLI, so there is no local
 * Postgres/Supabase instance to run against. To run:
 *
 *   supabase start
 *   supabase db reset   # applies every migration in supabase/migrations/
 *   PHASE1_IT_URL=http://127.0.0.1:54321 \
 *   PHASE1_IT_ANON_KEY=<local anon key> \
 *   PHASE1_IT_SERVICE_ROLE_KEY=<local service_role key> \
 *   PHASE1_IT_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *   npx jest src/__tests__/integration/phase1-schema.integration.test.ts
 *
 * (The local anon/service_role keys and DB port are printed by
 * `supabase start`; 54322 is its default direct-Postgres port.)
 *
 * PHASE1_IT_DATABASE_URL is a direct Postgres connection, via the `pg`
 * package (a new devDependency, added only for this test tier), used for
 * the handful of assertions PostgREST/supabase-js cannot express at all:
 * multi-statement transaction rollback, and a real table-lock-vs-
 * concurrent-writer race. Every other assertion goes through the ordinary
 * @supabase/supabase-js client, exactly like the Phase 0 suite, so RLS/
 * GRANT behavior is exercised exactly as a real client would see it.
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
    "[phase1-schema.integration.test.ts] Skipped — PHASE1_IT_URL / PHASE1_IT_ANON_KEY / " +
      "PHASE1_IT_SERVICE_ROLE_KEY not set. Run against a local `supabase start` instance to " +
      "execute (see file header)."
  );
} else if (!HAS_PG) {
  console.warn(
    "[phase1-schema.integration.test.ts] PHASE1_IT_DATABASE_URL not set — the raw-Postgres-only " +
      "block (reconciliation determinism/rollback, lock-vs-writer race, backfill replay) is " +
      "skipped; every other test still runs."
  );
}

type PgClient = import("pg").Client;

function makePgClient(): PgClient {
  // Required lazily so a plain `npm test` (env absent) never needs `pg`
  // resolvable at module-load time for the whole suite to collect cleanly.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Client } = require("pg");
  return new Client({ connectionString: DATABASE_URL });
}

async function createTestUser(service: SupabaseClient, tag: string) {
  const email = `phase1-it-${tag}-${randomUUID()}@example.test`;
  const password = "Phase1Integration!23";
  const { data, error } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) {
    throw new Error(`createTestUser(${tag}) failed: ${error?.message}`);
  }
  const client = createClient(URL as string, ANON_KEY as string);
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) {
    throw new Error(`sign-in for ${tag} failed: ${signInError.message}`);
  }
  return { client, id: data.user.id as string, email };
}

async function deleteTestUser(service: SupabaseClient, userId: string) {
  await service.auth.admin.deleteUser(userId);
}

describeIfEnv("Phase 1 schema (real Postgres)", () => {
  let service: SupabaseClient;
  let userA: { client: SupabaseClient; id: string; email: string };
  let userB: { client: SupabaseClient; id: string; email: string };
  let videoId: string;

  beforeAll(async () => {
    service = createClient(URL as string, SERVICE_ROLE_KEY as string);
    userA = await createTestUser(service, "a");
    userB = await createTestUser(service, "b");
  });

  afterAll(async () => {
    await deleteTestUser(service, userA.id);
    await deleteTestUser(service, userB.id);
  });

  beforeEach(async () => {
    videoId = `p1-${randomUUID()}`;
    await service.from("videos").upsert({ youtube_video_id: videoId });
  });

  afterEach(async () => {
    await service.from("study_sessions").delete().eq("youtube_video_id", videoId);
    await service.from("shadowing_attempts").delete().eq("youtube_video_id", videoId);
    await service.from("listening_progress").delete().eq("youtube_video_id", videoId);
    await service.from("user_videos").delete().eq("youtube_video_id", videoId);
    await service.from("learning_sessions").delete().eq("youtube_video_id", videoId);
    await service.from("listening_sessions").delete().eq("youtube_video_id", videoId);
    await service.from("videos").delete().eq("youtube_video_id", videoId);
  });

  // -----------------------------------------------------------------
  // Nullable fields, FKs, checks, partial unique indexes
  // -----------------------------------------------------------------
  describe("nullable fields, FKs, checks, and partial unique indexes", () => {
    it("2/3. a fresh round has provenance='current' and a null completed_at/required_sentence_count (upgrade-from-Phase-0 shape: only schema defaults, nothing invented)", async () => {
      const { data: round, error } = await service
        .from("learning_sessions")
        .insert({ user_id: userA.id, youtube_video_id: videoId, status: "active" })
        .select("provenance, completed_at, required_sentence_count, round_number")
        .single();
      expect(error).toBeNull();
      expect(round).toMatchObject({ provenance: "current", completed_at: null, required_sentence_count: null, round_number: 1 });
    });

    it("3. attempt_logs.hint_level_used accepts null with no fabricated default", async () => {
      const { data: round } = await service
        .from("learning_sessions")
        .insert({ user_id: userA.id, youtube_video_id: videoId, status: "active" })
        .select("id")
        .single();
      const { data: attempt, error } = await service
        .from("attempt_logs")
        .insert({
          session_id: round!.id,
          segment_index: 0,
          expected_text: "hello",
          user_text: "hello",
          is_correct: true,
        })
        .select("hint_level_used, segment_identity_provenance, client_attempt_id")
        .single();
      expect(error).toBeNull();
      expect(attempt?.hint_level_used).toBeNull();
      expect(attempt?.segment_identity_provenance).toBe("verified");
      expect(attempt?.client_attempt_id).toEqual(expect.any(String));
    });

    it("3. study_sessions.round_id accepts null (a Listening-only session needs no round)", async () => {
      const { data, error } = await service
        .from("study_sessions")
        .insert({ user_id: userA.id, youtube_video_id: videoId, round_id: null })
        .select("id, round_id")
        .single();
      expect(error).toBeNull();
      expect(data?.round_id).toBeNull();
    });

    it("3. listening_progress: one null-transcript row and one row per distinct transcript_id are both independently unique per user/video", async () => {
      const first = await service
        .from("listening_progress")
        .insert({ user_id: userA.id, youtube_video_id: videoId, transcript_id: null })
        .select("id")
        .single();
      expect(first.error).toBeNull();

      // A second null-transcript row for the same (user, video) violates
      // listening_progress_identity_no_transcript_idx.
      const secondNull = await service
        .from("listening_progress")
        .insert({ user_id: userA.id, youtube_video_id: videoId, transcript_id: null });
      expect(secondNull.error).not.toBeNull();
      expect(secondNull.error?.code).toBe("23505");

      const { data: transcript } = await service
        .from("transcripts")
        .insert({ youtube_video_id: videoId, language: "en", source: "manual", status: "ready" })
        .select("id")
        .single();
      // A transcript-scoped row for the same (user, video, transcript_id)
      // coexists fine alongside the null-transcript row above — the two
      // partial indexes are independent.
      const withTranscript = await service
        .from("listening_progress")
        .insert({ user_id: userA.id, youtube_video_id: videoId, transcript_id: transcript!.id });
      expect(withTranscript.error).toBeNull();

      await service.from("transcripts").delete().eq("id", transcript!.id);
    });

    it("6/9. learning_sessions_one_active_per_video rejects a second active round for the same (user, video)", async () => {
      const first = await service
        .from("learning_sessions")
        .insert({ user_id: userA.id, youtube_video_id: videoId, status: "active" });
      expect(first.error).toBeNull();

      const second = await service
        .from("learning_sessions")
        .insert({ user_id: userA.id, youtube_video_id: videoId, status: "active" });
      expect(second.error).not.toBeNull();
      expect(second.error?.code).toBe("23505");

      // A NULL user_id (anonymous) is unaffected — the index only
      // constrains rows with a real user_id (see migration 030's comment).
      const anon1 = await service
        .from("learning_sessions")
        .insert({ user_id: null, youtube_video_id: videoId, status: "active" });
      const anon2 = await service
        .from("learning_sessions")
        .insert({ user_id: null, youtube_video_id: videoId, status: "active" });
      expect(anon1.error).toBeNull();
      expect(anon2.error).toBeNull();
    });
  });

  // -----------------------------------------------------------------
  // Owner reads vs. cross-user reads
  // -----------------------------------------------------------------
  describe("4. allowed owner reads and denied cross-user reads", () => {
    it("study_sessions: owner sees their row, another authenticated user does not", async () => {
      const { data: row } = await service
        .from("study_sessions")
        .insert({ user_id: userA.id, youtube_video_id: videoId })
        .select("id")
        .single();

      const ownRead = await userA.client.from("study_sessions").select("id").eq("id", row!.id).maybeSingle();
      expect(ownRead.error).toBeNull();
      expect(ownRead.data?.id).toBe(row!.id);

      const crossRead = await userB.client.from("study_sessions").select("id").eq("id", row!.id).maybeSingle();
      expect(crossRead.error).toBeNull();
      expect(crossRead.data).toBeNull(); // filtered out by RLS, not an error
    });

    it("shadowing_attempts / listening_progress / attempt_logs follow the same owner-read pattern", async () => {
      const { data: round } = await service
        .from("learning_sessions")
        .insert({ user_id: userA.id, youtube_video_id: videoId, status: "active" })
        .select("id")
        .single();
      const { data: shadow } = await service
        .from("shadowing_attempts")
        .insert({
          user_id: userA.id,
          round_id: round!.id,
          youtube_video_id: videoId,
          segment_index: 0,
          recording_duration_sec: 2,
          is_practice_valid: true,
        })
        .select("id")
        .single();
      const { data: listening } = await service
        .from("listening_progress")
        .insert({ user_id: userA.id, youtube_video_id: videoId, transcript_id: null })
        .select("id")
        .single();
      const { data: attempt } = await service
        .from("attempt_logs")
        .insert({ session_id: round!.id, segment_index: 0, expected_text: "hi", user_text: "hi", is_correct: true })
        .select("id")
        .single();

      for (const [table, id] of [
        ["shadowing_attempts", shadow!.id],
        ["listening_progress", listening!.id],
        ["attempt_logs", attempt!.id],
      ] as const) {
        const own = await userA.client.from(table).select("id").eq("id", id).maybeSingle();
        expect(own.data?.id).toBe(id);
        const cross = await userB.client.from(table).select("id").eq("id", id).maybeSingle();
        expect(cross.data).toBeNull();
      }
    });
  });

  // -----------------------------------------------------------------
  // Denied direct client writes to protected tables
  // -----------------------------------------------------------------
  describe("5. denied direct client writes to protected tables", () => {
    it("an authenticated client cannot INSERT into study_sessions, shadowing_attempts, listening_progress, or attempt_logs", async () => {
      const { data: round } = await service
        .from("learning_sessions")
        .insert({ user_id: userA.id, youtube_video_id: videoId, status: "active" })
        .select("id")
        .single();

      const studyInsert = await userA.client.from("study_sessions").insert({ user_id: userA.id, youtube_video_id: videoId });
      expect(studyInsert.error).not.toBeNull();

      const shadowInsert = await userA.client.from("shadowing_attempts").insert({
        user_id: userA.id,
        round_id: round!.id,
        youtube_video_id: videoId,
        segment_index: 0,
        recording_duration_sec: 2,
        is_practice_valid: true,
      });
      expect(shadowInsert.error).not.toBeNull();

      const listeningInsert = await userA.client
        .from("listening_progress")
        .insert({ user_id: userA.id, youtube_video_id: videoId, transcript_id: null });
      expect(listeningInsert.error).not.toBeNull();

      const attemptInsert = await userA.client
        .from("attempt_logs")
        .insert({ session_id: round!.id, segment_index: 0, expected_text: "hi", user_text: "hi", is_correct: true });
      expect(attemptInsert.error).not.toBeNull();
    });

    it("an authenticated client cannot read app_write_gate or the migration_030 reconciliation audit log", async () => {
      const gate = await userA.client.from("app_write_gate").select("*");
      expect(gate.error).not.toBeNull();
      const audit = await userA.client.from("migration_030_abandoned_rounds_log").select("*");
      expect(audit.error).not.toBeNull();
    });
  });

  // -----------------------------------------------------------------
  // user_videos owner CRUD + ownership-change rejection
  // -----------------------------------------------------------------
  describe("user_videos owner CRUD", () => {
    it("owner can insert, select, update, and delete their own row", async () => {
      const insert = await userA.client
        .from("user_videos")
        .insert({ user_id: userA.id, youtube_video_id: videoId })
        .select("id")
        .single();
      expect(insert.error).toBeNull();

      const read = await userA.client.from("user_videos").select("id").eq("id", insert.data!.id).maybeSingle();
      expect(read.data?.id).toBe(insert.data!.id);

      const update = await userA.client
        .from("user_videos")
        .update({ last_mode: "listening" })
        .eq("id", insert.data!.id)
        .select("last_mode")
        .single();
      expect(update.error).toBeNull();
      expect(update.data?.last_mode).toBe("listening");

      const del = await userA.client.from("user_videos").delete().eq("id", insert.data!.id);
      expect(del.error).toBeNull();
    });

    it("cannot forge another user's user_id on insert, and cannot read/update another user's row", async () => {
      const forged = await userA.client.from("user_videos").insert({ user_id: userB.id, youtube_video_id: videoId });
      expect(forged.error).not.toBeNull();

      const { data: bRow } = await service
        .from("user_videos")
        .insert({ user_id: userB.id, youtube_video_id: videoId })
        .select("id")
        .single();

      const crossRead = await userA.client.from("user_videos").select("id").eq("id", bRow!.id).maybeSingle();
      expect(crossRead.data).toBeNull();

      const crossUpdate = await userA.client.from("user_videos").update({ last_mode: "dictation" }).eq("id", bRow!.id).select("id");
      expect(crossUpdate.data).toEqual([]); // RLS filters the target row — nothing updated, not an error

      // Attempting to steal the row by reassigning its user_id is blocked
      // by the policy's `with check` even for the row's rightful owner.
      const steal = await userB.client.from("user_videos").update({ user_id: userA.id }).eq("id", bRow!.id).select("id");
      expect(steal.error).not.toBeNull();
    });
  });

  // -----------------------------------------------------------------
  // Continued operation of the existing service-role Dictation writer
  // -----------------------------------------------------------------
  describe("7. existing service-role Dictation writer", () => {
    it("a service-role insert into attempt_logs (dictation/check/route.ts's exact shape) still succeeds after the RLS tightening", async () => {
      const { data: round } = await service
        .from("learning_sessions")
        .insert({ user_id: userA.id, youtube_video_id: videoId, status: "active" })
        .select("id")
        .single();
      const { error } = await service.from("attempt_logs").insert({
        session_id: round!.id,
        segment_index: 0,
        expected_text: "Hello world.",
        user_text: "Hello world.",
        normalized_expected_text: "hello world",
        normalized_user_text: "hello world",
        is_correct: true,
        error_type: null,
      });
      expect(error).toBeNull();
    });
  });

  // -----------------------------------------------------------------
  // Admin escalation prevention + legitimate profile updates
  // -----------------------------------------------------------------
  describe("8. admin escalation prevention", () => {
    it("a user's own PATCH to is_admin succeeds as a statement but has no effect on the column; an ordinary field still updates", async () => {
      const patch = await userA.client
        .from("users")
        .update({ is_admin: true, display_name: "Phase 1 tester" })
        .eq("id", userA.id)
        .select("is_admin, display_name")
        .single();
      expect(patch.error).toBeNull();
      expect(patch.data?.is_admin).toBe(false); // silently discarded by the trigger
      expect(patch.data?.display_name).toBe("Phase 1 tester"); // ordinary edit preserved

      const { data: confirmed } = await service.from("users").select("is_admin").eq("id", userA.id).single();
      expect(confirmed?.is_admin).toBe(false);
    });

    it("service_role can set is_admin (the only trusted path), and this test does not leave it set afterward", async () => {
      const set = await service.from("users").update({ is_admin: true }).eq("id", userA.id).select("is_admin").single();
      expect(set.error).toBeNull();
      expect(set.data?.is_admin).toBe(true);
      // Revert — Phase 1 must not leave any real/test user promoted.
      await service.from("users").update({ is_admin: false }).eq("id", userA.id);
    });
  });

  // -----------------------------------------------------------------
  // Write-gate and audit-log isolation
  // -----------------------------------------------------------------
  describe("9. write-gate and audit-log isolation", () => {
    it("app_write_gate: anon/authenticated cannot read it; service_role can, and it starts unpaused", async () => {
      const anonClient = createClient(URL as string, ANON_KEY as string);
      const anonRead = await anonClient.from("app_write_gate").select("*");
      expect(anonRead.error).not.toBeNull();

      const authedRead = await userA.client.from("app_write_gate").select("*");
      expect(authedRead.error).not.toBeNull();

      const serviceRead = await service.from("app_write_gate").select("*").eq("id", 1).single();
      expect(serviceRead.error).toBeNull();
      expect(serviceRead.data?.completion_writes_paused).toBe(false);
    });
  });

  // ===================================================================
  // Raw-Postgres-only: multi-statement transaction control needed for
  // these guarantees (reconciliation determinism + rollback, table-lock
  // vs. a concurrent writer, and a faithful replay of the two backfill
  // queries against isolated fixture data — see file header for why
  // these specifically cannot be expressed through PostgREST alone).
  // ===================================================================
  describeIfPg("raw-Postgres-only guarantees", () => {
    it("6. reconciliation is deterministic, preserves round data, and a failure rolls back both the status changes and the audit entries", async () => {
      const pg = makePgClient();
      await pg.connect();
      try {
        await pg.query("BEGIN");
        // The real index (created once, permanently, by migration 030) is
        // dropped ONLY inside this transaction, which ends in ROLLBACK —
        // Postgres restores it exactly as it was the instant this
        // transaction ends, with zero lasting effect on the shared
        // database or any concurrently running test.
        await pg.query("DROP INDEX learning_sessions_one_active_per_video");

        const older = await pg.query(
          `insert into learning_sessions (user_id, youtube_video_id, status, current_segment_index, updated_at)
           values ($1, $2, 'active', 3, now() - interval '2 hours') returning id`,
          [userA.id, videoId]
        );
        const middle = await pg.query(
          `insert into learning_sessions (user_id, youtube_video_id, status, current_segment_index, updated_at)
           values ($1, $2, 'active', 7, now() - interval '1 hour') returning id`,
          [userA.id, videoId]
        );
        const newest = await pg.query(
          `insert into learning_sessions (user_id, youtube_video_id, status, current_segment_index, updated_at)
           values ($1, $2, 'active', 1, now()) returning id`,
          [userA.id, videoId]
        );
        const olderId = older.rows[0].id;
        const middleId = middle.rows[0].id;
        const newestId = newest.rows[0].id;

        // The exact reconciliation logic from migration 030 (survivor
        // selection + audit insert + status update), scoped implicitly to
        // this transaction's own fixture rows since videoId is unique per
        // test.
        await pg.query(`
          with ranked as (
            select id, user_id, youtube_video_id, status, updated_at,
              row_number() over (
                partition by user_id, youtube_video_id
                order by updated_at desc, started_at desc, id desc
              ) as rn
            from learning_sessions
            where status = 'active' and user_id is not null and youtube_video_id = $1
          ),
          survivors as (
            select user_id, youtube_video_id, id as survivor_round_id from ranked where rn = 1
          ),
          losers as (
            select r.id as round_id, r.user_id, r.youtube_video_id, r.status as previous_status
            from ranked r where r.rn > 1
          )
          insert into migration_030_abandoned_rounds_log (round_id, user_id, youtube_video_id, previous_status, survivor_round_id)
          select l.round_id, l.user_id, l.youtube_video_id, l.previous_status, s.survivor_round_id
          from losers l join survivors s on s.user_id = l.user_id and s.youtube_video_id = l.youtube_video_id;
        `, [videoId]);

        await pg.query(
          `update learning_sessions set status = 'abandoned', updated_at = now()
           where id in (select round_id from migration_030_abandoned_rounds_log where youtube_video_id = $1)`,
          [videoId]
        );

        // Deterministic survivor: newest (most recent updated_at) wins,
        // never chosen by current_segment_index (middle has the highest,
        // 7, and is NOT the survivor).
        const audit = await pg.query(
          `select round_id, previous_status, survivor_round_id from migration_030_abandoned_rounds_log where youtube_video_id = $1 order by round_id`,
          [videoId]
        );
        expect(audit.rows).toHaveLength(2);
        for (const row of audit.rows) {
          expect(row.previous_status).toBe("active");
          expect(row.survivor_round_id).toBe(newestId);
          expect([olderId, middleId]).toContain(row.round_id);
        }

        const statuses = await pg.query(
          `select id, status, current_segment_index from learning_sessions where youtube_video_id = $1 order by updated_at`,
          [videoId]
        );
        const byId = Object.fromEntries(statuses.rows.map((r: { id: string; status: string; current_segment_index: number }) => [r.id, r]));
        expect(byId[olderId]).toMatchObject({ status: "abandoned", current_segment_index: 3 }); // history preserved
        expect(byId[middleId]).toMatchObject({ status: "abandoned", current_segment_index: 7 }); // history preserved
        expect(byId[newestId]).toMatchObject({ status: "active", current_segment_index: 1 });

        // Now deliberately corrupt the just-established invariant (as if
        // this migration's own logic had a bug and left a residual
        // duplicate), so CREATE UNIQUE INDEX fails — this is the "failure"
        // half of this test.
        await pg.query(`update learning_sessions set status = 'active' where id = $1`, [olderId]);
        await expect(
          pg.query(`create unique index learning_sessions_one_active_per_video on learning_sessions(user_id, youtube_video_id) where status = 'active'`)
        ).rejects.toThrow();

        // A failed statement aborts the transaction — nothing further can
        // run on it except ROLLBACK.
        await pg.query("ROLLBACK");
      } finally {
        await pg.end();
      }

      // Post-rollback, on fresh connections: NONE of this transaction's
      // work persisted — not the fixture rounds, not the audit rows, not
      // the temporary index drop. The real index (from migration 030) is
      // intact and still enforces uniqueness for an ordinary client,
      // exactly as before this test ran.
      const auditAfter = await service.from("migration_030_abandoned_rounds_log").select("id").eq("youtube_video_id", videoId);
      expect(auditAfter.data).toEqual([]);
      const roundsAfter = await service.from("learning_sessions").select("id").eq("youtube_video_id", videoId);
      expect(roundsAfter.data).toEqual([]);

      const first = await service.from("learning_sessions").insert({ user_id: userA.id, youtube_video_id: videoId, status: "active" });
      expect(first.error).toBeNull();
      const second = await service.from("learning_sessions").insert({ user_id: userA.id, youtube_video_id: videoId, status: "active" });
      expect(second.error?.code).toBe("23505");
    }, 30000);

    it("the reconciliation lock (SHARE mode) blocks a concurrent learning_sessions writer until released", async () => {
      const lockConn = makePgClient();
      const writerConn = makePgClient();
      await lockConn.connect();
      await writerConn.connect();
      try {
        await lockConn.query("BEGIN");
        await lockConn.query("LOCK TABLE learning_sessions IN SHARE MODE");

        let writerDone = false;
        const writerPromise = writerConn
          .query(
            `insert into learning_sessions (user_id, youtube_video_id, status) values ($1, $2, 'active') returning id`,
            [userA.id, videoId]
          )
          .then((r: { rows: { id: string }[] }) => {
            writerDone = true;
            return r.rows[0].id;
          });

        // Give the writer every chance to complete if it were NOT
        // actually blocked. 300ms is generous for a local loopback
        // connection; this is a real timing-based concurrency assertion,
        // consistent with how this kind of lock test is normally written.
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(writerDone).toBe(false);

        await lockConn.query("ROLLBACK"); // releases the lock; no writes were made on this connection
        const insertedId = await writerPromise;
        expect(writerDone).toBe(true);

        await service.from("learning_sessions").delete().eq("id", insertedId);
      } finally {
        await lockConn.end();
        await writerConn.end();
      }
    }, 30000);

    it("10. backfill query pattern: combined-then-aggregated timestamps across both legacy sources (not decided by arbitrary source order)", async () => {
      const pg = makePgClient();
      await pg.connect();
      try {
        // learning_sessions: earliest evidence, started 3 days ago.
        await pg.query(
          `insert into learning_sessions (user_id, youtube_video_id, status, started_at, updated_at) values ($1, $2, 'abandoned', now() - interval '3 days', now() - interval '3 days')`,
          [userA.id, videoId]
        );
        // listening_sessions: latest activity, updated 1 hour ago.
        await pg.query(
          `insert into listening_sessions (user_id, youtube_video_id, started_at, updated_at) values ($1, $2, now() - interval '2 days', now() - interval '1 hour')`,
          [userA.id, videoId]
        );

        // The exact aggregation shape from migration 027.
        const result = await pg.query(
          `select user_id, youtube_video_id,
             min(started_at) as added_at,
             max(last_activity_at) as last_activity_at
           from (
             select user_id, youtube_video_id, started_at, updated_at as last_activity_at
             from learning_sessions where user_id = $1 and youtube_video_id = $2
             union all
             select user_id, youtube_video_id, started_at, updated_at as last_activity_at
             from listening_sessions where user_id = $1 and youtube_video_id = $2
           ) combined_evidence
           group by user_id, youtube_video_id`,
          [userA.id, videoId]
        );
        expect(result.rows).toHaveLength(1);
        const learningStarted = await pg.query(`select started_at from learning_sessions where youtube_video_id = $1`, [videoId]);
        const listeningUpdated = await pg.query(`select updated_at from listening_sessions where youtube_video_id = $1`, [videoId]);
        // added_at is the EARLIEST across both sources (learning_sessions'
        // started_at, 3 days ago) — not whichever source's grouped row a
        // naive UNION-then-ON-CONFLICT approach happened to process first.
        expect(new Date(result.rows[0].added_at).getTime()).toBe(new Date(learningStarted.rows[0].started_at).getTime());
        // last_activity_at is the LATEST across both sources
        // (listening_sessions' updated_at, 1 hour ago).
        expect(new Date(result.rows[0].last_activity_at).getTime()).toBe(new Date(listeningUpdated.rows[0].updated_at).getTime());
      } finally {
        await pg.end();
      }
    });

    it("11. legacy position-only backfill produces zero Listening coverage, never inferred from the playhead position", async () => {
      const pg = makePgClient();
      await pg.connect();
      try {
        await pg.query(
          `insert into listening_sessions (user_id, youtube_video_id, video_current_time, updated_at) values ($1, $2, 245.7, now())`,
          [userA.id, videoId]
        );

        // The exact backfill INSERT from migration 026.
        await pg.query(
          `insert into listening_progress (user_id, youtube_video_id, transcript_id, last_position_sec, legacy_source, updated_at)
           select distinct on (user_id, youtube_video_id, transcript_id)
             user_id, youtube_video_id, transcript_id, video_current_time, 'legacy_listening_sessions', updated_at
           from listening_sessions
           where user_id = $1 and youtube_video_id = $2
           order by user_id, youtube_video_id, transcript_id, updated_at desc, id desc
           on conflict do nothing`,
          [userA.id, videoId]
        );

        const row = await pg.query(
          `select last_position_sec, covered_sec, coverage_ratio, listened_through, legacy_source, covered_intervals
           from listening_progress where user_id = $1 and youtube_video_id = $2`,
          [userA.id, videoId]
        );
        expect(row.rows).toHaveLength(1);
        expect(Number(row.rows[0].last_position_sec)).toBeCloseTo(245.7);
        expect(Number(row.rows[0].covered_sec)).toBe(0);
        expect(Number(row.rows[0].coverage_ratio)).toBe(0);
        expect(row.rows[0].listened_through).toBe(false);
        expect(row.rows[0].covered_intervals).toEqual([]);
        expect(row.rows[0].legacy_source).toBe("legacy_listening_sessions");
      } finally {
        await pg.end();
      }
    });
  });
});
