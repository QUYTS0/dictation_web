import { NextRequest } from "next/server";

// Route-level behavior of /api/dictation/check in both deployment modes
// (src/lib/practice/writePath.ts). Database behavior itself (grading
// parity, idempotency, completion) is verified on real PostgreSQL in
// src/__tests__/integration/phase3-*.integration.test.ts — these tests
// cover the route's own contract: which client/RPC it uses, what it sends,
// and how it answers each outcome.
const userRpc = jest.fn();
const serviceRpc = jest.fn();
const getUser = jest.fn();
const ownsSession = jest.fn();

jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser }, rpc: userRpc }),
  createServiceClient: () => ({ rpc: serviceRpc }),
}));
jest.mock("@/lib/supabase/ownership", () => ({ ownsSession: (...a: unknown[]) => ownsSession(...a) }));

import { POST } from "@/app/api/dictation/check/route";

const ATTEMPT_ID = "0b6c1b4e-4d0f-4b8e-9c55-6f1d1d6c2a11";
const PROGRESS = {
  requiredSentenceCount: 3,
  coveredSentences: { dictation: 1, shadowing: 0, overall: 1 },
  coverage: { dictation: 0.3333, shadowing: 0, overall: 0.3333 },
  attemptCount: 1,
  sentenceAccuracy: { correct: 1, practiced: 1, percent: 100 },
};
const RECORDED = {
  attemptId: "att-1",
  wasInserted: true,
  isCorrect: true,
  errorType: "none",
  normalizedExpected: "hello world",
  normalizedUser: "hello world",
  studySessionId: "ss-1",
  roundCompletedByThisRequest: false,
  roundStatus: "active",
  progress: PROGRESS,
};

function req(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/dictation/check", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.PRACTICE_WRITE_PATH;
  getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  userRpc.mockResolvedValue({ data: RECORDED, error: null });
  serviceRpc.mockResolvedValue({ data: { attemptId: "x" }, error: null });
  ownsSession.mockResolvedValue(true);
});

describe("unrecorded checks (guest / no round)", () => {
  it("grades with the TypeScript checker against the client's expectedText and says it was not recorded", async () => {
    const res = await POST(req({ segmentIndex: 0, userText: "hello world", expectedText: "Hello, world!" }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ isCorrect: true, recorded: false });
    expect(userRpc).not.toHaveBeenCalled();
    expect(serviceRpc).not.toHaveBeenCalled();
  });

  it("a guest with a sessionId is graded but never recorded", async () => {
    getUser.mockResolvedValueOnce({ data: { user: null } });
    const res = await POST(req({ sessionId: "r1", segmentIndex: 0, userText: "x", expectedText: "y" }));
    expect((await res.json()).recorded).toBe(false);
    expect(userRpc).not.toHaveBeenCalled();
  });

  it("validates input", async () => {
    expect((await POST(req({ segmentIndex: -1, userText: "x", expectedText: "y" }))).status).toBe(400);
    expect((await POST(req({ segmentIndex: 0, expectedText: "y" }))).status).toBe(400);
    expect((await POST(req({ segmentIndex: 0, userText: "x" }))).status).toBe(400);
    expect((await POST(req({ sessionId: "r1", segmentIndex: 0, userText: "x", clientAttemptId: "not-a-uuid" }))).status).toBe(400);
    expect((await POST(req({ sessionId: "r1", segmentIndex: 0, userText: "x", hintLevelUsed: 7 }))).status).toBe(400);
  });
});

