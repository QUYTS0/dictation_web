/**
 * Shadowing summary (.claude/shadowing-summary-audit.md, D1–D8 resolved) —
 * real PostgreSQL evidence for the server report path (fn_round_report →
 * fn_shadowing_summary) and for the shared summary builder fed by the saved
 * round results (fn_shadowing_round_results) through BOTH adapters: the
 * practice page's (mergeServerResults → summaryInputFromEvaluations) and the
 * round reports' (fromRoundResults). Azure is never called — results are
 * written through the real service_role lifecycle functions (fn_begin /
 * fn_finish_azure_evaluation) with fixed scores. Skipped unless
 * LOCALDB_ADMIN_URL is set.
 */
import { randomUUID } from "crypto";
import {
  HAS_LOCALDB,
  applyMigration,
  createTestDb,
  createUser,
  publishTranscript,
  rpcAs,
  runCutover,
  type PgClient,
  type TestDb,
} from "./localdb/harness";
import { mergeServerResults } from "@/app/dictation/[videoId]/shadowingServerMerge";
import { summaryInputFromEvaluations } from "@/app/dictation/[videoId]/videoPracticeSummary";
import { buildShadowingRoundSummary } from "@/lib/practice/shadowingSummary";
import { fromRoundResults } from "@/lib/practice/shadowingSummaryInput";
import { formatAggregateScore } from "@/lib/practice/scoreFormat";
import type { ShadowingRoundResults } from "@/lib/practice/shadowingTypes";

const d = HAS_LOCALDB ? describe : describe.skip;
if (!HAS_LOCALDB) console.warn("[shadowing-summary-audit] skipped — LOCALDB_ADMIN_URL not set");

