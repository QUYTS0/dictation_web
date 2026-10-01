/**
 * Phase 6 on real PostgreSQL: Library membership, the Library/Dashboard/
 * History read models and the whole-round report (040), executed under the
 * real `authenticated` role with JWT claims the way PostgREST runs them.
 *
 * Starts from the production state — 001–038, legacy history seeded BEFORE
 * the Phase 3 cutover (so the real backfill tags it), activated cutover,
 * 039 — then applies 040. Skipped unless LOCALDB_ADMIN_URL is set.
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
if (!HAS_LOCALDB) console.warn("[phase6-library] skipped — LOCALDB_ADMIN_URL not set");

type Json = Record<string, unknown> & { [k: string]: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

const TEXTS = ["one two", "three four", "five six", "seven eight"];

d("Phase 6 — Library, Dashboard, History and round reports (real PostgreSQL)", () => {
  let db: TestDb;
  let c: PgClient;
  let userA: string;
  let userB: string;
  let userC: string;
  const legacy: { round?: string; video: string } = { video: "vidLegacy" };

  const call = <T = Json>(user: string, sql: string, params: unknown[] = []) => rpcAs<T>(c, user, sql, params);
  const add = (u: string, v: string, explicit = true) => call(u, "select fn_library_add_video($1, $2)", [v, explicit]);
  const remove = (u: string, v: string) => call(u, "select fn_library_remove_video($1)", [v]);
  const lib = (u: string, filter = "all", limit = 50, offset = 0) =>
    call(u, "select fn_video_library($1, $2, $3)", [limit, offset, filter]);
  const card = async (u: string, v: string) => ((await lib(u)).items as Json[]).find((i) => i.videoId === v);
  const round = async (u: string, v: string) => (await call(u, "select fn_create_or_get_active_round($1)", [v])).roundId as string;
  const dictate = (u: string, r: string, v: string, seg: number, text: string, hint: number | null = 0, id = randomUUID()) =>
    call(u, "select fn_record_dictation_attempt($1, $2, $3, $4, $5, 'relaxed', null, null, $6::smallint)", [r, v, seg, id, text, hint]);
  const shadow = (u: string, r: string, v: string, seg: number, dur = 2) =>
    call(u, "select fn_record_shadowing_attempt($1, $2, $3, $4, $5)", [r, v, seg, randomUUID(), dur]);
  const sync = (u: string, kind: "listening" | "activity", v: string, roundId: string | null, intervals: unknown, tr: string | null = null, pos: number | null = null) =>
    call(u, "select fn_sync_study_activity($1, $2, $3, $4, $5::jsonb, $6, $7, 'UTC', 0)", [kind, randomUUID(), v, roundId, JSON.stringify(intervals), tr, pos]);
  const report = (u: string, r: string) => call(u, "select fn_round_report($1)", [r]);
  const history = (u: string, limit = 20, before: [string, string] | null = null, video: string | null = null) =>
    call(u, "select fn_history_sessions($1, $2, $3, $4)", [limit, before?.[0] ?? null, before?.[1] ?? null, video]);
  const dashboard = (u: string) => call(u, "select fn_dashboard_summary()");
  const endOpenSessions = (u: string) => c.query("update study_sessions set ended_at = now() where user_id = $1 and ended_at is null", [u]);
  const count = async (sql: string, params: unknown[] = []) => Number((await c.query(sql, params)).rows[0].n);
  const nowSec = () => Date.now() / 1000;

  beforeAll(async () => {
    db = await createTestDb("phase6", 38);
    c = await db.connect();
    userA = await createUser(c);
    userB = await createUser(c);
    userC = await createUser(c);
    // Pre-cutover (legacy) history: a client-completed round with answers.
    const trLegacy = await publishTranscript(c, legacy.video, TEXTS);
    legacy.round = (
      await c.query(
        `insert into learning_sessions (user_id, youtube_video_id, transcript_id, status, accuracy, total_attempts)
         values ($1, $2, $3, 'completed', 50, 2) returning id`,
        [userA, legacy.video, trLegacy]
      )
    ).rows[0].id;
    await c.query(
      `insert into attempt_logs (session_id, segment_index, expected_text, user_text, is_correct, created_at)
       values ($1, 0, 'one two', 'one two', true, now() - interval '2 days'),
              ($1, 1, 'three four', 'three', false, now() - interval '2 days' + interval '1 minute')`,
      [legacy.round]
    );
    await runCutover(c, "activated");
    await applyMigration(c, 39);
    await applyMigration(c, 40);
  }, 240_000);
  afterAll(async () => {
    await c?.end();
    await db?.drop();
  });

  // ------------------------------------------------------------ membership
  it("reconciliation adds membership from real activity once, never touches existing rows, and is re-runnable", async () => {
    expect(await count("select fn_phase6_membership_gap() as n")).toBeGreaterThanOrEqual(1);
    const first = (await c.query("select fn_phase6_reconcile_membership() as r")).rows[0].r;
    expect(first.inserted).toBeGreaterThanOrEqual(1);
    expect(await count("select fn_phase6_membership_gap() as n")).toBe(0);
    const again = (await c.query("select fn_phase6_reconcile_membership() as r")).rows[0].r;
    expect(again.inserted).toBe(0);
    // Not callable by any application role.
    for (const role of ["authenticated", "anon", "service_role"] as const) {
      const err = await errorOf(asRole(c, role, role === "anon" ? null : userA, () => c.query("select fn_phase6_reconcile_membership()")));
      expect(err?.message).toMatch(/permission denied/);
    }
  });

  it("1–2: an added, unstarted video appears once; repeated Add keeps added_at and never touches rounds or progress", async () => {
    await publishTranscript(c, "vidNew", TEXTS);
    const a1 = await add(userA, "vidNew");
    expect(a1).toMatchObject({ added: true });
    let cd = await card(userA, "vidNew");
    expect(cd).toMatchObject({ state: "not_started", round: null, hasCompletedRound: false });
    expect(cd!.listening).toMatchObject({ hasHistory: false, coverageRatio: null });

    const r = await round(userA, "vidNew");
    await dictate(userA, r, "vidNew", 0, "one two");
    const a2 = await add(userA, "vidNew");
    expect(a2).toMatchObject({ added: false, addedAt: a1.addedAt });
    expect(await add(userA, "vidNew", false)).toMatchObject({ added: false, addedAt: a1.addedAt });
    // A video that was never removed is added implicitly (first round / Listening).
    await publishTranscript(c, "vidImplicit", TEXTS);
    expect(await add(userA, "vidImplicit", false)).toMatchObject({ added: true });
    const items = (await lib(userA)).items as Json[];
    expect(items.filter((i) => i.videoId === "vidNew")).toHaveLength(1);
    cd = items.find((i) => i.videoId === "vidNew")!;
    expect(cd.addedAt).toBe(a1.addedAt);
    expect(cd).toMatchObject({ state: "in_progress" });
    expect(cd.round).toMatchObject({ roundId: r, status: "active" });
    expect(cd.round.progress.coveredSentences.overall).toBe(1);
    expect(await count("select count(*) n from learning_sessions where user_id = $1 and youtube_video_id = 'vidNew'", [userA])).toBe(1);
  });

  it("3: a Listening-only video appears without a practice round, with coverage of the current revision", async () => {
    const tr = await publishTranscript(c, "vidListen", TEXTS); // sentences at 0–8 s
    await add(userA, "vidListen");
    await sync(userA, "listening", "vidListen", null, [{ start: 0, end: 4 }], tr, 4);
    const cd = await card(userA, "vidListen");
    expect(cd).toMatchObject({ state: "listening", round: null });
    expect(cd!.listening).toMatchObject({ transcriptId: tr, hasHistory: true, historyOnOtherRevision: false, listenedThrough: false });
    expect(Number(cd!.listening.coverageRatio)).toBeCloseTo(0.5, 4);
    expect(Number(cd!.listening.lastPositionSec)).toBe(4);
    expect(await count("select count(*) n from learning_sessions where user_id = $1 and youtube_video_id = 'vidListen'", [userA])).toBe(0);
    const cont = (await lib(userA, "continue")).items as Json[];
    expect(cont.map((i) => i.videoId)).toContain("vidListen");
  });

  it("4, 13, 14, 21: a completed round and a newer active round coexist; reads never create rounds; old results survive Restart", async () => {
    await publishTranscript(c, "vidDone", TEXTS);
    await add(userA, "vidDone");
    const r1 = await round(userA, "vidDone");
    for (let i = 0; i < 4; i++) await dictate(userA, r1, "vidDone", i, TEXTS[i]);
    const roundsBefore = await count("select count(*) n from learning_sessions where user_id = $1", [userA]);
    let cd = await card(userA, "vidDone");
    expect(cd).toMatchObject({ state: "completed", hasCompletedRound: true, completedRoundCount: 1 });
    expect(cd!.round).toMatchObject({ roundId: r1, status: "completed" });
    await report(userA, r1);
    await dashboard(userA);
    await history(userA);
    expect(await count("select count(*) n from learning_sessions where user_id = $1", [userA])).toBe(roundsBefore);

    const before = await report(userA, r1);
    const restarted = await call(userA, "select fn_restart_round($1, $2)", ["vidDone", null]);
    const r2 = restarted.roundId as string;
    expect(r2).not.toBe(r1);
    await dictate(userA, r2, "vidDone", 0, "wrong answer");
    cd = await card(userA, "vidDone");
    expect(cd).toMatchObject({ state: "in_progress", hasCompletedRound: true, completedRoundCount: 1 });
    expect(cd!.round).toMatchObject({ roundId: r2, status: "active", roundNumber: 2 });

    const after = await report(userA, r1);
    expect(after.round).toMatchObject({ roundId: r1, status: "completed", roundNumber: 1 });
    expect(after.dictation).toEqual(before.dictation);
    expect(after.sentences).toEqual(before.sentences);
    const newReport = await report(userA, r2);
    expect(newReport.round).toMatchObject({ roundId: r2, roundNumber: 2 });
    expect(newReport.dictation.submissions).toBe(1);
    expect(newReport.dictation.practicedSentences).toBe(1);

    const dash = await dashboard(userA);
    const inCompleted = Number(dash.completedVideos);
    const inProgress = Number(dash.inProgressVideos);
    expect(inCompleted).toBeGreaterThanOrEqual(1);
    expect(inProgress).toBeGreaterThanOrEqual(1); // vidDone counts in both
    const completed = (await lib(userA, "completed")).items as Json[];
    const progressing = (await lib(userA, "in_progress")).items as Json[];
    expect(completed.map((i) => i.videoId)).toContain("vidDone");
    expect(progressing.map((i) => i.videoId)).toContain("vidDone");
  });

  it("5: legacy completion stays separate from verified completion (and a verified video is never counted again as earlier)", async () => {
    const dash = await dashboard(userA);
    expect(Number(dash.legacyCompletedVideos)).toBe(1);
    const cd = await card(userA, legacy.video);
    expect(cd).toMatchObject({ state: "completed", hasCompletedRound: false, hasLegacyCompletion: true });
    expect(cd!.round).toMatchObject({ provenance: "legacy_unverified", status: "completed" });

    // Complete the legacy video again under the verified rule: it is now a
    // verified completion and no longer an "earlier" one.
    const r = await round(userA, legacy.video);
    for (let i = 0; i < 4; i++) await dictate(userA, r, legacy.video, i, TEXTS[i]);
    const dash2 = await dashboard(userA);
    expect(Number(dash2.legacyCompletedVideos)).toBe(0);
    expect(Number(dash2.completedVideos)).toBe(Number(dash.completedVideos) + 1);
  });

  it("20: a legacy round's report marks first-try and best streak unavailable instead of guessing", async () => {
    const rep = await report(userA, legacy.round!);
    expect(rep.historyComplete).toBe(false);
    expect(rep.round.provenance).toBe("legacy_unverified");
    expect(rep.dictation.firstTry).toEqual({ available: false, correct: null, correctWithHint: null, correctHintUnknown: null });
    expect(rep.dictation.bestStreak).toBeNull();
    for (const s of rep.sentences as Json[]) {
      expect(s.category).not.toBe("first_try");
      if (s.dictation) expect(s.dictation.first).toBeNull();
    }
    // What IS recorded is still reported: the latest answers.
    expect(rep.dictation.practicedSentences).toBe(2);
    expect(rep.dictation.needsReview).toBe(1);
    // Latest answers from the unverified history are not blended into accuracy.
    expect(rep.dictation.accuracy).toMatchObject({ practiced: 0, excludedUnverified: 2 });
  });

  it("6, 26: removal deletes only the caller's membership; history survives; reads and reconciliation don't undo it; other users unaffected", async () => {
    await add(userB, "vidDone"); // B's own membership of the same video
    const r1 = ((await card(userA, "vidDone"))!.round as Json).roundId as string;
    const attemptsBefore = await count("select count(*) n from attempt_logs a join learning_sessions r on r.id = a.session_id where r.user_id = $1", [userA]);

    expect(await remove(userA, "vidDone")).toMatchObject({ removed: true });
    expect(await card(userA, "vidDone")).toBeUndefined();
    expect(await card(userA, "vidDone")).toBeUndefined(); // a read never re-adds it
    const rec = (await c.query("select fn_phase6_reconcile_membership() as r")).rows[0].r;
    expect(rec.skippedRemoved).toBeGreaterThanOrEqual(1);
    expect(await card(userA, "vidDone")).toBeUndefined();
    // Implicit membership writes (a first round, Listening) never undo a removal.
    expect(await add(userA, "vidDone", false)).toMatchObject({ added: false, suppressedByRemoval: true });
    expect(await card(userA, "vidDone")).toBeUndefined();

    expect(await count("select count(*) n from attempt_logs a join learning_sessions r on r.id = a.session_id where r.user_id = $1", [userA])).toBe(attemptsBefore);
    expect((await report(userA, r1)).round.roundId).toBe(r1);
    expect(await card(userB, "vidDone")).toBeDefined();
    expect(await remove(userA, "vidDone")).toMatchObject({ removed: false }); // idempotent

    // Cross-user: B can't read A's round, and B's removals only affect B.
    expect((await errorOf(report(userB, r1)))?.message).toMatch(/round_not_found/);
    await remove(userB, "vidListen");
    expect(await card(userA, "vidListen")).toBeDefined();
    expect(((await lib(userB)).items as Json[]).map((i) => i.videoId)).toEqual(["vidDone"]);

    // An explicit re-add brings the card back with its history.
    await add(userA, "vidDone");
    expect(await card(userA, "vidDone")).toMatchObject({ hasCompletedRound: true });
  });

  it("7: coverage is never replaced with accuracy (wrong answers still cover sentences)", async () => {
    await publishTranscript(c, "vidCov", TEXTS);
    await add(userA, "vidCov");
    const r = await round(userA, "vidCov");
    await dictate(userA, r, "vidCov", 0, "totally wrong");
    await dictate(userA, r, "vidCov", 1, "also wrong");
    const p = ((await card(userA, "vidCov"))!.round as Json).progress;
    expect(Number(p.coverage.overall)).toBeCloseTo(0.5, 4);
    expect(p.sentenceAccuracy).toMatchObject({ correct: 0, practiced: 2 });
  });

  it("8: overlapping activity in different sessions counts once account-wide", async () => {
    const t = Math.floor(nowSec());
    await sync(userC, "activity", "vidO1", null, [{ start: t - 1000, end: t - 400 }]);
    await sync(userC, "activity", "vidO2", null, [{ start: t - 700, end: t - 100 }]);
    expect(await count("select count(*) n from study_sessions where user_id = $1", [userC])).toBe(2);
    const dash = await dashboard(userC);
    expect(Number(dash.activeTime.activeSec)).toBe(900); // not 600 + 600
    expect(Number(dash.activeTime.sessionCount)).toBe(2);
    // The batches carried 'UTC', so their local dates are UTC dates.
    const days = await call<{ days: string[]; utcFallbackDays: string[] }>(userC, "select fn_activity_days()");
    expect(days.days).toContain(new Date(t * 1000).toISOString().slice(0, 10));
    expect(days.utcFallbackDays).toEqual([]);
  });

  it("12: Listening under revision A is not attached to revision B; the round keeps its pinned revision", async () => {
    const trA = await publishTranscript(c, "vidRev", TEXTS);
    await add(userA, "vidRev");
    const r = await round(userA, "vidRev");
    await dictate(userA, r, "vidRev", 0, "one two");
    await sync(userA, "listening", "vidRev", r, [{ start: 0, end: 6 }], trA, 6);
    const trB = await publishTranscript(c, "vidRev", ["new one", "new two", "new three"]);
    expect(trB).not.toBe(trA);

    const cd = await card(userA, "vidRev");
    expect(cd!.listening).toMatchObject({ transcriptId: trB, coverageRatio: null, lastPositionSec: null, hasHistory: true, historyOnOtherRevision: true });
    expect(cd!.round).toMatchObject({ roundId: r, transcriptId: trA });
    expect((await report(userA, r)).round.transcriptId).toBe(trA);
    // Another account's Listening never shows up here.
    expect((await card(userB, "vidRev"))).toBeUndefined();

    // Listening-only video whose only history is under the old revision.
    const trX = await publishTranscript(c, "vidRevL", TEXTS);
    await add(userA, "vidRevL");
    await sync(userA, "listening", "vidRevL", null, [{ start: 0, end: 2 }], trX, 2);
    await publishTranscript(c, "vidRevL", ["other text"]);
    expect(await card(userA, "vidRevL")).toMatchObject({ state: "listening_prior_revision" });
  });

  it("16–18: whole-round metrics across study sessions — first try survives corrections and retries; categories are consistent", async () => {
    await publishTranscript(c, "vidRep", TEXTS);
    await add(userA, "vidRep");
    const r = await round(userA, "vidRep");
    // Sitting 1
    await dictate(userA, r, "vidRep", 0, "one", 0); // wrong
    await dictate(userA, r, "vidRep", 0, "one two", 1); // corrected (hint)
    await dictate(userA, r, "vidRep", 1, "three four", 2); // first try, with hint
    await endOpenSessions(userA); // the next answer starts a new sitting
    // Sitting 2 (e.g. another day)
    await dictate(userA, r, "vidRep", 2, "five", 0);
    await dictate(userA, r, "vidRep", 2, "six", 0);
    const retryId = randomUUID();
    await dictate(userA, r, "vidRep", 3, "seven eight", 0, retryId);
    const retry = await dictate(userA, r, "vidRep", 3, "seven eight", 0, retryId); // transport retry
    expect(retry.wasInserted).toBe(false);

    const rep = await report(userA, r);
    expect(rep.historyComplete).toBe(true);
    expect(rep.dictation).toMatchObject({
      practicedSentences: 4,
      latestCorrect: 3,
      needsReview: 1,
      corrected: 1,
      submissions: 6, // the retry is the same stored submission
      invalidSubmissions: 0,
      bestStreak: 2, // ✓(s0) ✓(s1) — then ✗ ✗ ✓
      firstTry: { available: true, correct: 2, correctWithHint: 1, correctHintUnknown: 0 },
    });
    expect(rep.dictation.accuracy).toMatchObject({ correct: 3, practiced: 4 });
    const cats = Object.fromEntries((rep.sentences as Json[]).map((s) => [s.segmentIndex, s.category]));
    expect(cats).toEqual({ 0: "corrected", 1: "first_try", 2: "needs_review", 3: "first_try" });
    const s0 = (rep.sentences as Json[])[0];
    expect(s0.dictation.first).toMatchObject({ correct: false, userText: "one", hintLevel: 0 });
    expect(s0.dictation.latest).toMatchObject({ correct: true, userText: "one two" });
    expect(rep.activity.sessionCount).toBe(2);
    expect(rep.progress.coveredSentences.overall).toBe(4);

    // The same numbers on every read ("after reload").
    expect(await report(userA, r)).toEqual(rep);
    expect(await call(userA, "select fn_my_round_progress($1)", [r])).toEqual(rep.progress);
    expect((await errorOf(call(userB, "select fn_my_round_progress($1)", [r])))?.message).toMatch(/round_not_found/);

    // History: one entry per sitting, newest first, first coverage attributed once.
    const h = await history(userA, 20, null, "vidRep");
    const items = h.items as Json[];
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ dictationSentences: 2, newlyCoveredInRound: 2, roundId: r, modesUsed: ["dictation"] });
    expect(items[1]).toMatchObject({ dictationSentences: 2, newlyCoveredInRound: 2 });
    expect(items[0].dictationLatest).toMatchObject({ correct: 1, practiced: 2 });
    expect(Number(items[0].elapsedSpanSec)).toBeGreaterThanOrEqual(0);
    // Keyset pagination: deterministic, no overlap.
    const p1 = await history(userA, 1, null, "vidRep");
    expect(p1.hasMore).toBe(true);
    const first = (p1.items as Json[])[0];
    const p2 = await history(userA, 1, [first.startedAt, first.studySessionId], "vidRep");
    expect((p2.items as Json[])[0].studySessionId).toBe(items[1].studySessionId);
    expect(p2.hasMore).toBe(false);
  });

  it("19, 22: mixed-mode completion uses Dictation-practiced denominators; Azure aggregates never fall back to Word Match", async () => {
    await publishTranscript(c, "vidMix", TEXTS);
    await add(userA, "vidMix");
    const r = await round(userA, "vidMix");
    await dictate(userA, r, "vidMix", 0, "one two");
    await dictate(userA, r, "vidMix", 1, "wrong");
    const s2 = await shadow(userA, r, "vidMix", 2);
    const s3 = await shadow(userA, r, "vidMix", 3);
    expect(s3.roundStatus).toBe("completed");
    // Word Match saved for sentence 2 only; Azure for sentence 3 only.
    await c.query("update shadowing_attempts set word_match_status = 'completed', word_match_accuracy = 90, word_match_completeness = 80 where id = $1", [s2.attemptId]);
    await c.query(
      `update shadowing_attempts set azure_eval_status = 'completed', azure_pronunciation_score = 70, azure_accuracy_score = 60,
         azure_fluency_score = 50, azure_completeness_score = 40, azure_prosody_score = null where id = $1`,
      [s3.attemptId]
    );

    const rep = await report(userA, r);
    expect(rep.round.status).toBe("completed");
    expect(rep.progress.coveredSentences).toEqual({ dictation: 2, shadowing: 2, overall: 4 });
    expect(rep.dictation).toMatchObject({ practicedSentences: 2, latestCorrect: 1, firstTry: { available: true, correct: 1 } });
    expect(rep.dictation.accuracy).toMatchObject({ correct: 1, practiced: 2 }); // not ÷ 4
    expect(rep.shadowing.azure).toMatchObject({ evaluatedSentences: 1, pronunciation: 70, accuracy: 60, prosody: null });
    expect(rep.shadowing.wordMatch).toMatchObject({ evaluatedSentences: 1, accuracy: 90 });
    const cats = Object.fromEntries((rep.sentences as Json[]).map((s) => [s.segmentIndex, s.category]));
    expect(cats).toEqual({ 0: "first_try", 1: "needs_review", 2: "shadowing_only", 3: "shadowing_only" });

    // A Word-Match-only account has no Azure average at all (missing ≠ 0).
    await publishTranscript(c, "vidWm", TEXTS);
    const rb = await round(userB, "vidWm");
    const t = await shadow(userB, rb, "vidWm", 0);
    await c.query("update shadowing_attempts set word_match_status = 'completed', word_match_accuracy = 75, word_match_completeness = 75 where id = $1", [t.attemptId]);
    const dashB = await dashboard(userB);
    expect(dashB.shadowing.azure).toMatchObject({ evaluatedSentences: 0, pronunciation: null });
    expect(dashB.shadowing.wordMatch).toMatchObject({ evaluatedSentences: 1, accuracy: 75 });
    expect(dashB.sentenceAccuracy).toMatchObject({ correct: 0, practiced: 0 });
  });

  it("dashboard sentence accuracy aggregates latest answers per (round, sentence) — never an average of percentages", async () => {
    await publishTranscript(c, "vidAcc", TEXTS);
    const u = await createUser(c);
    // Round 1: 1 of 1 correct (100%). Round 2: 1 of 3 correct (33%).
    const r1 = await round(u, "vidAcc");
    await dictate(u, r1, "vidAcc", 0, "one two");
    const r2 = (await call(u, "select fn_restart_round($1, $2)", ["vidAcc", r1])).roundId as string;
    await dictate(u, r2, "vidAcc", 0, "one two");
    await dictate(u, r2, "vidAcc", 1, "x");
    await dictate(u, r2, "vidAcc", 2, "y");
    await dictate(u, r2, "vidAcc", 2, "five six"); // latest per sentence wins
    const dash = await dashboard(u);
    expect(dash.sentenceAccuracy).toEqual({ correct: 3, practiced: 4, excludedUnverified: 0 }); // 75%, not (100+67)/2
  });

  it("last mode is a convenience write: no round, no study session, no activity", async () => {
    const u = await createUser(c);
    await publishTranscript(c, "vidMode", TEXTS);
    expect(await call(u, "select fn_set_video_last_mode($1, $2)", ["vidMode", "shadowing"])).toMatchObject({ lastMode: "shadowing", added: true });
    expect(await card(u, "vidMode")).toMatchObject({ lastMode: "shadowing", state: "not_started" });
    await call(u, "select fn_set_video_last_mode($1, $2)", ["vidMode", "listening"]);
    expect(await card(u, "vidMode")).toMatchObject({ lastMode: "listening" });
    expect(await count("select count(*) n from learning_sessions where user_id = $1", [u])).toBe(0);
    expect(await count("select count(*) n from study_sessions where user_id = $1", [u])).toBe(0);
    expect((await errorOf(call(u, "select fn_set_video_last_mode($1, $2)", ["vidMode", "karaoke"])))?.message).toMatch(/invalid_payload/);
  });

  it("history labels practice that no study session owns (legacy rounds, unattributed answers)", async () => {
    const h = await history(userA);
    expect(h.unattributed).toMatchObject({ legacyRounds: 1 });
    expect(Number(h.unattributed.unattributedAnswers)).toBeGreaterThanOrEqual(2); // the legacy answers
    const next = await history(userA, 1, [(h.items as Json[])[0].startedAt, (h.items as Json[])[0].studySessionId]);
    expect(next.unattributed).toBeNull(); // only on the first page
  });

  it("pagination and filters are deterministic; bad input is refused", async () => {
    const all = (await lib(userA)).items as Json[];
    const paged: Json[] = [];
    for (let off = 0; off < all.length; off += 2) paged.push(...((await lib(userA, "all", 2, off)).items as Json[]));
    expect(paged.map((i) => i.videoId)).toEqual(all.map((i) => i.videoId));
    const times = all.map((i) => Date.parse(i.lastActivityAt as string));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect((await lib(userA, "all", 1000)).limit).toBe(50);
    expect((await errorOf(lib(userA, "everything")))?.message).toMatch(/invalid_payload/);
    expect((await errorOf(history(userA, 10, null, "")))?.message).toMatch(/invalid_payload/);
    expect((await errorOf(call(userA, "select fn_history_sessions(10, now(), null, null)")))?.message).toMatch(/invalid_payload/);
  });

  it("permissions: authenticated only; anon and service_role refused; tombstones owner-read-only", async () => {
    const fns = [
      "fn_library_add_video(text,boolean)",
      "fn_library_remove_video(text)",
      "fn_set_video_last_mode(text,text)",
      "fn_video_last_mode(text)",
      "fn_video_library(integer,integer,text)",
      "fn_dashboard_summary()",
      "fn_activity_days()",
      "fn_history_sessions(integer,timestamptz,uuid,text)",
      "fn_round_report(uuid)",
      "fn_my_round_progress(uuid)",
    ];
    for (const f of fns) {
      const r = (
        await c.query(
          `select has_function_privilege('authenticated', $1, 'EXECUTE') a, has_function_privilege('anon', $1, 'EXECUTE') n,
                  has_function_privilege('service_role', $1, 'EXECUTE') s`,
          [`public.${f}`]
        )
      ).rows[0];
      expect([f, r.a, r.n, r.s]).toEqual([f, true, false, false]);
    }
    for (const f of [
      "fn_shadowing_summary(uuid,uuid)",
      "fn_dictation_accuracy_summary(uuid,uuid)",
      "fn_activity_union(uuid,uuid,uuid)",
      "fn_lock_library_entry(uuid,text)",
      "fn_valid_time_zone(text)",
      "fn_local_activity_dates(jsonb,text)",
      "fn_apply_study_flush(uuid,text,uuid,uuid,text,jsonb,uuid,numeric,text,boolean)",
    ]) {
      const r = (await c.query(`select has_function_privilege('authenticated', $1, 'EXECUTE') a`, [`public.${f}`])).rows[0];
      expect([f, r.a]).toEqual([f, false]);
    }
    const anonErr = await errorOf(asRole(c, "anon", null, () => c.query("select fn_video_library(10, 0, 'all')")));
    expect(anonErr?.message).toMatch(/permission denied/);
    const writeErr = await errorOf(
      asRole(c, "authenticated", userA, () => c.query("insert into user_video_removals (user_id, youtube_video_id) values ($1, 'x')", [userA]))
    );
    expect(writeErr?.message).toMatch(/permission denied/);
    const unauth = await errorOf(asRole(c, "authenticated", null, () => c.query("select fn_dashboard_summary()")));
    expect(unauth?.message).toMatch(/authentication_required/);
  });
});

d("Phase 6 — operator scripts as written (preflight → 040 → postflight → reconcile)", () => {
  let db: TestDb;
  let c: PgClient;
  const script = (name: string) => fs.readFileSync(path.join(__dirname, "../../../supabase/phase6", name), "utf8");
  /** Runs a multi-statement script as the owner; returns every result's rows. */
  const run = async (name: string) => {
    const res = (await c.query(script(name))) as unknown as Array<{ rows: Json[] }> | { rows: Json[] };
    return (Array.isArray(res) ? res : [res]).map((r) => r.rows);
  };

  beforeAll(async () => {
    db = await createTestDb("phase6ops", 38);
    c = await db.connect();
    await runCutover(c, "activated");
    await applyMigration(c, 39);
  }, 240_000);
  afterAll(async () => {
    await c?.end();
    await db?.drop();
  });

  it("preflight reads the prerequisites and the membership gap; postflight is all-ok; reconcile closes the gap", async () => {
    const u = await createUser(c);
    await publishTranscript(c, "vidOps", TEXTS);
    await rpcAs(c, u, "select fn_create_or_get_active_round($1)", ["vidOps"]); // activity with no membership

    const pre = await run("00_preflight.sql");
    expect(pre[0][0]).toMatchObject({ phase3_stage: "activated", phase4_applied: true, phase5_applied: true, phase5_batch_index: true });
    expect(pre[1][0]).toMatchObject({ phase6_applied: false, removals_table_present: false });
    expect(Number(pre[2][0].membership_gap)).toBe(1);

    await applyMigration(c, 40);
    const post = await run("01_postflight.sql");
    expect(post[0]).toHaveLength(21);
    expect(post[1]).toHaveLength(19);
    expect(post[2]).toEqual([{ grantee: "authenticated", privileges: "SELECT", ok: true }]);
    expect(post[3][0].rls_enabled).toBe(true);
    for (const rows of post) for (const row of rows) if ("ok" in row) expect([row, row.ok]).toEqual([row, true]);
    expect(post[5][0].membership_gap).toBe(1);
    expect(post[7]).toHaveLength(4); // new columns
    expect(post[8]).toEqual([]); // no activity batches yet

    const rec = await run("02_reconcile_membership.sql");
    expect(rec[0][0].gap_before).toBe(1);
    expect(rec[1][0].result).toMatchObject({ inserted: 1, skippedRemoved: 0 });
    expect(rec[2][0].gap_after).toBe(0);
    const again = await run("02_reconcile_membership.sql");
    expect(again[1][0].result).toMatchObject({ inserted: 0 });
    expect((await run("01_postflight.sql"))[5][0].membership_gap).toBe(0);
  });
});