describe("authoritative path (default)", () => {
  it("records through fn_record_dictation_attempt with the CALLER's client and the full payload", async () => {
    const res = await POST(
      req({
        sessionId: "r1",
        segmentIndex: 2,
        userText: "hello world",
        expectedText: "IGNORED client text",
        clientAttemptId: ATTEMPT_ID,
        hintLevelUsed: 1,
        studySessionId: "ss-1",
        transcriptId: "t-1",
        youtubeVideoId: "vid",
      })
    );
    expect(res.status).toBe(200);
    expect(userRpc).toHaveBeenCalledWith("fn_record_dictation_attempt", {
      p_round_id: "r1",
      p_youtube_video_id: "vid",
      p_segment_index: 2,
      p_client_attempt_id: ATTEMPT_ID,
      p_user_text: "hello world",
      p_match_mode: "relaxed",
      p_transcript_id: "t-1",
      p_study_session_id: "ss-1",
      p_hint_level_used: 1,
    });
    expect(serviceRpc).not.toHaveBeenCalled();
    const json = await res.json();
    expect(json).toMatchObject({
      isCorrect: true,
      errorType: "none",
      recorded: true,
      attemptId: "att-1",
      clientAttemptId: ATTEMPT_ID,
      wasInserted: true,
      roundCompletedByThisRequest: false,
      roundStatus: "active",
      progress: PROGRESS,
      coverage: PROGRESS.coverage,
      studySessionId: "ss-1",
    });
    expect(json.diff).toEqual([
      { word: "hello", status: "correct" },
      { word: "world", status: "correct" },
    ]);
  });

  it("the database's verdict wins over anything the client could claim", async () => {
    userRpc.mockResolvedValueOnce({
      data: { ...RECORDED, isCorrect: false, errorType: "missing_word", normalizedUser: "hello" },
      error: null,
    });
    const json = await (await POST(req({ sessionId: "r1", segmentIndex: 0, userText: "hello", expectedText: "hello", isCorrect: true }))).json();
    expect(json.isCorrect).toBe(false);
    expect(json.errorType).toBe("missing_word");
  });

  it("old tabs: missing optional fields become null, and a server id is generated", async () => {
    await POST(req({ sessionId: "r1", segmentIndex: 0, userText: "hi", expectedText: "hi" }));
    const params = userRpc.mock.calls[0][1];
    expect(params).toMatchObject({ p_transcript_id: null, p_study_session_id: null, p_hint_level_used: null, p_youtube_video_id: null });
    expect(params.p_client_attempt_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("a retried submission returns the stored attempt (wasInserted false) and never re-reports completion", async () => {
    userRpc.mockResolvedValueOnce({ data: { ...RECORDED, wasInserted: false, roundCompletedByThisRequest: false, roundStatus: "completed" }, error: null });
    const json = await (await POST(req({ sessionId: "r1", segmentIndex: 0, userText: "hi", clientAttemptId: ATTEMPT_ID }))).json();
    expect(json).toMatchObject({ wasInserted: false, roundCompletedByThisRequest: false, roundStatus: "completed" });
  });

  it("sends the effective grading mode; reusing an attempt id under another mode is a 409 conflict, never a grade", async () => {
    await POST(req({ sessionId: "r1", segmentIndex: 0, userText: "hello", matchMode: "exact", clientAttemptId: ATTEMPT_ID }));
    expect(userRpc.mock.calls[0][1]).toMatchObject({ p_match_mode: "exact", p_client_attempt_id: ATTEMPT_ID });
    await POST(req({ sessionId: "r1", segmentIndex: 0, userText: "hello", matchMode: "bogus", clientAttemptId: ATTEMPT_ID }));
    expect(userRpc.mock.calls[1][1]).toMatchObject({ p_match_mode: "relaxed" });

    userRpc.mockResolvedValueOnce({ data: null, error: { message: "idempotency_key_reused_with_different_payload" } });
    const res = await POST(req({ sessionId: "r1", segmentIndex: 0, userText: "hello", matchMode: "relaxed", clientAttemptId: ATTEMPT_ID }));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.code).toBe("idempotency_key_reused_with_different_payload");
    expect(json.isCorrect).toBeUndefined();
    expect(json.recorded).toBeUndefined();
  });

  it("a retry reports the grading mode stored with the attempt", async () => {
    userRpc.mockResolvedValueOnce({ data: { ...RECORDED, wasInserted: false, isCorrect: false, errorType: "capitalization", matchMode: "exact" }, error: null });
    const json = await (await POST(req({ sessionId: "r1", segmentIndex: 0, userText: "hello", matchMode: "exact", clientAttemptId: ATTEMPT_ID }))).json();
    expect(json).toMatchObject({ wasInserted: false, isCorrect: false, matchMode: "exact" });
  });

  it("a maintenance pause is a retryable 503 — never a successful grade", async () => {
    userRpc.mockResolvedValueOnce({ data: null, error: { message: "write_gate_paused" } });
    const res = await POST(req({ sessionId: "r1", segmentIndex: 0, userText: "hi", clientAttemptId: ATTEMPT_ID }));
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    const json = await res.json();
    expect(json).toMatchObject({ code: "write_gate_paused", retryable: true });
    expect(json.isCorrect).toBeUndefined();
  });

  it("before activation (not granted yet), permission denied is reported as maintenance only when the DB confirms it", async () => {
    userRpc.mockImplementation(async (fn: string) =>
      fn === "fn_practice_write_status"
        ? { data: { available: false }, error: null }
        : { data: null, error: { code: "42501", message: "permission denied for function fn_record_dictation_attempt" } }
    );
    const res = await POST(req({ sessionId: "r1", segmentIndex: 0, userText: "hi" }));
    expect(res.status).toBe(503);
    expect(userRpc).toHaveBeenCalledWith("fn_practice_write_status");
  });

  it("permission denied while writes ARE available is a server error, not maintenance", async () => {
    userRpc.mockImplementation(async (fn: string) =>
      fn === "fn_practice_write_status"
        ? { data: { available: true }, error: null }
        : { data: null, error: { code: "42501", message: "permission denied" } }
    );
    expect((await POST(req({ sessionId: "r1", segmentIndex: 0, userText: "hi" }))).status).toBe(500);
  });

  it.each([
    ["stale_transcript_revision", 409],
    ["segment_not_found", 409],
    ["study_session_mismatch", 409],
    ["idempotency_key_reused_with_different_payload", 409],
    ["round_transcript_unknown", 409],
    ["round_not_found", 404],
    ["invalid_payload", 400],
    ["authentication_required", 401],
  ])("maps %s to %i with a stable code", async (message, status) => {
    userRpc.mockResolvedValueOnce({ data: null, error: { message } });
    const res = await POST(req({ sessionId: "r1", segmentIndex: 0, userText: "hi" }));
    expect(res.status).toBe(status);
  });
});

describe("legacy path (preparation release: PRACTICE_WRITE_PATH=legacy)", () => {
  beforeEach(() => {
    process.env.PRACTICE_WRITE_PATH = "legacy";
  });

  it("records through the Phase 2 bridge after verifying ownership with the caller's client", async () => {
    const json = await (await POST(req({ sessionId: "r1", segmentIndex: 0, userText: "hello", expectedText: "Hello." }))).json();
    expect(ownsSession).toHaveBeenCalled();
    expect(serviceRpc).toHaveBeenCalledWith("fn_legacy_record_dictation_attempt", expect.objectContaining({ p_session_id: "r1", p_is_correct: true }));
    expect(json).toMatchObject({ isCorrect: true, recorded: true });
    expect(userRpc).not.toHaveBeenCalled();
  });

  it("a paused gate is a retryable 503, not a success that silently wasn't saved", async () => {
    serviceRpc.mockResolvedValueOnce({ data: null, error: { message: "write_gate_paused" } });
    const res = await POST(req({ sessionId: "r1", segmentIndex: 0, userText: "hello", expectedText: "Hello." }));
    expect(res.status).toBe(503);
    expect((await res.json()).retryable).toBe(true);
  });

  it("a bridge refused by the retirement flag is also maintenance (503)", async () => {
    serviceRpc.mockResolvedValueOnce({ data: null, error: { message: "legacy_writes_retired" } });
    expect((await POST(req({ sessionId: "r1", segmentIndex: 0, userText: "a", expectedText: "a" }))).status).toBe(503);
  });

  it("an unowned session is graded but not recorded", async () => {
    ownsSession.mockResolvedValueOnce(false);
    const json = await (await POST(req({ sessionId: "r1", segmentIndex: 0, userText: "a", expectedText: "a" }))).json();
    expect(json.recorded).toBe(false);
    expect(serviceRpc).not.toHaveBeenCalled();
  });
});