type Json = Record<string, unknown> & { [k: string]: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

// Six eligible sentences with different word counts (word-count weights).
const TEXTS = ["one two", "three four five", "six seven", "eight nine ten eleven", "twelve", "thirteen fourteen"];
const TEXTS_B = ["alpha beta", "gamma delta", "epsilon zeta", "eta theta", "iota", "kappa lambda"];

const BEGIN = "select fn_begin_azure_evaluation($1, $2, $3)";
const FINISH = "select fn_finish_azure_evaluation($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)";
const WORD_MATCH = "select fn_record_word_match($1, $2, $3, $4, $5, $6::jsonb)";

d("Shadowing summary audit (real PostgreSQL)", () => {
  let db: TestDb;
  let c: PgClient;

  const call = <T = Json>(u: string, sql: string, params: unknown[] = []) => rpcAs<T>(c, u, sql, params);
  const svc = <T = Json>(u: string, sql: string, params: unknown[]) => rpcAs<T>(c, u, sql, params, "service_role");
  const newRound = async (u: string, v: string) => (await call(u, "select fn_create_or_get_active_round($1)", [v])).roundId as string;
  const shadow = (u: string, r: string, v: string, seg: number, dur: number) =>
    call(u, "select fn_record_shadowing_attempt($1, $2, $3, $4, $5)", [r, v, seg, randomUUID(), dur]);
  const dictate = (u: string, r: string, v: string, seg: number, text: string) =>
    call(u, "select fn_record_dictation_attempt($1, $2, $3, $4, $5, 'relaxed', null, null, 0::smallint)", [r, v, seg, randomUUID(), text]);
  const activity = (u: string, v: string, r: string | null) =>
    call(u, "select fn_sync_study_activity('activity', $1, $2, $3, $4::jsonb, null, null, 'UTC', 0)", [
      randomUUID(), v, r, JSON.stringify([{ start: Date.now() / 1000 - 30, end: Date.now() / 1000 - 10 }]),
    ]);
  const endSessions = (u: string) => c.query("update study_sessions set ended_at = now() where user_id = $1 and ended_at is null", [u]);
  /** created_at strictly increasing per take, so "latest" is unambiguous. */
  const age = (attemptId: string, minutesAgo: number) =>
    c.query("update shadowing_attempts set created_at = now() - make_interval(mins => $2) where id = $1", [attemptId, minutesAgo]);

  type Scores = { pron: number; acc?: number | null; flu?: number | null; comp?: number | null; pros?: number | null; detail?: unknown };
  const evaluate = async (u: string, attemptId: string, s: Scores) => {
    const b = await svc(u, BEGIN, [attemptId, u, 2]);
    return svc(u, FINISH, [
      attemptId, u, b.seq, "completed", s.pron, s.acc ?? s.pron, s.flu === undefined ? s.pron : s.flu, s.comp ?? s.pron,
      s.pros === undefined ? s.pron : s.pros,
      s.detail === null ? null : JSON.stringify(s.detail ?? { recognizedText: "x", words: [{ word: "x", accuracyScore: s.pron, errorType: "None" }] }),
      null, "audit-engine",
    ]);
  };
  const failEvaluation = async (u: string, attemptId: string) => {
    const b = await svc(u, BEGIN, [attemptId, u, 2]);
    return svc(u, FINISH, [attemptId, u, b.seq, "failed", null, null, null, null, null, null, "provider_error", null]);
  };
  const wordMatch = (u: string, attemptId: string, accuracy: number) =>
    svc(u, WORD_MATCH, [attemptId, u, "completed", accuracy, accuracy, JSON.stringify({ recognizedText: "x", problemWords: [] })]);
  const report = (u: string, r: string) => call(u, "select fn_round_report($1)", [r]);
  const roundResults = (u: string, r: string) => call<ShadowingRoundResults>(u, "select fn_shadowing_round_results($1)", [r]);
  type Counts = { eligibleSentences: number | null; recordedSentences: number | null };
  /** The practice page: its live map restored from the server, then its adapter. */
  const practiceSummary = (server: ShadowingRoundResults, texts: string[], counts: Counts) =>
    buildShadowingRoundSummary(summaryInputFromEvaluations(mergeServerResults({}, server, (i) => texts[i] ?? ""), counts));
  /** The round reports (completion view, /results, History): the server adapter. */
  const reportSummary = (server: ShadowingRoundResults, texts: string[], counts: Counts) =>
    buildShadowingRoundSummary(fromRoundResults(server, (i) => texts[i] ?? "", counts));
  const countsOf = (rep: Json): Counts => ({
    eligibleSentences: rep.progress.requiredSentenceCount,
    recordedSentences: rep.progress.coveredSentences.shadowing,
  });

  /** Fingerprint of every learning table: any write by a read path changes it. */
  const fingerprint = async () =>
    (
      await c.query(`select md5(string_agg(t, '|' order by t)) as f from (
        select 'ls' || row(x.*)::text as t from learning_sessions x union all
        select 'ss' || row(x.*)::text from study_sessions x union all
        select 'sa' || row(x.*)::text from shadowing_attempts x union all
        select 'al' || row(x.*)::text from attempt_logs x union all
        select 'uv' || row(x.*)::text from user_videos x union all
        select 'ur' || row(x.*)::text from user_video_removals x union all
        select 'fl' || row(x.*)::text from activity_flush_log x union all
        select 'lp' || row(x.*)::text from listening_progress x) q`)
    ).rows[0].f as string;

  let u: string;
  let r1: string;
  const takes: Record<string, string> = {};

  beforeAll(async () => {
    db = await createTestDb("ssaudit", 38);
    c = await db.connect();
    await runCutover(c, "activated");
    for (const m of [39, 40, 41, 42]) await applyMigration(c, m);

    // Fixture (round 1, revision A, six eligible sentences), two study sessions.
    u = await createUser(c);
    await publishTranscript(c, "vAudit", TEXTS);
    r1 = await newRound(u, "vAudit");

    // Study session 1
    await activity(u, "vAudit", r1);
    takes.s0a = (await shadow(u, r1, "vAudit", 0, 2)).attemptId; // older success 60
    await evaluate(u, takes.s0a, { pron: 60 });
    takes.s1 = (await shadow(u, r1, "vAudit", 1, 3)).attemptId; // success 70
    await evaluate(u, takes.s1, { pron: 70 });
    await endSessions(u);

    // Study session 2
    await activity(u, "vAudit", r1);
    takes.s0b = (await shadow(u, r1, "vAudit", 0, 2)).attemptId; // newer success 80 replaces 60
    await evaluate(u, takes.s0b, { pron: 80 });
    takes.s0c = (await shadow(u, r1, "vAudit", 0, 2)).attemptId; // newest take, never evaluated
    takes.s1b = (await shadow(u, r1, "vAudit", 1, 3)).attemptId; // newer take, evaluation failed
    await failEvaluation(u, takes.s1b);
    takes.s2 = (await shadow(u, r1, "vAudit", 2, 2)).attemptId; // Azure without fluency/prosody + Word Match 100
    await evaluate(u, takes.s2, { pron: 90, flu: null, pros: null });
    await wordMatch(u, takes.s2, 100);
    takes.s3 = (await shadow(u, r1, "vAudit", 3, 4)).attemptId; // Word Match only
    await wordMatch(u, takes.s3, 50);
    takes.s4 = (await shadow(u, r1, "vAudit", 4, 1)).attemptId; // paid result not persisted: admitted, never finished
    await svc(u, BEGIN, [takes.s4, u, 1]);
    takes.s5 = (await shadow(u, r1, "vAudit", 5, 0.3)).attemptId; // too short: stored, but not a valid recording
    // Creation order = the order above.
    const order = ["s0a", "s1", "s0b", "s0c", "s1b", "s2", "s3", "s4", "s5"];
    for (const [i, k] of order.entries()) await age(takes[k], 100 - i);

    // Dictation completes the round (all six sentences answered).
    for (let i = 0; i < 6; i++) await dictate(u, r1, "vAudit", i, TEXTS[i]);
  }, 240_000);
  afterAll(async () => {
    await c?.end();
    await db?.drop();
  });

  it("points 1–3, 6, 8, 9: server report counts saved Azure sentences once, keeps earlier successes, excludes missing metrics", async () => {
    const rep = await report(u, r1);
    // 8. The round is complete through Dictation; Shadowing is partial.
    expect(rep.round.status).toBe("completed");
    expect(rep.progress.requiredSentenceCount).toBe(6);
    // 6. Both study sessions contribute (takes are attributed to two sessions).
    const sessions = await c.query("select count(distinct study_session_id) n from shadowing_attempts where round_id = $1", [r1]);
    expect(Number(sessions.rows[0].n)).toBe(2);
    expect(rep.activity.sessionCount).toBe(2);

    const sh = rep.shadowing;
    // 1. s0, s1, s2 evaluated; s3 (Word Match only) and s4 (pending / not persisted) are not.
    expect(sh.azure.evaluatedSentences).toBe(3);
    // 2. The too-short take on s5 is a recording attempt, never valid recording coverage.
    expect(sh.attemptedSentences).toBe(6);
    expect(sh.practicedSentences).toBe(5);
    expect(rep.progress.coveredSentences.shadowing).toBe(5);
    expect(sh.takes).toBe(9);
    // 2–3. s0 uses the NEWER success (80, not 60; the unevaluated newest take changes nothing);
    //      s1 keeps 70 although its newer take failed. Word-count weights: 2, 3, 2.
    //      (80*2 + 70*3 + 90*2) / 7 = 78.571…
    expect(Number(sh.azure.pronunciation)).toBe(78.6);
    // 9. Fluency/prosody: s2 returned none → excluded (never 0, never Word Match's 100).
    //    Duration weights: s0b 2 s, s1 3 s → (80*2 + 70*3) / 5 = 74.
    expect(Number(sh.azure.fluency)).toBe(74);
    expect(Number(sh.azure.prosody)).toBe(74);
    // Word Match is a separate aggregate: s2 (100, 2 words) and s3 (50, 4 words) → 66.7.
    expect(sh.wordMatch.evaluatedSentences).toBe(2);
    expect(Number(sh.wordMatch.accuracy)).toBe(66.7);

    // Per-sentence report rows use the same selection rule.
    const byIdx = Object.fromEntries((rep.sentences as Json[]).map((s) => [s.segmentIndex, s]));
    expect(byIdx[0].shadowing.latestAzure.attemptId).toBe(takes.s0b);
    expect(byIdx[1].shadowing.latestAzure.attemptId).toBe(takes.s1);
    expect(byIdx[3].shadowing.latestAzure).toBeNull();
    expect(byIdx[4].shadowing.latestAzure).toBeNull();
  });

  it("points 1, 5, 16, 17, 19: practice page and reports build the SAME summary; denominators are the eligible sentences", async () => {
    const rep = await report(u, r1);
    const server = await roundResults(u, r1);
    expect(server.transcriptId).toBe(rep.round.transcriptId);
    const practice = practiceSummary(server, TEXTS, countsOf(rep));
    const history = reportSummary(server, TEXTS, countsOf(rep));
    expect(practice).toEqual(history);
    // D1: 3 of 6 scored; 5 of 6 recorded (valid takes only); Word Match separate.
    expect(history.coverage).toEqual({
      eligibleSentences: 6, recordedSentences: 5, scoredSentences: 3, wordMatchSentences: 2, allRecorded: false, allScored: false,
    });
    // Same evidence as the SQL totals.
    expect(history.coverage.scoredSentences).toBe(rep.shadowing.azure.evaluatedSentences);
    expect(history.coverage.wordMatchSentences).toBe(rep.shadowing.wordMatch.evaluatedSentences);
    expect(history.metrics.pronunciation).toEqual({ value: 550 / 7, sentences: 3 });
    expect(history.metrics.fluency).toEqual({ value: 74, sentences: 2 });
    expect(history.metrics.prosody).toEqual({ value: 74, sentences: 2 });
    // D6: one display rule — the SQL value and the client mean format identically.
    for (const k of ["pronunciation", "fluency", "prosody"] as const) {
      expect(formatAggregateScore(history.metrics[k]!.value)).toBe(formatAggregateScore(Number(rep.shadowing.azure[k])));
    }
    // 16. Takes from both study sessions are in the one round summary (s0 from session 2 replaced session 1's).
    expect(history.sentences.map((x) => [x.segmentIndex, x.pronunciationScore])).toEqual([[0, 80], [1, 70], [2, 90], [3, null]]);
  });

  it("point 12 (D6): a mean on the double-rounding boundary shows the same text on every surface", async () => {
    // Two sentences of 11 and 9 words scored 84 and 85: exact mean 84.45.
    const long = ["a b c d e f g h i j k", "a b c d e f g h i"];
    const u2 = await createUser(c);
    await publishTranscript(c, "vRound", long);
    const r = await newRound(u2, "vRound");
    for (const [seg, pron] of [[0, 84], [1, 85]] as const) {
      const t = (await shadow(u2, r, "vRound", seg, 2)).attemptId;
      await evaluate(u2, t, { pron });
    }
    const rep = await report(u2, r);
    const s = practiceSummary(await roundResults(u2, r), long, countsOf(rep));
    expect(s.metrics.pronunciation?.value).toBeCloseTo(84.45, 9);
    expect(Number(rep.shadowing.azure.pronunciation)).toBe(84.5);
    // Before: 85 (report) vs 84 (practice). Now both "84.5".
    expect(formatAggregateScore(Number(rep.shadowing.azure.pronunciation))).toBe("84.5");
    expect(formatAggregateScore(s.metrics.pronunciation!.value)).toBe("84.5");
    const dash = await call(u2, "select fn_dashboard_summary()");
    expect(formatAggregateScore(Number(dash.shadowing.azure.pronunciation))).toBe("84.5");
  });

  it("point 20: reading every report surface writes nothing (even with an overdue pending evaluation)", async () => {
    // s4's admitted request is now overdue: reads report it as expired without writing it.
    await c.query("update shadowing_attempts set eval_requested_at = now() - interval '10 minutes' where id = $1", [takes.s4]);
    const before = await fingerprint();
    await report(u, r1);
    const server = await roundResults(u, r1);
    expect(server.segments.find((sg) => sg.segmentIndex === 4)?.latestAttempt?.azure).toMatchObject({ status: "failed", errorReason: "expired" });
    await call(u, "select fn_get_shadowing_attempt($1)", [takes.s4]);
    await call(u, "select fn_dashboard_summary()");
    await call(u, "select fn_my_round_progress($1)", [r1]);
    await call(u, "select fn_history_videos(20, null, null)");
    await call(u, "select fn_history_video_rounds($1)", ["vAudit"]);
    await call(u, "select fn_history_video_sessions($1, $2, false, 10, null, null)", ["vAudit", r1]);
    await call(u, "select fn_video_library(20, 0, 'all')");
    expect(await fingerprint()).toBe(before);
    const row = (await c.query("select azure_eval_status from shadowing_attempts where id = $1", [takes.s4])).rows[0];
    expect(row.azure_eval_status).toBe("pending");
  });

  it("point 4: a paid result that was not persisted counts only after recovery writes it (same seq)", async () => {
    const before = (await report(u, r1)).shadowing.azure.evaluatedSentences;
    const seq = (await c.query("select azure_eval_request_seq s from shadowing_attempts where id = $1", [takes.s4])).rows[0].s;
    // persist-recovery replays the signed result for the SAME seq (fn_finish accepts a late success over expiry).
    const out = await svc(u, FINISH, [
      takes.s4, u, seq, "completed", 50, 50, 50, 50, 50, JSON.stringify({ recognizedText: "twelve", words: [] }), null, "audit-engine",
    ]);
    expect(out.applied).toBe(true);
    const after = (await report(u, r1)).shadowing.azure.evaluatedSentences;
    expect([before, after]).toEqual([3, 4]);
  });

  it("points 7, 21: rounds and transcript revisions stay separate; an old round keeps its own report and summary", async () => {
    const before = (await report(u, r1)).shadowing;
    await publishTranscript(c, "vAudit", TEXTS_B); // revision B becomes current
    const r2 = (await call(u, "select fn_restart_round($1, $2)", ["vAudit", r1])).roundId as string;
    const t = (await shadow(u, r2, "vAudit", 0, 2)).attemptId;
    await evaluate(u, t, { pron: 20 });

    const rep1 = await report(u, r1);
    expect(rep1.shadowing).toEqual(before); // round 1 unchanged
    const old = reportSummary(await roundResults(u, r1), TEXTS, countsOf(rep1));
    expect(old.coverage.scoredSentences).toBe(4);
    expect(old.sentences.find((x) => x.segmentIndex === 0)?.referenceText).toBe("one two"); // revision A text, not B
    const rep2 = await report(u, r2);
    expect(rep2.shadowing.azure).toMatchObject({ evaluatedSentences: 1 });
    expect(Number(rep2.shadowing.azure.pronunciation)).toBe(20);
    const res2 = await roundResults(u, r2);
    expect(res2.transcriptId).not.toBe((await roundResults(u, r1)).transcriptId);
    // The practice page refuses to merge a round pinned to another revision (useShadowingEvaluations).
    expect(res2.transcriptId).toBe(rep2.round.transcriptId);
    const current = reportSummary(res2, TEXTS_B, countsOf(rep2));
    expect(current.coverage).toMatchObject({ scoredSentences: 1, eligibleSentences: 6 });
    expect(current.sentences[0].referenceText).toBe("alpha beta");
    // Dashboard: account-wide, every round's latest success per sentence (round 1: 4, round 2: 1).
    const dash = await call(u, "select fn_dashboard_summary()");
    expect(dash.shadowing.azure.evaluatedSentences).toBe(before.azure.evaluatedSentences + 1);
  });
});
