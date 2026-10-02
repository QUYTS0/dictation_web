/**
 * Practice History grouped by video (042) on real PostgreSQL, under the
 * real `authenticated` role. Upgrade path: 001–038, activated Phase 3
 * cutover, 039, 040, 041, then 042. Skipped unless LOCALDB_ADMIN_URL is set.
 */
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import {
  HAS_LOCALDB,
  applyMigration,
  asRole,
  createTestDb,
  createUser,
  errorOf,
  publishTranscript,
  rpcAs,
  runCutover,
  type PgClient,
  type TestDb,
} from "./localdb/harness";

const d = HAS_LOCALDB ? describe : describe.skip;
if (!HAS_LOCALDB) console.warn("[history-by-video] skipped — LOCALDB_ADMIN_URL not set");

type Json = Record<string, unknown> & { [k: string]: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

const A_TEXTS = ["one two", "three four", "five six", "seven eight"];
const B_TEXTS = ["alpha beta", "gamma delta", "epsilon zeta", "eta theta"];

d("History grouped by video (real PostgreSQL)", () => {
  let db: TestDb;
  let c: PgClient;

  const call = <T = Json>(u: string, sql: string, params: unknown[] = []) => rpcAs<T>(c, u, sql, params);
  const videos = (u: string, limit = 10, before: [string, string] | null = null) =>
    call(u, "select fn_history_videos($1, $2, $3)", [limit, before?.[0] ?? null, before?.[1] ?? null]);
  const card = async (u: string, v: string) => ((await videos(u, 50)).items as Json[]).find((i) => i.videoId === v);
  const rounds = (u: string, v: string) => call(u, "select fn_history_video_rounds($1)", [v]);
  const sessions = (u: string, v: string, round: string | null, limit = 10, before: [string, string] | null = null) =>
    call(u, "select fn_history_video_sessions($1, $2, $3, $4, $5, $6)", [v, round, round === null, limit, before?.[0] ?? null, before?.[1] ?? null]);
  const newRound = async (u: string, v: string) => (await call(u, "select fn_create_or_get_active_round($1)", [v])).roundId as string;
  const dictate = (u: string, r: string, v: string, seg: number, text: string) =>
    call(u, "select fn_record_dictation_attempt($1, $2, $3, $4, $5, 'relaxed', null, null, 0::smallint)", [r, v, seg, randomUUID(), text]);
  const activity = (u: string, v: string, round: string | null, start: number, end: number) =>
    call(u, "select fn_sync_study_activity('activity', $1, $2, $3, $4::jsonb, null, null, 'UTC', 0)", [
      randomUUID(),
      v,
      round,
      JSON.stringify([{ start, end }]),
    ]);
  /** Ends every open sitting so the next practice opens a NEW study session. */
  const endSessions = (u: string) => c.query("update study_sessions set ended_at = now() where user_id = $1 and ended_at is null", [u]);
  const n = async (sql: string, params: unknown[] = []) => Number((await c.query(sql, params)).rows[0].n);
  const now = () => Math.floor(Date.now() / 1000);

  beforeAll(async () => {
    db = await createTestDb("historyvideo", 38);
    c = await db.connect();
    await runCutover(c, "activated");
    for (const m of [39, 40, 41, 42]) await applyMigration(c, m);
  }, 240_000);
  afterAll(async () => {
    await c?.end();
    await db?.drop();
  });

  it("several sessions of one round → ONE card; counts include every session; coverage is the round's unique coverage", async () => {
    const u = await createUser(c);
    await publishTranscript(c, "vOne", A_TEXTS);
    const r = await newRound(u, "vOne");
    // Three sittings: sentence 0 (twice, two sittings) and sentence 1.
    for (const seg of [0, 0, 1]) {
      await activity(u, "vOne", r, now() - 120, now() - 60);
      await dictate(u, r, "vOne", seg, A_TEXTS[seg]);
      await endSessions(u);
    }
    const list = await videos(u);
    expect((list.items as Json[]).map((i) => i.videoId)).toEqual(["vOne"]);
    const cd = (list.items as Json[])[0];
    expect(cd).toMatchObject({ sessionCount: 3, roundCount: 1, inLibrary: false });
    expect(cd.round).toMatchObject({ roundId: r, roundNumber: 1, status: "active", provenance: "current" });
    // 2 unique sentences — not 3 (the per-session sum).
    expect(cd.round.progress.coveredSentences.overall).toBe(2);
    expect(Number(cd.activeSec)).toBeGreaterThan(0);

    // Sessions are on demand and paged; the card's count includes sessions beyond the first page.
    const p1 = await sessions(u, "vOne", r, 2);
    expect((p1.items as Json[]).length).toBe(2);
    expect(p1.hasMore).toBe(true);
    const last = (p1.items as Json[])[1];
    const p2 = await sessions(u, "vOne", r, 2, [last.startedAt, last.studySessionId]);
    expect((p2.items as Json[]).length).toBe(1);
    expect(p2.hasMore).toBe(false);
    const all = [...(p1.items as Json[]), ...(p2.items as Json[])];
    expect(new Set(all.map((s) => s.studySessionId)).size).toBe(3);
    expect(all.reduce((sum, s) => sum + s.newlyCoveredInRound, 0)).toBe(2); // first coverage counted once
  });

  it("several rounds → still ONE card; the active round is the default; an older round keeps its own sessions, metrics and pinned transcript", async () => {
    const u = await createUser(c);
    await publishTranscript(c, "vRounds", A_TEXTS);
    const r1 = await newRound(u, "vRounds");
    await activity(u, "vRounds", r1, now() - 300, now() - 250);
    for (let i = 0; i < 4; i++) await dictate(u, r1, "vRounds", i, A_TEXTS[i]); // completes round 1 on revision A
    await endSessions(u);
    await publishTranscript(c, "vRounds", B_TEXTS); // revision B becomes current
    const r2 = (await call(u, "select fn_restart_round($1, $2)", ["vRounds", r1])).roundId as string;
    await activity(u, "vRounds", r2, now() - 100, now() - 50);
    await dictate(u, r2, "vRounds", 0, "wrong words");

    const list = (await videos(u)).items as Json[];
    expect(list.map((i) => i.videoId)).toEqual(["vRounds"]);
    expect(list[0]).toMatchObject({ roundCount: 2, sessionCount: 2 });
    expect(list[0].round).toMatchObject({ roundId: r2, roundNumber: 2, status: "active" });

    const rs = await rounds(u, "vRounds");
    expect(rs.defaultRoundId).toBe(r2);
    expect((rs.rounds as Json[]).map((x) => [x.roundId, x.status, x.sessionCount])).toEqual([
      [r2, "active", 1],
      [r1, "completed", 1],
    ]);
    expect((rs.rounds as Json[])[1].progress.coveredSentences.overall).toBe(4);
    expect((rs.rounds as Json[])[0].progress.coveredSentences.overall).toBe(1);

    // Selecting the older round: its own sessions, its own report on its own pinned revision.
    expect(((await sessions(u, "vRounds", r1)).items as Json[]).map((s) => s.roundId)).toEqual([r1]);
    const old = await call(u, "select fn_round_report($1)", [r1]);
    expect(old.round).toMatchObject({ roundId: r1, status: "completed" });
    expect((old.sentences as Json[]).map((s) => s.text)).toEqual(A_TEXTS);
    expect(old.dictation.accuracy).toMatchObject({ correct: 4, practiced: 4 });
    const cur = await call(u, "select fn_round_report($1)", [r2]);
    // Only practiced sentences are listed — and they come from the round's OWN revision (B).
    expect((cur.sentences as Json[]).map((s) => s.text)).toEqual([B_TEXTS[0]]);
    expect(cur.dictation.accuracy).toMatchObject({ correct: 0, practiced: 1 });
  });

  it("Listening-only history: a card with no round, revision-scoped coverage and round-less sessions — reads create no round", async () => {
    const u = await createUser(c);
    const tr = await publishTranscript(c, "vListen", A_TEXTS);
    await call(u, "select fn_sync_study_activity('listening', $1, 'vListen', null, $2::jsonb, $3, 4, 'UTC', 0)", [
      randomUUID(),
      JSON.stringify([{ start: 0, end: 4 }]),
      tr,
    ]);
    const cd = await card(u, "vListen");
    expect(cd).toMatchObject({ round: null, roundCount: 0, sessionCount: 1 });
    expect(cd!.listening).toMatchObject({ transcriptId: tr, hasHistory: true, listenedThrough: false });
    expect(Number(cd!.listening.coverageRatio)).toBeCloseTo(0.5, 4);
    const rs = await rounds(u, "vListen");
    expect(rs).toMatchObject({ rounds: [], defaultRoundId: null, roundlessSessionCount: 1 });
    const ls = (await sessions(u, "vListen", null)).items as Json[];
    expect(ls).toHaveLength(1);
    expect(ls[0]).toMatchObject({ roundId: null, modesUsed: ["listening"], uniqueSentences: 0 });
    expect(await n("select count(*) n from learning_sessions where user_id = $1", [u])).toBe(0);
  });

  it("only studied videos: an added-but-unstudied video and an unpracticed round are excluded; a removed video stays and is not re-added", async () => {
    const u = await createUser(c);
    await publishTranscript(c, "vAdded", A_TEXTS);
    await call(u, "select fn_library_add_video('vAdded', true)");
    await publishTranscript(c, "vEmptyRound", A_TEXTS);
    await newRound(u, "vEmptyRound"); // created, never practiced
    await publishTranscript(c, "vRemoved", A_TEXTS);
    await call(u, "select fn_library_add_video('vRemoved', true)");
    const r = await newRound(u, "vRemoved");
    await dictate(u, r, "vRemoved", 0, "one two");
    await call(u, "select fn_library_remove_video('vRemoved')");

    const list = (await videos(u)).items as Json[];
    expect(list.map((i) => i.videoId)).toEqual(["vRemoved"]);
    expect(list[0]).toMatchObject({ inLibrary: false, sessionCount: 1, roundCount: 1 });
    await rounds(u, "vRemoved");
    await sessions(u, "vRemoved", r);
    expect(await n("select count(*) n from user_videos where user_id = $1 and youtube_video_id = 'vRemoved'", [u])).toBe(0);
  });

  it("pagination is by video: deterministic ties, no repeats or omissions however many sessions a video has", async () => {
    const u = await createUser(c);
    const vids = ["vP1", "vP2", "vP3", "vP4", "vP5"];
    for (const v of vids) {
      await publishTranscript(c, v, A_TEXTS);
      for (let k = 0; k < (v === "vP2" ? 4 : 1); k++) {
        await activity(u, v, null, now() - 200 + k, now() - 150 + k);
        await endSessions(u);
      }
    }
    // Force a tie on lastActivityAt for three videos: the video id breaks it.
    await c.query("update study_sessions set last_activity_at = '2026-09-30T10:00:00Z' where user_id = $1 and youtube_video_id in ('vP3','vP4','vP5')", [u]);
    const seen: string[] = [];
    let before: [string, string] | null = null;
    for (;;) {
      const page = await videos(u, 2, before);
      const items = page.items as Json[];
      seen.push(...items.map((i) => i.videoId as string));
      expect(page.total).toBe(5);
      if (!page.hasMore) break;
      const tail = items[items.length - 1];
      before = [tail.lastActivityAt, tail.videoId];
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(seen.slice(-3)).toEqual(["vP3", "vP4", "vP5"]); // tie broken by id, ascending
    expect((await card(u, "vP2"))!.sessionCount).toBe(4);
    expect((await errorOf(videos(u, 2, ["2026-09-30T10:00:00Z", ""]))) ?.message).toMatch(/invalid_payload/);
  });

  it("new activity moves a video to the top and updates its summary", async () => {
    const u = await createUser(c);
    for (const v of ["vOld", "vNew"]) {
      await publishTranscript(c, v, A_TEXTS);
      await activity(u, v, null, now() - 600, now() - 550);
      await endSessions(u);
    }
    await c.query("update study_sessions set last_activity_at = now() - interval '1 hour' where user_id = $1 and youtube_video_id = 'vOld'", [u]);
    expect(((await videos(u)).items as Json[]).map((i) => i.videoId)).toEqual(["vNew", "vOld"]);
    const r = await newRound(u, "vOld");
    await activity(u, "vOld", r, now() - 30, now() - 10);
    await dictate(u, r, "vOld", 0, "one two");
    const list = (await videos(u)).items as Json[];
    expect(list.map((i) => i.videoId)).toEqual(["vOld", "vNew"]);
    expect(list[0]).toMatchObject({ sessionCount: 2, roundCount: 1 });
    expect(list[0].round.progress.coveredSentences.overall).toBe(1);
  });

  it("active time unions overlapping intervals across the video's sessions", async () => {
    const u = await createUser(c);
    await publishTranscript(c, "vUnion", A_TEXTS);
    const t = now();
    await activity(u, "vUnion", null, t - 1000, t - 400);
    await endSessions(u);
    await activity(u, "vUnion", null, t - 700, t - 100);
    expect(Number((await card(u, "vUnion"))!.activeSec)).toBe(900); // not 600 + 600
  });

  it("legacy (unverified) completed rounds appear with their provenance; their unknown metrics stay unknown", async () => {
    const u = await createUser(c);
    const tr = await publishTranscript(c, "vLegacy", A_TEXTS);
    const r = (
      await c.query(
        "insert into learning_sessions (user_id, youtube_video_id, transcript_id, status, provenance, completed_at) values ($1, 'vLegacy', $2, 'completed', 'legacy_unverified', now() - interval '1 day') returning id",
        [u, tr]
      )
    ).rows[0].id;
    const cd = await card(u, "vLegacy");
    expect(cd!.round).toMatchObject({ roundId: r, status: "completed", provenance: "legacy_unverified" });
    // Answers from before sessions were tracked are counted and labeled — never put into an invented session.
    await c.query(
      "insert into attempt_logs (session_id, segment_index, expected_text, user_text, is_correct, segment_identity_provenance) values ($1, 0, 'one two', 'one two', true, 'legacy_unverified')",
      [r]
    );
    expect(((await rounds(u, "vLegacy")).rounds as Json[])[0]).toMatchObject({ sessionCount: 0, unattributedAnswers: 1, unattributedTakes: 0 });
    const rep = await call(u, "select fn_round_report($1)", [r]);
    expect(rep.historyComplete).toBe(false);
    expect(rep.dictation.firstTry.available).toBe(false);
  });

  it("accounts are isolated; reads write nothing", async () => {
    const a = await createUser(c);
    const b = await createUser(c);
    await publishTranscript(c, "vIso", A_TEXTS);
    const r = await newRound(a, "vIso");
    await activity(a, "vIso", r, now() - 60, now() - 30);
    await dictate(a, r, "vIso", 0, "one two");
    expect((await videos(b)).items).toEqual([]);
    expect((await rounds(b, "vIso")).rounds).toEqual([]);
    expect((await errorOf(sessions(b, "vIso", r)))?.message).toMatch(/round_not_found/);

    const snapshot = async () =>
      (
        await c.query(
          `select (select count(*) from learning_sessions)::int r, (select count(*) from study_sessions)::int s,
                  (select count(*) from attempt_logs)::int a, (select count(*) from user_videos)::int m,
                  (select max(updated_at) from learning_sessions) u`
        )
      ).rows[0];
    const before = await snapshot();
    await videos(a);
    await rounds(a, "vIso");
    await sessions(a, "vIso", r);
    await sessions(a, "vIso", null);
    await call(a, "select fn_round_report($1)", [r]);
    expect(await snapshot()).toEqual(before);
  });

  it("bad input is refused; permissions: authenticated only", async () => {
    const u = await createUser(c);
    expect((await errorOf(sessions(u, "vIso", null, 10, ["2026-01-01T00:00:00Z", "not-a-uuid"])))).not.toBeNull();
    expect((await errorOf(call(u, "select fn_history_video_sessions('vIso', null, false)")))?.message).toMatch(/invalid_payload/);
    expect((await errorOf(call(u, "select fn_history_video_rounds('')")))?.message).toMatch(/invalid_payload/);
    for (const sig of [
      "public.fn_history_videos(integer,timestamptz,text)",
      "public.fn_history_video_rounds(text,integer)",
      "public.fn_history_video_sessions(text,uuid,boolean,integer,timestamptz,uuid)",
    ]) {
      const r = (
        await c.query(
          `select has_function_privilege('anon', $1, 'EXECUTE') a, has_function_privilege('authenticated', $1, 'EXECUTE') u,
                  has_function_privilege('service_role', $1, 'EXECUTE') s`,
          [sig]
        )
      ).rows[0];
      expect([sig, r]).toEqual([sig, { a: false, u: true, s: false }]);
    }
    expect((await errorOf(asRole(c, "authenticated", null, () => c.query("select fn_history_videos()"))))?.message).toMatch(
      /authentication_required/
    );
  });

  it("the runbook's postflight query (PHASE6_RUNBOOK.md §7b) returns all ok", async () => {
    const md = fs.readFileSync(path.join(__dirname, "../../../supabase/PHASE6_RUNBOOK.md"), "utf8");
    const block = md.slice(md.indexOf("### 7b."));
    const start = block.indexOf("```sql") + 6;
    const sql = block.slice(start, block.indexOf("```", start)).replace(/^ {3}/gm, "");
    const rows = (await c.query(sql)).rows as Json[];
    expect(rows).toHaveLength(3);
    for (const row of rows) expect([row.sig, row.ok]).toEqual([row.sig, true]);
  });
});
