/**
 * Phase 4 review fixes on real PostgreSQL (001–038, Phase 3 cutover
 * activated): per-attempt evaluation admission under real concurrency,
 * audio-duration admission, full-result idempotency and the revoked 035
 * writers — each call under the role PostgREST would use.
 * Skipped unless LOCALDB_ADMIN_URL is set (see localdb/harness.ts).
 */
import { randomUUID } from "crypto";
import {
  HAS_LOCALDB,
  createTestDb,
  createUser,
  publishTranscript,
  rpcAs,
  beginAs,
  backendPid,
  waitUntilBlocked,
  errorOf,
  runCutover,
  type TestDb,
  type PgClient,
} from "./localdb/harness";

const d = HAS_LOCALDB ? describe : describe.skip;
if (!HAS_LOCALDB) console.warn("[phase4-review-fixes] skipped — LOCALDB_ADMIN_URL not set");

type Begin = { admitted: boolean; outcome: string; seq: number; requestedAt?: string; expiresAt?: string; referenceText?: string };
type Finish = { applied: boolean; outcome: string; currentSeq: number; status: string };

const BEGIN = "select fn_begin_azure_evaluation($1, $2, $3)";
const FINISH = "select fn_finish_azure_evaluation($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)";
const DETAIL = { recognizedText: "hello there", words: [{ word: "hello", accuracyScore: 95, errorType: "None" }] };

