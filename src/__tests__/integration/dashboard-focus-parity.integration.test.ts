/**
 * Dashboard Focus parity gate (plan D-2), on real PostgreSQL.
 *
 * Focus takes its "sentences need another look" count from the Continue
 * Learning card it already has — `round.progress.sentenceAccuracy`, i.e.
 * fn_round_progress via fn_video_library — instead of fetching the round
 * report. That is only allowed if, for every round,
 *
 *   progress.sentenceAccuracy.practiced − progress.sentenceAccuracy.correct
 *     === fn_round_report(round).dictation.needsReview
 *
 * Both sides are read here through their own canonical functions, called
 * separately as `authenticated` (PostgREST style) — never derived from each
 * other or from a mock. Fixtures are written through the real recording
 * functions (fn_record_dictation_attempt / fn_record_shadowing_attempt), and
 * the legacy round is seeded BEFORE the real Phase 3 cutover tags it.
 * Skipped unless LOCALDB_ADMIN_URL is set (see localdb/harness.ts).
 */
import { randomUUID } from "crypto";
import { HAS_LOCALDB, applyMigration, createTestDb, createUser, migrationFiles, publishTranscript, rpcAs, runCutover, type PgClient, type TestDb } from "./localdb/harness";

const d = HAS_LOCALDB ? describe : describe.skip;
if (!HAS_LOCALDB) console.warn("[dashboard-focus-parity] skipped — LOCALDB_ADMIN_URL not set");

