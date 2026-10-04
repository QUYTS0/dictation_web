/**
 * An earlier round stays readable after a newer round starts — real
 * PostgreSQL, every read AS `authenticated` (PostgREST style), using the same
 * tables/functions the report route (/api/session/<id>/report) and History
 * (fn_history_video_rounds) read. Proves the reads are owner-only and change
 * nothing. Skipped unless LOCALDB_ADMIN_URL is set (see localdb/harness.ts).
 */
import { randomUUID } from "crypto";
import { HAS_LOCALDB, createTestDb, createUser, publishTranscript, rpcAs, asRole, errorOf, runCutover, type TestDb, type PgClient } from "./localdb/harness";

const d = HAS_LOCALDB ? describe : describe.skip;
if (!HAS_LOCALDB) console.warn("[historical-round-report] skipped — LOCALDB_ADMIN_URL not set");

type Report = {
  round: { roundId: string; status: string; roundNumber: number; transcriptId: string; completedAt: string | null };
  progress: { coveredSentences: { overall: number } };
  dictation: { latestCorrect: number; practicedSentences: number };
  sentences: Array<{ segmentIndex: number; text: string }>;
};

d("historical round report (real PostgreSQL)", () => {
  let db: TestDb;
  let owner: PgClient;
  let userA: string;
  let userB: string;

  beforeAll(async () => {
    db = await createTestDb("historical_report");
    owner = await db.connect();
    userA = await createUser(owner);
    userB = await createUser(owner);
    await runCutover(owner, "activated");
  }, 180_000);
  afterAll(async () => {
    await owner?.end().catch(() => {});
    await db?.drop();
  });

  const as = <T>(user: string, sql: string, params: unknown[]) =>
    asRole(owner, "authenticated", user, async () => (await owner.query(sql, params)).rows as T[]);
  /** Everything a read must leave alone. */
  const snapshot = async (video: string) => ({
    rounds: (await owner.query("select id, status, completed_at, updated_at, round_number from learning_sessions where youtube_video_id = $1 order by round_number", [video])).rows,
    attempts: (await owner.query("select a.id, a.session_id from attempt_logs a join learning_sessions r on r.id = a.session_id where r.youtube_video_id = $1 order by a.id", [video])).rows,
    studySessions: (await owner.query("select id, round_id, ended_at from study_sessions where youtube_video_id = $1 order by id", [video])).rows,
  });

  it("round 1 completed, round 2 started: round 1's report is its own, both rounds are listed, nothing changes, and another user reads neither", async () => {
    const video = `v-${randomUUID().slice(0, 8)}`;
    const t1 = await publishTranscript(owner, video, ["Hello there.", "How are you?", "I am fine."]);
    const r1 = (await rpcAs<{ roundId: string }>(owner, userA, "select fn_create_or_get_active_round($1, $2, null, null)", [video, t1])).roundId;
    const RECORD = "select fn_record_dictation_attempt($1, $2, $3, $4, $5, 'relaxed', $6, null, null)";
    for (const [i, text] of [[0, "hello there"], [1, "how are"], [2, "i am fine"]] as const) await rpcAs(owner, userA, RECORD, [r1, video, i, randomUUID(), text, t1]);
    // Round 2 on a NEWER script revision, with one answer of its own.
    const t2 = await publishTranscript(owner, video, ["Good morning.", "See you."]);
    const r2 = (await rpcAs<{ roundId: string }>(owner, userA, "select fn_restart_round($1, $2)", [video, r1])).roundId;
    await rpcAs(owner, userA, RECORD, [r2, video, 0, randomUUID(), "good morning", t2]);
    const before = await snapshot(video);

    // The report route's reads, for round 1, as its owner.
    const [own] = await as<{ status: string; transcript_id: string }>(userA, "select status, transcript_id from learning_sessions where id = $1 and user_id = $2", [r1, userA]);
    expect(own).toEqual({ status: "completed", transcript_id: t1 });
    const [{ fn_round_report: rep1 }] = await as<{ fn_round_report: Report }>(userA, "select fn_round_report($1)", [r1]);
    expect(rep1.round).toMatchObject({ roundId: r1, status: "completed", roundNumber: 1, transcriptId: t1 });
    expect(rep1.round.completedAt).not.toBeNull();
    expect(rep1.sentences.map((s) => s.text)).toEqual(["Hello there.", "How are you?", "I am fine."]); // its pinned revision
    expect(rep1.dictation).toMatchObject({ practicedSentences: 3, latestCorrect: 2 });
    const [{ fn_round_report: rep2 }] = await as<{ fn_round_report: Report }>(userA, "select fn_round_report($1)", [r2]);
    expect(rep2.round).toMatchObject({ roundId: r2, status: "active", roundNumber: 2, transcriptId: t2 });
    expect(rep2.dictation).toMatchObject({ practicedSentences: 1, latestCorrect: 1 }); // distinct metrics
    const attempts1 = await as<{ n: number }>(userA, "select count(*)::int n from attempt_logs where session_id = $1", [r1]);
    expect(attempts1[0].n).toBe(3);
    const active = await as<{ id: string }>(userA, "select id from learning_sessions where user_id = $1 and youtube_video_id = $2 and status = 'active'", [userA, video]);
    expect(active).toEqual([{ id: r2 }]); // "Go to current round" names round 2

    // History lists both, defaulting to the active round (round 1 is selectable).
    const [{ r }] = await as<{ r: { defaultRoundId: string; rounds: Array<{ roundId: string; status: string }> } }>(userA, "select fn_history_video_rounds($1) r", [video]);
    expect(r.defaultRoundId).toBe(r2);
    expect(r.rounds.map((x) => [x.roundId, x.status])).toEqual([[r2, "active"], [r1, "completed"]]);

    // The report page's round selector (/round-list): the route's own query under RLS — this user's rounds of this video, newest first, exact total.
    const LIST =
      "select id, round_number, status, count(*) over () as total from learning_sessions where user_id = $1 and youtube_video_id = $2 order by started_at desc, id desc offset 0 limit 50";
    const listA = await as<{ id: string; round_number: number; status: string; total: string }>(userA, LIST, [userA, video]);
    expect(listA.map((x) => [x.id, x.round_number, x.status, Number(x.total)])).toEqual([[r2, 2, "active", 2], [r1, 1, "completed", 2]]);
    // Even asking with A's id, B's session sees none of A's rounds (RLS), so the count is 0.
    expect(await as(userB, LIST, [userA, video])).toEqual([]);

    // Another user: neither report, no rows.
    for (const id of [r1, r2]) {
      expect((await errorOf(as(userB, "select fn_round_report($1)", [id])))?.message).toBe("round_not_found");
      expect(await as(userB, "select id from learning_sessions where id = $1", [id])).toEqual([]);
      expect(await as(userB, "select id from attempt_logs where session_id = $1", [id])).toEqual([]);
    }

    // Reading changed nothing: statuses, completion time, attempt rounds, study sessions, the active round.
    expect(await snapshot(video)).toEqual(before);
  });
});