d("Phase 4 review fixes (real PostgreSQL)", () => {
  let db: TestDb;
  let owner: PgClient;
  let c2: PgClient;
  let c3: PgClient;
  let userA: string;
  let userB: string;
  let video = "";
  let transcriptId = "";

  beforeAll(async () => {
    db = await createTestDb("p4review");
    owner = await db.connect();
    c2 = await db.connect();
    c3 = await db.connect();
    userA = await createUser(owner);
    userB = await createUser(owner);
    await runCutover(owner, "activated");
  }, 180_000);
  afterAll(async () => {
    for (const c of [owner, c2, c3]) await c?.end().catch(() => {});
    await db?.drop();
  });
  beforeEach(async () => {
    video = `v-${randomUUID().slice(0, 8)}`;
    transcriptId = await publishTranscript(owner, video, ["Hello there.", "How are you?"]);
  });

  const take = async (user: string, seg = 0, dur = 2) => {
    const { roundId } = await rpcAs<{ roundId: string }>(owner, user, "select fn_create_or_get_active_round($1, $2)", [video, transcriptId]);
    return (await rpcAs<{ attemptId: string }>(owner, user, "select fn_record_shadowing_attempt($1, $2, $3, $4, $5, $6, null)", [
      roundId, video, seg, randomUUID(), dur, transcriptId,
    ])).attemptId;
  };
  const svc = <T,>(sql: string, params: unknown[], c: PgClient = owner) => rpcAs<T>(c, userA, sql, params, "service_role");
  const begin = (attemptId: string, user = userA, audioSec = 2, c: PgClient = owner) => svc<Begin>(BEGIN, [attemptId, user, audioSec], c);
  const finish = (attemptId: string, user: string, seq: number, status: "completed" | "failed", o: { pron?: number; detail?: unknown; engine?: string } = {}) =>
    svc<Finish>(FINISH, [
      attemptId, user, seq, status,
      status === "completed" ? (o.pron ?? 81) : null,
      status === "completed" ? 90 : null,
      status === "completed" ? 70 : null,
      status === "completed" ? 100 : null,
      null,
      status === "completed" ? JSON.stringify(o.detail ?? DETAIL) : null,
      status === "failed" ? "provider_error" : null,
      status === "completed" ? (o.engine ?? "engine-v1") : null,
    ]);
  const row = async (attemptId: string) => (await owner.query("select * from shadowing_attempts where id = $1", [attemptId])).rows[0];
  const expireLive = (attemptId: string) =>
    owner.query("update shadowing_attempts set eval_requested_at = clock_timestamp() - interval '10 minutes' where id = $1", [attemptId]);

  // --------------------------------------------------------- admission

  it("1–2. two concurrent begins for ONE attempt admit exactly one; the duplicate changes nothing", async () => {
    const a = await take(userA);
    // Request 1 holds the attempt's row lock inside its admission transaction.
    await beginAs(c2, "service_role", null);
    const first = Object.values((await c2.query(BEGIN, [a, userA, 2])).rows[0])[0] as Begin;
    expect(first).toMatchObject({ admitted: true, seq: 1 });
    // Request 2 for the SAME attempt waits for that lock…
    const pid = await backendPid(c3);
    const second = begin(a, userA, 2, c3);
    await waitUntilBlocked(owner, pid);
    await c2.query("commit");
    // …and then sees the live request: not admitted, nothing changed.
    const dup = await second;
    expect(dup).toMatchObject({ admitted: false, outcome: "in_progress", seq: 1 });
    expect(typeof dup.expiresAt).toBe("string");
    const after = await row(a);
    expect(after).toMatchObject({ azure_eval_request_seq: 1, azure_eval_status: "pending" });
    // A later duplicate (no race) is refused the same way, again without any write.
    const snapshot = await row(a);
    expect(await begin(a)).toMatchObject({ admitted: false, outcome: "in_progress", seq: 1 });
    expect(await row(a)).toEqual(snapshot);
  });

  it("4–5. the lock is per attempt: another recording of the same user, and another user's recording, are admitted while one is held", async () => {
    const a1 = await take(userA, 0);
    const a2 = await take(userA, 1);
    const b1 = await take(userB, 0);
    await beginAs(c2, "service_role", null);
    await c2.query(BEGIN, [a1, userA, 2]); // holds a1's row lock, transaction still open
    try {
      const within = <T,>(p: Promise<T>) =>
        Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("blocked — lock is not per attempt")), 5000))]);
      expect(await within(begin(a2, userA, 2, c3))).toMatchObject({ admitted: true, seq: 1 });
      expect(await within(begin(b1, userB, 2, c3))).toMatchObject({ admitted: true, seq: 1 });
    } finally {
      await c2.query("commit");
    }
    for (const id of [a1, a2, b1]) expect((await row(id)).azure_eval_status).toBe("pending");
  });

  it("6. a failed or expired request may be replaced; the old request's late result is then rejected by seq", async () => {
    const a = await take(userA);
    expect((await begin(a)).seq).toBe(1);
    expect(await finish(a, userA, 1, "failed")).toMatchObject({ applied: true });
    expect(await begin(a)).toMatchObject({ admitted: true, seq: 2 }); // retry after failure
    await expireLive(a); // seq 2 was admitted but never finished (e.g. the function died)
    expect(await begin(a)).toMatchObject({ admitted: true, seq: 3 }); // replacement after the bounded timeout
    expect(await finish(a, userA, 2, "completed")).toMatchObject({ applied: false, outcome: "superseded", currentSeq: 3 });
    expect((await row(a)).azure_eval_status).toBe("pending");
    expect(await finish(a, userA, 3, "completed")).toMatchObject({ applied: true });
  });

  it("7. a completed recording is never admitted again and nothing changes", async () => {
    const a = await take(userA);
    await begin(a);
    await finish(a, userA, 1, "completed");
    const before = await row(a);
    expect(await begin(a)).toEqual({ admitted: false, outcome: "already_evaluated", attemptId: a, seq: 1 });
    expect(await row(a)).toEqual(before);
  });

  it("11. audio materially longer than the recording it claims is rejected before admission (no pending left)", async () => {
    const a = await take(userA, 0, 2); // recorded 2.0 s
    const before = await row(a);
    expect((await errorOf(begin(a, userA, 3.6)))?.message).toBe("audio_duration_mismatch"); // > 2*1.25 + 1
    expect((await errorOf(begin(a, userA, 30)))?.message).toBe("audio_invalid"); // over the 21 s cap
    expect((await errorOf(begin(a, userA, 0)))?.message).toBe("audio_invalid");
    expect(await row(a)).toEqual(before);
    expect(await begin(a, userA, 3.4)).toMatchObject({ admitted: true }); // within tolerance
  });

  // ------------------------------------------------------- idempotency

  it("16–18. already_applied means the SAME result; a different detail or a late failure is a conflict and changes nothing", async () => {
    const a = await take(userA);
    await begin(a);
    expect(await finish(a, userA, 1, "completed")).toMatchObject({ outcome: "applied" });
    const stored = await row(a);
    // 17. identical replay (e.g. recovery): no write at all.
    expect(await finish(a, userA, 1, "completed")).toMatchObject({ applied: false, outcome: "already_applied" });
    // jsonb equality ignores key order.
    const reordered = { words: DETAIL.words, recognizedText: DETAIL.recognizedText };
    expect(await finish(a, userA, 1, "completed", { detail: reordered })).toMatchObject({ outcome: "already_applied" });
    expect(await row(a)).toEqual(stored);
    // 16. same numeric scores, different per-word detail → conflict.
    const otherDetail = { ...DETAIL, words: [{ word: "hello", accuracyScore: 40, errorType: "Mispronunciation" }] };
    expect(await finish(a, userA, 1, "completed", { detail: otherDetail })).toMatchObject({ applied: false, outcome: "conflict" });
    expect(await finish(a, userA, 1, "completed", { engine: "engine-v2" })).toMatchObject({ outcome: "conflict" });
    // 18. a failure after the stored success cannot erase it.
    expect(await finish(a, userA, 1, "failed")).toMatchObject({ applied: false, outcome: "conflict", status: "completed" });
    expect(await row(a)).toEqual(stored);
  });

  // ------------------------------------------------------- permissions

  it("19. the superseded 035 writers are not executable by any application role; the new writers still are (service_role only)", async () => {
    const a = await take(userA);
    for (const role of ["service_role", "authenticated", "anon"] as const) {
      const azure = await errorOf(rpcAs(owner, userA, "select fn_persist_azure_result($1, 0, 'failed')", [a], role));
      expect({ role, code: azure?.code }).toEqual({ role, code: "42501" });
      const wm = await errorOf(rpcAs(owner, userA, "select fn_persist_word_match_result($1, 0, 'failed')", [a], role));
      expect({ role, code: wm?.code }).toEqual({ role, code: "42501" });
    }
    expect(await begin(a)).toMatchObject({ admitted: true });
    for (const role of ["authenticated", "anon"] as const) {
      expect((await errorOf(rpcAs(owner, userA, BEGIN, [a, userA, 2], role)))?.code).toBe("42501");
    }
    // The functions still exist (nothing depends on dropping them).
    const defined = (await owner.query(
      "select count(*)::int n from pg_proc where proname in ('fn_persist_azure_result', 'fn_persist_word_match_result')"
    )).rows[0].n;
    expect(defined).toBe(2);
  });
});
