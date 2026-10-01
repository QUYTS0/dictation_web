/**
 * Phase 9 — Script Versions (041) on real PostgreSQL.
 *
 * Listing, retention classification, size estimates and per-viewer round
 * association, under the real `authenticated` role; and the deletion
 * function's v1 gate (no application role can execute it) plus its full
 * contract — exercised through a privileged (owner) connection, the only
 * way to reach it in v1 (plan §13 scenarios #46, #47, #56, #58, #59, #74).
 *
 * Upgrade path: 001–038, activated Phase 3 cutover, 039, 040, then 041.
 * Skipped unless LOCALDB_ADMIN_URL is set.
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
if (!HAS_LOCALDB) console.warn("[phase9-script-versions] skipped — LOCALDB_ADMIN_URL not set");

type Json = Record<string, unknown> & { [k: string]: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

const A_TEXTS = ["one two", "three four", "five six", "seven eight"];
const B_TEXTS = ["alpha beta", "gamma delta", "epsilon zeta", "eta theta"];

d("Phase 9 — Script Versions (real PostgreSQL)", () => {
  let db: TestDb;
  let c: PgClient;
  let c2: PgClient;
  let observer: PgClient;
  let user: string;
  let other: string;
  let admin: string;

  const versions = (u: string, v: string) => rpcAs<Json>(c, u, "select fn_transcript_versions($1)", [v]);
  const rev = async (u: string, v: string, id: string) => ((await versions(u, v)).revisions as Json[]).find((r) => r.transcriptId === id)!;
  const reasons = async (id: string) =>
    ((await c.query("select fn_transcript_retention($1) as r", [id])).rows[0].r as Json).reasons as string[];
  const n = async (sql: string, params: unknown[] = []) => Number((await c.query(sql, params)).rows[0].n);
  /** Two published revisions; returns [old (superseded), current]. */
  const twoRevisions = async (v: string): Promise<[string, string]> => {
    const a = await publishTranscript(c, v, A_TEXTS, `fpA-${v}`);
    const b = await publishTranscript(c, v, B_TEXTS, `fpB-${v}`);
    return [a, b];
  };
  const pastGrace = (id: string) => c.query("update transcripts set superseded_at = now() - interval '31 days' where id = $1", [id]);
  /** The deletion function through a PRIVILEGED connection (owner) acting as `actor` — v1 has no other path. */
  const privilegedDelete = async (conn: PgClient, actor: string, id: string, commit = true) => {
    await conn.query("begin");
    try {
      await conn.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: actor, role: "authenticated" })]);
      const r = (await conn.query("select fn_delete_transcript_revision($1) as r", [id])).rows[0].r as Json;
      if (commit) await conn.query("commit");
      return r;
    } catch (e) {
      await conn.query("rollback").catch(() => {});
      throw e;
    }
  };

  beforeAll(async () => {
    db = await createTestDb("phase9", 38);
    c = await db.connect();
    c2 = await db.connect();
    observer = await db.connect();
    await runCutover(c, "activated");
    await applyMigration(c, 39);
    await applyMigration(c, 40);
    await applyMigration(c, 41);
    user = await createUser(c);
    other = await createUser(c);
    admin = await createUser(c);
    // Only service_role may grant admin (029's self-grant trigger).
    await c.query("begin");
    await c.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
    await c.query("update users set is_admin = true where id = $1", [admin]);
    await c.query("commit");
    expect((await c.query("select is_admin from users where id = $1", [admin])).rows[0].is_admin).toBe(true);
  }, 240_000);
  afterAll(async () => {
    await c?.end();
    await c2?.end();
    await observer?.end();
    await db?.drop();
  });

  it("lists every revision newest first: current badge, sentences, honest size estimates, retention; deletion disabled", async () => {
    const [a, b] = await twoRevisions("vidList");
    const list = await versions(user, "vidList");
    expect(list).toMatchObject({ videoId: "vidList", language: "en", deletionEnabled: false, retentionGraceDays: 30 });
    expect((list.revisions as Json[]).map((r) => [r.transcriptId, r.version, r.isCurrent])).toEqual([
      [b, 2, true],
      [a, 1, false],
    ]);
    const cur = await rev(user, "vidList", b);
    expect(cur).toMatchObject({ status: "ready", source: "manual", sentenceCount: 4, yourRound: null, eligibleForRemovalBytes: 0 });
    expect(cur.retention).toMatchObject({ reasons: ["current"], protected: true, cleanupCandidate: false, eligibleAt: null });
    const s = cur.size;
    expect(s.textBytes).toBeGreaterThan(0);
    expect(s.segmentsBytes).toBeGreaterThan(0);
    expect([s.translationsBytes, s.highlightsBytes, s.filesBytes]).toEqual([0, 0, 0]);
    expect(s.totalBytes).toBe(s.textBytes + s.segmentsBytes + s.translationsBytes + s.highlightsBytes);
    expect(s.estimatedAt).toBeTruthy();

    // The superseded revision is unreferenced but inside its 30-day grace period.
    const old = await rev(user, "vidList", a);
    expect(old.retention).toMatchObject({ reasons: [], protected: false, inGracePeriod: true, cleanupCandidate: false });
    const supersededAt = Date.parse(old.supersededAt);
    expect(Date.parse(old.retention.eligibleAt) - supersededAt).toBe(30 * 86_400_000);
    expect(old.eligibleForRemovalBytes).toBe(0);

    // Past the grace period it is a cleanup CANDIDATE — still listed as a classification only.
    await pastGrace(a);
    const cand = await rev(user, "vidList", a);
    expect(cand.retention).toMatchObject({ cleanupCandidate: true, inGracePeriod: false });
    expect(cand.eligibleForRemovalBytes).toBe(cand.size.totalBytes);
  });

  it("#56: a round of ANY status protects its pinned revision, even with no attempts", async () => {
    const a = await publishTranscript(c, "vidRound", A_TEXTS, "fpA-round");
    const roundId = (await rpcAs<Json>(c, user, "select fn_create_or_get_active_round('vidRound')")).roundId as string;
    await publishTranscript(c, "vidRound", B_TEXTS, "fpB-round"); // A is superseded; the round stays pinned to A
    await pastGrace(a);
    for (const status of ["active", "completed", "abandoned"]) {
      await c.query("update learning_sessions set status = $2 where id = $1", [roundId, status]);
      expect([status, await reasons(a)]).toEqual([status, ["practice_round"]]);
    }
    expect(await n("select count(*) n from attempt_logs a join learning_sessions s on s.id = a.session_id where s.id = $1", [roundId])).toBe(0);
  });

  it("every direct and indirect reference has its own reason; processing jobs are protected", async () => {
    // attempts (transcript_id on an attempt) + legacy history
    const a1 = await publishTranscript(c, "vidAtt", A_TEXTS, "fpA-att");
    const r1 = (await rpcAs<Json>(c, user, "select fn_create_or_get_active_round('vidAtt')")).roundId as string;
    await rpcAs(c, user, "select fn_record_dictation_attempt($1, 'vidAtt', 0, $2, 'one two', 'relaxed', null, null, 0::smallint)", [r1, randomUUID()]);
    await c.query(
      "insert into attempt_logs (session_id, segment_index, expected_text, user_text, is_correct, segment_identity_provenance) values ($1, 1, 'three four', 'three', false, 'legacy_unverified')",
      [r1]
    );
    await publishTranscript(c, "vidAtt", B_TEXTS, "fpB-att");
    expect(await reasons(a1)).toEqual(["practice_round", "attempts", "legacy_history"]);

    // Listening progress, legacy listening_sessions, saved words / bookmarks (indirect)
    const [l, ] = await twoRevisions("vidLis");
    await c.query("insert into listening_progress (user_id, youtube_video_id, transcript_id, covered_intervals) values ($1, 'vidLis', $2, '[]')", [user, l]);
    expect(await reasons(l)).toEqual(["listening"]);
    const [ls] = await twoRevisions("vidLegacyLis");
    await c.query("insert into listening_sessions (user_id, youtube_video_id, transcript_id) values ($1, 'vidLegacyLis', $2)", [user, ls]);
    expect(await reasons(ls)).toEqual(["legacy_listening"]);
    const [w] = await twoRevisions("vidWords");
    await c.query(
      "insert into bookmarks (user_id, video_id, segment_index, start_sec, sentence_text) values ($1, 'vidWords', 0, 0, 'one two')",
      [other]
    );
    expect(await reasons(w)).toEqual(["saved_words"]);

    // A generation still in flight.
    await c.query("insert into videos (youtube_video_id, title) values ('vidProc', 'vidProc')");
    const p = (
      await c.query("insert into transcripts (youtube_video_id, language, source, status, version) values ('vidProc', 'en', 'ai', 'processing', 1) returning id")
    ).rows[0].id;
    expect(await reasons(p)).toEqual(["processing"]);
  });

  it("each viewer sees only their OWN round association, never another user's", async () => {
    const a = await publishTranscript(c, "vidMine", A_TEXTS, "fpA-mine");
    const roundId = (await rpcAs<Json>(c, user, "select fn_create_or_get_active_round('vidMine')")).roundId as string;
    expect((await rev(user, "vidMine", a)).yourRound).toMatchObject({ roundId, status: "active", roundNumber: 1 });
    expect((await rev(other, "vidMine", a)).yourRound).toBeNull();
    // The other viewer still sees the revision as protected (a generic reason, no counts or owners).
    expect((await rev(other, "vidMine", a)).retention.reasons).toEqual(["current", "practice_round"]);
  });

  it("size estimates refresh lazily — only when missing or older than an hour", async () => {
    const [a] = await twoRevisions("vidSize");
    const before = (await rev(user, "vidSize", a)).size;
    await c.query("insert into transcript_translations (transcript_id, segment_index, language, text_translated, source) values ($1, 0, 'vi', 'một hai', 'gemini')", [a]);
    await c.query("insert into transcript_vocab_highlights (transcript_id, segment_index, phrases) values ($1, 0, '[\"one\"]')", [a]);
    expect((await rev(user, "vidSize", a)).size).toEqual(before); // fresh estimate kept
    await c.query("update transcripts set size_estimated_at = now() - interval '2 hours' where id = $1", [a]);
    const after = (await rev(user, "vidSize", a)).size;
    expect(after.translationsBytes).toBeGreaterThan(0);
    expect(after.highlightsBytes).toBeGreaterThan(0);
    expect(after.totalBytes).toBe(after.textBytes + after.segmentsBytes + after.translationsBytes + after.highlightsBytes);
  });

  it("#74: no application role can execute deletion — not anon, not authenticated (an admin's own client), not service_role", async () => {
    const sig = "public.fn_delete_transcript_revision(uuid)";
    for (const role of ["anon", "authenticated", "service_role"]) {
      const r = (await c.query("select has_function_privilege($1, $2, 'EXECUTE') as ok", [role, sig])).rows[0];
      expect([role, r.ok]).toEqual([role, false]);
    }
    const [a] = await twoRevisions("vidGate");
    await pastGrace(a);
    for (const [role, actor] of [["authenticated", admin], ["authenticated", user], ["anon", null], ["service_role", null]] as const) {
      const err = await errorOf(asRole(c, role, actor, () => c.query("select fn_delete_transcript_revision($1)", [a])));
      expect([role, actor, err?.message]).toEqual([role, actor, expect.stringMatching(/permission denied/)]);
    }
    expect(await n("select count(*) n from transcripts where id = $1", [a])).toBe(1);

    // The listing is for signed-in users only; internal helpers for nobody.
    const matrix = async (sig2: string) =>
      (
        await c.query(
          `select has_function_privilege('anon', $1, 'EXECUTE') a, has_function_privilege('authenticated', $1, 'EXECUTE') u,
                  has_function_privilege('service_role', $1, 'EXECUTE') s`,
          [sig2]
        )
      ).rows[0];
    expect(await matrix("public.fn_transcript_versions(text,text)")).toEqual({ a: false, u: true, s: false });
    expect(await matrix("public.fn_transcript_retention(uuid)")).toEqual({ a: false, u: false, s: false });
    expect(await matrix("public.fn_refresh_transcript_size_estimate(uuid)")).toEqual({ a: false, u: false, s: false });
    expect((await errorOf(asRole(c, "authenticated", null, () => c.query("select fn_transcript_versions('vidGate')")))) ?.message).toMatch(
      /authentication_required/
    );
  });

  it("#46, #59 (future-enablement contract, privileged connection): protected revisions are refused and nothing changes", async () => {
    const a = await publishTranscript(c, "vidDel", A_TEXTS, "fpA-del");
    const roundId = (await rpcAs<Json>(c, user, "select fn_create_or_get_active_round('vidDel')")).roundId as string;
    await c.query("update learning_sessions set status = 'completed' where id = $1", [roundId]);
    const b = await publishTranscript(c, "vidDel", B_TEXTS, "fpB-del");
    await pastGrace(a);
    const snapshot = async () =>
      (
        await c.query(
          `select (select count(*) from transcript_segments where transcript_id = $1)::int segs,
                  (select transcript_id from learning_sessions where id = $2) pinned,
                  (select count(*) from transcripts where id = $1)::int rows`,
          [a, roundId]
        )
      ).rows[0];
    const before = await snapshot();

    expect((await errorOf(privilegedDelete(c, user, a)))?.message).toMatch(/admin_required/);
    expect((await errorOf(privilegedDelete(c, admin, a)))?.message).toMatch(/revision_now_referenced/); // completed round
    expect((await errorOf(privilegedDelete(c, admin, b)))?.message).toMatch(/revision_now_referenced/); // current
    expect(await snapshot()).toEqual(before);
    expect(before).toMatchObject({ segs: 4, pinned: a, rows: 1 });

    // Grace period and saved words refuse too.
    const [g] = await twoRevisions("vidGrace");
    expect((await errorOf(privilegedDelete(c, admin, g)))?.message).toMatch(/revision_in_grace_period/);
    const [sw] = await twoRevisions("vidSaved");
    await pastGrace(sw);
    await c.query(
      "insert into vocabulary_items (user_id, video_id, segment_index, term, normalized_term, sentence_context) values ($1, 'vidSaved', 0, 'one', 'one', 'one two')",
      [other]
    );
    expect((await errorOf(privilegedDelete(c, admin, sw)))?.message).toMatch(/revision_protected_saved_words/);
  });

  it("an eligible revision is deleted with its segments, translations and highlights (privileged connection only)", async () => {
    const [a, b] = await twoRevisions("vidGone");
    await c.query("insert into transcript_translations (transcript_id, segment_index, language, text_translated, source) values ($1, 0, 'vi', 'x', 'gemini')", [a]);
    await pastGrace(a);
    expect(await privilegedDelete(c, admin, a)).toMatchObject({ deleted: true, transcriptId: a, version: 1 });
    expect(await n("select count(*) n from transcripts where id = $1", [a])).toBe(0);
    expect(await n("select count(*) n from transcript_segments where transcript_id = $1", [a])).toBe(0);
    expect(await n("select count(*) n from transcript_translations where transcript_id = $1", [a])).toBe(0);
    expect(((await versions(user, "vidGone")).revisions as Json[]).map((r) => r.transcriptId)).toEqual([b]);
  });

  it("#47: a reference created after the dialog's read refuses the deletion; one racing it waits and then fails cleanly", async () => {
    // Created between the listing (candidate) and the delete request.
    const [a] = await twoRevisions("vidRef");
    await pastGrace(a);
    expect((await rev(user, "vidRef", a)).retention.cleanupCandidate).toBe(true);
    await c.query("insert into listening_progress (user_id, youtube_video_id, transcript_id, covered_intervals) values ($1, 'vidRef', $2, '[]')", [user, a]);
    expect((await errorOf(privilegedDelete(c, admin, a)))?.message).toMatch(/revision_now_referenced/);

    // Racing: the deletion holds the row lock (uncommitted); a new reference
    // waits on it, and after the delete commits the reference is refused by
    // its foreign key — nothing ever points at a deleted revision.
    const [x] = await twoRevisions("vidRace");
    await pastGrace(x);
    await privilegedDelete(c2, admin, x, false);
    const pid = await backendPid(c);
    const insert = c.query("insert into listening_progress (user_id, youtube_video_id, transcript_id, covered_intervals) values ($1, 'vidRace', $2, '[]')", [user, x]);
    await waitUntilBlocked(observer, pid);
    await c2.query("commit");
    expect((await errorOf(insert))?.code).toBe("23503");
    expect(await n("select count(*) n from listening_progress where transcript_id = $1", [x])).toBe(0);
  });

  it("#58: publication re-promoting a revision racing its deletion never leaves the video without a current revision", async () => {
    // Deletion first: publication's row lock waits, finds the row gone, publishes fresh content.
    const [x, y] = await twoRevisions("vidPub1");
    await pastGrace(x);
    await privilegedDelete(c2, admin, x, false);
    const pid = await backendPid(c);
    const publish = publishTranscript(c, "vidPub1", A_TEXTS, "fpA-vidPub1"); // same fingerprint as x
    await waitUntilBlocked(observer, pid);
    await c2.query("commit");
    const z = await publish;
    expect([z === x, z === y]).toEqual([false, false]);
    expect((await c.query("select id from transcripts where youtube_video_id = 'vidPub1' and is_current")).rows.map((r) => r.id)).toEqual([z]);
    expect(await n("select count(*) n from transcript_segments where transcript_id = $1", [z])).toBe(4);

    // Publication first: the deletion waits, then sees the revision current again and refuses.
    const [p, ] = await twoRevisions("vidPub2");
    await pastGrace(p);
    await c2.query("begin");
    await c2.query("select fn_publish_transcript_revision('vidPub2', 'en', 'manual', $1, $2::jsonb, 'fpA-vidPub2')", [
      A_TEXTS.join(" "),
      JSON.stringify(A_TEXTS.map((text, i) => ({ segmentIndex: i, start: i * 2, end: i * 2 + 2, text, textNormalized: text }))),
    ]);
    const pid2 = await backendPid(c);
    const del = privilegedDelete(c, admin, p);
    await waitUntilBlocked(observer, pid2);
    await c2.query("commit");
    expect((await errorOf(del))?.message).toMatch(/revision_now_referenced/);
    expect((await c.query("select id from transcripts where youtube_video_id = 'vidPub2' and is_current")).rows.map((r) => r.id)).toEqual([p]);
  });

  it("removing a video from a personal Library never touches the shared transcript", async () => {
    const [a, b] = await twoRevisions("vidShared9");
    await rpcAs(c, user, "select fn_library_add_video('vidShared9', true)");
    await rpcAs(c, user, "select fn_library_remove_video('vidShared9')");
    expect(await n("select count(*) n from transcripts where id in ($1, $2)", [a, b])).toBe(2);
  });

  it("the runbook's postflight queries (PHASE9_RUNBOOK.md §4) return all ok", async () => {
    const md = fs.readFileSync(path.join(__dirname, "../../../supabase/PHASE9_RUNBOOK.md"), "utf8");
    const block = md.slice(md.indexOf("3. **Postflight"));
    const sql = block.slice(block.indexOf("```sql") + 6, block.indexOf("```", block.indexOf("```sql") + 6)).replace(/^ {3}/gm, "");
    const res = (await c.query(sql)) as unknown as Array<{ rows: Json[] }>;
    const rows = res.flatMap((r) => r.rows);
    expect(rows).toHaveLength(5);
    for (const row of rows) expect([row, row.ok]).toEqual([row, true]);
  });
});
