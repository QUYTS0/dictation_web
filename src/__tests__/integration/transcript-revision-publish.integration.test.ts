/**
 * Real-Postgres integration tests for Phase 0's transcript-revision writer
 * (migrations 020/021 — see .claude/video-learning-management-plan.md).
 *
 * These exercise guarantees that a mocked Supabase client cannot meaningfully
 * verify: the partial unique index, fn_publish_transcript_revision's actual
 * transactional/locking behavior, and effective RPC execution privileges.
 *
 * NOT RUN as part of `npm test` and NOT executed while producing this
 * change — they require a real local Postgres/Supabase instance with
 * migrations 001-021 applied. To run:
 *
 *   supabase start
 *   supabase db reset   # applies every migration in supabase/migrations/
 *   TRANSCRIPT_IT_URL=http://127.0.0.1:54321 \
 *   TRANSCRIPT_IT_ANON_KEY=<local anon key> \
 *   TRANSCRIPT_IT_SERVICE_ROLE_KEY=<local service_role key> \
 *   npx jest src/__tests__/integration/transcript-revision-publish.integration.test.ts
 *
 * (The local anon/service_role keys are printed by `supabase start`.)
 *
 * If the required env vars are absent, every test below is skipped with a
 * clear reason rather than silently reported as passing.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";

const URL = process.env.TRANSCRIPT_IT_URL;
const ANON_KEY = process.env.TRANSCRIPT_IT_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.TRANSCRIPT_IT_SERVICE_ROLE_KEY;
const HAS_ENV = !!URL && !!ANON_KEY && !!SERVICE_ROLE_KEY;

const describeIfEnv = HAS_ENV ? describe : describe.skip;

if (!HAS_ENV) {
  console.warn(
    "[transcript-revision-publish.integration.test.ts] Skipped — TRANSCRIPT_IT_URL / " +
      "TRANSCRIPT_IT_ANON_KEY / TRANSCRIPT_IT_SERVICE_ROLE_KEY not set. Run against a local " +
      "`supabase start` instance to execute (see file header)."
  );
}

function seg(segmentIndex: number, start: number, end: number, text: string, textNormalized?: string) {
  return { segmentIndex, start, end, text, textNormalized: textNormalized ?? text.toLowerCase().replace(/[.?!]/g, "") };
}

describeIfEnv("fn_publish_transcript_revision (real Postgres)", () => {
  let service: SupabaseClient;
  let anon: SupabaseClient;
  let videoId: string;

  beforeAll(() => {
    service = createClient(URL as string, SERVICE_ROLE_KEY as string);
    anon = createClient(URL as string, ANON_KEY as string);
  });

  beforeEach(async () => {
    // A fresh, isolated youtube_video_id per test avoids any cross-test
    // interference with the (youtube_video_id, language) partial unique
    // index / advisory lock scope.
    videoId = `it-${randomUUID()}`;
    await service.from("videos").upsert({ youtube_video_id: videoId });
  });

  afterEach(async () => {
    // Cleanup — transcript_segments cascade-delete with their parent row.
    await service.from("transcripts").delete().eq("youtube_video_id", videoId);
    await service.from("videos").delete().eq("youtube_video_id", videoId);
  });

  it("1/2. exactly one row is is_current per (video, language), enforced by the partial unique index", async () => {
    const { error } = await service.rpc("fn_publish_transcript_revision", {
      p_youtube_video_id: videoId,
      p_language: "en",
      p_source: "manual",
      p_full_text: "Hello world.",
      p_segments: [seg(0, 0, 2, "Hello world.")],
      p_content_fingerprint: "fp-1",
    });
    expect(error).toBeNull();

    const { data: currentRows } = await service
      .from("transcripts")
      .select("id")
      .eq("youtube_video_id", videoId)
      .eq("language", "en")
      .eq("is_current", true);
    expect(currentRows).toHaveLength(1);
  });

  it("4. changed content creates a new revision and preserves the old one (id, segments, is_current=false)", async () => {
    const { data: first } = await service.rpc("fn_publish_transcript_revision", {
      p_youtube_video_id: videoId,
      p_language: "en",
      p_source: "manual",
      p_full_text: "Hello world.",
      p_segments: [seg(0, 0, 2, "Hello world.")],
      p_content_fingerprint: "fp-v1",
    });
    const firstId = (first as { id: string }).id;

    const { data: second } = await service.rpc("fn_publish_transcript_revision", {
      p_youtube_video_id: videoId,
      p_language: "en",
      p_source: "manual",
      p_full_text: "Completely different content.",
      p_segments: [seg(0, 0, 2, "Completely different content.")],
      p_content_fingerprint: "fp-v2",
    });
    const secondId = (second as { id: string; is_current: boolean }).id;

    expect(secondId).not.toBe(firstId);

    const { data: oldRow } = await service.from("transcripts").select("id, is_current, status").eq("id", firstId).single();
    expect(oldRow).toMatchObject({ id: firstId, is_current: false, status: "ready" });

    const { data: oldSegments } = await service.from("transcript_segments").select("id").eq("transcript_id", firstId);
    expect(oldSegments).toHaveLength(1); // untouched, not deleted

    const { data: newRow } = await service.from("transcripts").select("is_current").eq("id", secondId).single();
    expect(newRow?.is_current).toBe(true);
  });

  it("5. identical content (same fingerprint) reuses the existing ready revision — no duplicate row", async () => {
    const { data: first } = await service.rpc("fn_publish_transcript_revision", {
      p_youtube_video_id: videoId,
      p_language: "en",
      p_source: "manual",
      p_full_text: "Hello world.",
      p_segments: [seg(0, 0, 2, "Hello world.")],
      p_content_fingerprint: "fp-same",
    });

    const { data: second } = await service.rpc("fn_publish_transcript_revision", {
      p_youtube_video_id: videoId,
      p_language: "en",
      p_source: "manual",
      p_full_text: "Hello world.",
      p_segments: [seg(0, 0, 2, "Hello world.")],
      p_content_fingerprint: "fp-same",
    });

    expect((second as { id: string }).id).toBe((first as { id: string }).id);

    const { data: rows } = await service.from("transcripts").select("id").eq("youtube_video_id", videoId).eq("language", "en");
    expect(rows).toHaveLength(1);
  });

  it("6. a matching older (non-current) revision can become current again without inserting a duplicate", async () => {
    const { data: v1 } = await service.rpc("fn_publish_transcript_revision", {
      p_youtube_video_id: videoId,
      p_language: "en",
      p_source: "manual",
      p_full_text: "Version one.",
      p_segments: [seg(0, 0, 2, "Version one.")],
      p_content_fingerprint: "fp-1",
    });
    await service.rpc("fn_publish_transcript_revision", {
      p_youtube_video_id: videoId,
      p_language: "en",
      p_source: "manual",
      p_full_text: "Version two.",
      p_segments: [seg(0, 0, 2, "Version two.")],
      p_content_fingerprint: "fp-2",
    });

    // Regenerate back to version one's exact content.
    const { data: back } = await service.rpc("fn_publish_transcript_revision", {
      p_youtube_video_id: videoId,
      p_language: "en",
      p_source: "manual",
      p_full_text: "Version one.",
      p_segments: [seg(0, 0, 2, "Version one.")],
      p_content_fingerprint: "fp-1",
    });

    expect((back as { id: string }).id).toBe((v1 as { id: string }).id);
    const { data: rows } = await service.from("transcripts").select("id, is_current").eq("youtube_video_id", videoId).eq("language", "en");
    expect(rows).toHaveLength(2); // still exactly the two distinct revisions, not three
    expect(rows?.find((r) => r.id === (v1 as { id: string }).id)?.is_current).toBe(true);
  });

  it("7. two concurrent identical publish calls collapse to one reusable outcome", async () => {
    const call = () =>
      service.rpc("fn_publish_transcript_revision", {
        p_youtube_video_id: videoId,
        p_language: "en",
        p_source: "manual",
        p_full_text: "Concurrent content.",
        p_segments: [seg(0, 0, 2, "Concurrent content.")],
        p_content_fingerprint: "fp-concurrent",
      });

    const [a, b] = await Promise.all([call(), call()]);
    expect(a.error).toBeNull();
    expect(b.error).toBeNull();
    expect((a.data as { id: string }).id).toBe((b.data as { id: string }).id);

    const { data: rows } = await service.from("transcripts").select("id").eq("youtube_video_id", videoId).eq("language", "en");
    expect(rows).toHaveLength(1);
  });

  it("8. a failure during segment insertion rolls back the whole publication and leaves the prior current revision intact", async () => {
    const { data: first } = await service.rpc("fn_publish_transcript_revision", {
      p_youtube_video_id: videoId,
      p_language: "en",
      p_source: "manual",
      p_full_text: "Stays current.",
      p_segments: [seg(0, 0, 2, "Stays current.")],
      p_content_fingerprint: "fp-stable",
    });
    const firstId = (first as { id: string }).id;

    // A malformed segment (non-numeric start) makes the segment INSERT fail
    // inside the same transaction as the retire/insert-transcript steps.
    const { error } = await service.rpc("fn_publish_transcript_revision", {
      p_youtube_video_id: videoId,
      p_language: "en",
      p_source: "manual",
      p_full_text: "Broken.",
      p_segments: [{ segmentIndex: 0, start: "not-a-number", end: 2, text: "Broken.", textNormalized: "broken" }],
      p_content_fingerprint: "fp-broken",
    });
    expect(error).not.toBeNull();

    // No new transcript row from the failed attempt.
    const { data: rows } = await service.from("transcripts").select("id, is_current").eq("youtube_video_id", videoId).eq("language", "en");
    expect(rows).toHaveLength(1);
    expect(rows?.[0]).toMatchObject({ id: firstId, is_current: true });
  });

  it("9. anon and authenticated clients cannot execute the publish RPC directly; service_role can", async () => {
    const params = {
      p_youtube_video_id: videoId,
      p_language: "en",
      p_source: "manual",
      p_full_text: "Direct call attempt.",
      p_segments: [seg(0, 0, 2, "Direct call attempt.")],
      p_content_fingerprint: "fp-direct",
    };

    const { error: anonError } = await anon.rpc("fn_publish_transcript_revision", params);
    expect(anonError).not.toBeNull();

    const { error: serviceError } = await service.rpc("fn_publish_transcript_revision", params);
    expect(serviceError).toBeNull();
  });
});
