import { NextRequest } from "next/server";

// PATCH /api/practice/attempt/[id]/word-match, GET /api/practice/attempt/[id],
// GET /api/practice/attempts?roundId= — route contracts (SQL verified in
// integration/phase4-shadowing.integration.test.ts).
const userRpc = jest.fn();
const serviceRpc = jest.fn();
const getUser = jest.fn();
const rows: Record<string, unknown> = {};

function builder(table: string) {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq"]) b[m] = () => b;
  b.maybeSingle = async () => ({ data: rows[table] ?? null, error: null });
  return b;
}

jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser }, rpc: userRpc, from: (t: string) => builder(t) }),
  createServiceClient: () => ({ rpc: serviceRpc }),
}));

import { PATCH } from "@/app/api/practice/attempt/[attemptId]/word-match/route";
import { GET as getAttempt } from "@/app/api/practice/attempt/[attemptId]/route";
import { GET as getRound } from "@/app/api/practice/attempts/route";

const ATTEMPT = "7b0c3b9e-0000-4000-8000-000000000001";
const ROUND = "7b0c3b9e-0000-4000-8000-000000000002";
const ctx = (attemptId = ATTEMPT) => ({ params: Promise.resolve({ attemptId }) });
const patch = (body: unknown) =>
  new NextRequest(`http://localhost/api/practice/attempt/${ATTEMPT}/word-match`, {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });

beforeEach(() => {
  jest.clearAllMocks();
  getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  rows.shadowing_attempts = { id: ATTEMPT, segment_id: "seg-1", transcript_id: "tr-1", segment_index: 4 };
  rows.transcript_segments = { text_raw: "Hello there, friend.", transcript_id: "tr-1", segment_index: 4 };
  serviceRpc.mockResolvedValue({ data: { applied: true, seq: 1, status: "completed" }, error: null });
});

describe("Word Match", () => {
  it("recomputes the scores from the PINNED sentence; client-sent scores are ignored", async () => {
    const res = await PATCH(patch({ status: "completed", recognizedText: "hello there", accuracy: 100, completeness: 100 }), ctx());
    expect(res.status).toBe(200);
    const args = serviceRpc.mock.calls[0][1];
    expect(serviceRpc.mock.calls[0][0]).toBe("fn_record_word_match");
    expect(args).toMatchObject({ p_attempt_id: ATTEMPT, p_user_id: "user-1", p_status: "completed" });
    expect(Math.round(args.p_accuracy)).toBe(67); // 2 of 3 words
    expect(Math.round(args.p_completeness)).toBe(67);
    expect(args.p_detail).toEqual({ recognizedText: "hello there", problemWords: [{ word: "friend", errorType: "missing" }] });
    expect(await res.json()).toMatchObject({ applied: true, seq: 1, problemWords: [{ word: "friend", errorType: "missing" }] });
  });

  it("stores failed/unsupported recognition without scores", async () => {
    await PATCH(patch({ status: "unsupported" }), ctx());
    expect(serviceRpc.mock.calls[0][1]).toMatchObject({ p_status: "unsupported", p_accuracy: null, p_completeness: null, p_detail: null });
  });

  it("another user's attempt is not found (owner RLS) — no write", async () => {
    rows.shadowing_attempts = null;
    expect((await PATCH(patch({ status: "completed", recognizedText: "x" }), ctx())).status).toBe(404);
    expect(serviceRpc).not.toHaveBeenCalled();
  });

  it("a segment that is not the attempt's pinned sentence is refused", async () => {
    rows.transcript_segments = { text_raw: "Other", transcript_id: "tr-2", segment_index: 4 };
    expect((await PATCH(patch({ status: "completed", recognizedText: "x" }), ctx())).status).toBe(409);
    expect(serviceRpc).not.toHaveBeenCalled();
  });

  it("validates input and maps a conflicting rewrite to 409", async () => {
    expect((await PATCH(patch({ status: "bogus" }), ctx())).status).toBe(400);
    expect((await PATCH(patch({ status: "completed" }), ctx())).status).toBe(400);
    expect((await PATCH(patch({ status: "completed", recognizedText: "x".repeat(2001) }), ctx())).status).toBe(400);
    expect((await PATCH(patch({ status: "failed" }), ctx("nope"))).status).toBe(400);
    serviceRpc.mockResolvedValueOnce({ data: null, error: { message: "word_match_already_recorded" } });
    expect((await PATCH(patch({ status: "completed", recognizedText: "hello" }), ctx())).status).toBe(409);
  });

  it("requires sign-in", async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    expect((await PATCH(patch({ status: "failed" }), ctx())).status).toBe(401);
  });
});

describe("reads", () => {
  it("GET attempt reads through the caller's RLS and lazily expires an overdue request for THAT seq only", async () => {
    userRpc.mockResolvedValueOnce({ data: { attemptId: ATTEMPT, azure: { status: "failed", errorReason: "expired", seq: 5 } }, error: null });
    serviceRpc.mockResolvedValueOnce({ data: { expired: true }, error: null });
    const res = await getAttempt(new NextRequest(`http://localhost/api/practice/attempt/${ATTEMPT}`), ctx());
    expect(res.status).toBe(200);
    expect(userRpc).toHaveBeenCalledWith("fn_get_shadowing_attempt", { p_attempt_id: ATTEMPT });
    expect(serviceRpc).toHaveBeenCalledWith("fn_expire_azure_evaluation", { p_attempt_id: ATTEMPT, p_user_id: "user-1", p_seq: 5 });
  });

  it("GET attempt does not expire anything that is not reported overdue", async () => {
    userRpc.mockResolvedValueOnce({ data: { attemptId: ATTEMPT, azure: { status: "pending", errorReason: null, seq: 5 } }, error: null });
    await getAttempt(new NextRequest(`http://localhost/api/practice/attempt/${ATTEMPT}`), ctx());
    expect(serviceRpc).not.toHaveBeenCalled();
  });

  it("GET attempt maps not-found", async () => {
    userRpc.mockResolvedValueOnce({ data: null, error: { message: "attempt_not_found" } });
    expect((await getAttempt(new NextRequest(`http://localhost/api/practice/attempt/${ATTEMPT}`), ctx())).status).toBe(404);
  });

  it("GET attempts is round-scoped and owner-only", async () => {
    userRpc.mockResolvedValueOnce({ data: { roundId: ROUND, segments: [] }, error: null });
    const res = await getRound(new NextRequest(`http://localhost/api/practice/attempts?roundId=${ROUND}`));
    expect(res.status).toBe(200);
    expect(userRpc).toHaveBeenCalledWith("fn_shadowing_round_results", { p_round_id: ROUND });
    expect((await getRound(new NextRequest("http://localhost/api/practice/attempts"))).status).toBe(400);
    userRpc.mockResolvedValueOnce({ data: null, error: { message: "round_not_found" } });
    expect((await getRound(new NextRequest(`http://localhost/api/practice/attempts?roundId=${ROUND}`))).status).toBe(404);
  });

  it("a server without migration 038 answers 503 evaluation_unavailable, not a crash", async () => {
    userRpc.mockResolvedValueOnce({ data: null, error: { code: "PGRST202", message: "Could not find the function" } });
    const res = await getRound(new NextRequest(`http://localhost/api/practice/attempts?roundId=${ROUND}`));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("evaluation_unavailable");
  });
});