type Json = Record<string, unknown> & { [k: string]: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

const TEXTS = Array.from({ length: 14 }, (_, i) => `word${i} alpha${i}`);
const RIGHT = (seg: number) => `word${seg} alpha${seg}`;
const WRONG = "completely different";

d("Dashboard Focus parity: progress (practiced − correct) === report needsReview (real PostgreSQL)", () => {
  let db: TestDb;
  let c: PgClient;
  let user: string;
  const legacy = { video: "vParityLegacy", round: "" };

  const call = <T = Json>(sql: string, params: unknown[] = []) => rpcAs<T>(c, user, sql, params);
  const dictate = (r: string, v: string, seg: number, text: string) =>
    call("select fn_record_dictation_attempt($1, $2, $3, $4, $5, 'relaxed', null, null, 0::smallint)", [r, v, seg, randomUUID(), text]);
  const shadow = (r: string, v: string, seg: number, dur = 2) => call("select fn_record_shadowing_attempt($1, $2, $3, $4, $5)", [r, v, seg, randomUUID(), dur]);
  const newRound = async (v: string) => {
    await publishTranscript(c, v, TEXTS);
    await call("select fn_library_add_video($1, true)", [v]);
    return (await call<Json>("select fn_create_or_get_active_round($1)", [v])).roundId as string;
  };
  /** The Continue/Library card's progress — fn_video_library, exactly what the Dashboard receives. */
  const cardProgress = async (v: string, filter: string) => {
    const items = (await call<Json>("select fn_video_library(50, 0, $1)", [filter])).items as Json[];
    const it = items.find((i) => i.videoId === v);
    if (!it?.round) throw new Error(`no ${filter} card with a round for ${v}`);
    return { roundId: it.round.roundId as string, status: it.round.status, provenance: it.round.provenance, acc: it.round.progress.sentenceAccuracy as { correct: number; practiced: number } };
  };
  const report = (r: string) => call<Json>("select fn_round_report($1)", [r]);
  const categories = async (r: string) =>
    Object.fromEntries(((await report(r)).sentences as Json[]).map((s) => [s.segmentIndex as number, s.category as string]));

  beforeAll(async () => {
    const last = Number(migrationFiles(999).at(-1)!.slice(0, 3));
    db = await createTestDb("focus_parity", 38);
    c = await db.connect();
    user = await createUser(c);
    // Legacy history BEFORE the cutover: one sentence wrong (latest), one right, one corrected.
    const tr = await publishTranscript(c, legacy.video, TEXTS);
    legacy.round = (
      await c.query(
        `insert into learning_sessions (user_id, youtube_video_id, transcript_id, status, accuracy, total_attempts)
         values ($1, $2, $3, 'completed', 50, 4) returning id`,
        [user, legacy.video, tr]
      )
    ).rows[0].id;
    await c.query(
      `insert into attempt_logs (session_id, segment_index, expected_text, user_text, is_correct, created_at)
       values ($1, 0, $2, $2, true,  now() - interval '3 days'),
              ($1, 1, $3, 'nope', false, now() - interval '3 days' + interval '1 minute'),
              ($1, 2, $4, 'nope', false, now() - interval '3 days' + interval '2 minutes'),
              ($1, 2, $4, $4, true,  now() - interval '3 days' + interval '3 minutes')`,
      [legacy.round, RIGHT(0), RIGHT(1), RIGHT(2)]
    );
    await runCutover(c, "activated");
    for (let n = 39; n <= last; n++) await applyMigration(c, n);
    await c.query("insert into user_videos (user_id, youtube_video_id) values ($1, $2) on conflict do nothing", [user, legacy.video]);
  }, 300_000);
  afterAll(async () => {
    await c?.end();
    await db?.drop();
  });

  it("every category, ignored invalid answers and a created_at tie: the active current Continue card's count equals the report's needsReview", async () => {
    const v = "vParityMixed";
    const r = await newRound(v);
    await dictate(r, v, 0, WRONG); // corrected
    await dictate(r, v, 0, RIGHT(0));
    await dictate(r, v, 1, RIGHT(1)); // first-try correct
    await dictate(r, v, 2, WRONG); // still incorrect
    for (let i = 0; i < 3; i++) await dictate(r, v, 3, WRONG); // repeated incorrect
    await shadow(r, v, 4); // shadowing-only
    await dictate(r, v, 5, RIGHT(5)); // mixed: right, then wrong, plus a take
    await dictate(r, v, 5, WRONG);
    await shadow(r, v, 5);
    await dictate(r, v, 6, WRONG); // latest VALID is wrong; a later whitespace-only answer is ignored
    await dictate(r, v, 6, "   ");
    await dictate(r, v, 7, RIGHT(7)); // latest VALID is right; a later whitespace-only answer is ignored
    await dictate(r, v, 7, "   ");
    await dictate(r, v, 8, "  "); // only invalid answers: not practiced at all
    await shadow(r, v, 9, 0.2); // too-short take: not practice
    // Tie: two answers with the same created_at — both functions break it by id desc.
    await dictate(r, v, 10, RIGHT(10));
    await dictate(r, v, 10, WRONG);
    await c.query("update attempt_logs set created_at = (select min(created_at) from attempt_logs where session_id = $1 and segment_index = 10) where session_id = $1 and segment_index = 10", [r]);

    const card = await cardProgress(v, "continue");
    expect(card).toMatchObject({ roundId: r, status: "active", provenance: "current" }); // a Focus candidate
    const rep = await report(r);
    expect(card.acc.practiced - card.acc.correct).toBe(rep.dictation.needsReview);

    // The fixtures really exercise each category (so parity is not vacuous).
    const cat = await categories(r);
    expect(cat).toMatchObject({ 0: "corrected", 1: "first_try", 2: "needs_review", 3: "needs_review", 4: "shadowing_only", 5: "needs_review", 6: "needs_review", 7: "first_try" });
    expect([8, 9].some((s) => cat[s] === "needs_review")).toBe(false);
    const tieLatest = (await c.query("select is_correct from attempt_logs where session_id = $1 and segment_index = 10 and is_practice_valid order by created_at desc, id desc limit 1", [r])).rows[0].is_correct as boolean;
    expect(cat[10]).toBe(tieLatest ? "corrected" : "needs_review");
    expect(rep.dictation.needsReview).toBe(4 + (tieLatest ? 0 : 1)); // sentences 2, 3, 5, 6 (+ 10 when the tie's latest is wrong)
  });

  it("a round with nothing to review: 0 on both sides; a shadowing-only round: 0 on both sides", async () => {
    const v1 = "vParityClean";
    const r1 = await newRound(v1);
    await dictate(r1, v1, 0, RIGHT(0));
    await dictate(r1, v1, 1, WRONG);
    await dictate(r1, v1, 1, RIGHT(1));
    const c1 = await cardProgress(v1, "continue");
    expect(c1.acc.practiced - c1.acc.correct).toBe(0);
    expect((await report(r1)).dictation.needsReview).toBe(0);

    const v2 = "vParityShadow";
    const r2 = await newRound(v2);
    await shadow(r2, v2, 0);
    await shadow(r2, v2, 1);
    const c2 = await cardProgress(v2, "continue");
    expect(c2.acc).toMatchObject({ practiced: 0, correct: 0 });
    expect((await report(r2)).dictation.needsReview).toBe(0);
  });

  it("legacy/unverified round: parity still holds (Focus never uses it — provenance gate)", async () => {
    const card = await cardProgress(legacy.video, "all");
    expect(card).toMatchObject({ roundId: legacy.round, provenance: "legacy_unverified" });
    const rep = await report(legacy.round);
    expect(card.acc.practiced - card.acc.correct).toBe(rep.dictation.needsReview);
    expect(rep.dictation.needsReview).toBe(1);
  });
});
