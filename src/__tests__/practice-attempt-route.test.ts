import { NextRequest } from "next/server";

// POST /api/practice/attempt — the route's own contract. The database
// behavior it delegates to (validity, idempotency, relationships,
// completion, attribution) is verified on real PostgreSQL in
// integration/phase4-shadowing.integration.test.ts.
const userRpc = jest.fn();
const getUser = jest.fn();

jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser }, rpc: userRpc }),
  createServiceClient: () => {
    throw new Error("the attempt route must never use the service role");
  },
}));

import { POST } from "@/app/api/practice/attempt/route";

const ROUND = "5a0c3b9e-0000-4000-8000-000000000001";
const TRANSCRIPT = "5a0c3b9e-0000-4000-8000-000000000002";
const CLIENT_ID = "5a0c3b9e-0000-4000-8000-000000000003";
const PROGRESS = {
  requiredSentenceCount: 3,
  coveredSentences: { dictation: 1, shadowing: 1, overall: 2 },
  coverage: { dictation: 0.3333, shadowing: 0.3333, overall: 0.6667 },
  attemptCount: 1,
  sentenceAccuracy: { correct: 1, practiced: 1, percent: 100 },
};
const RECORDED = {
  attemptId: "att-1",
  wasInserted: true,
  isPracticeValid: true,
  studySessionId: "ss-1",
  roundCompletedByThisRequest: false,
  roundStatus: "active",
  progress: PROGRESS,
};

function req(body: unknown) {
  return new NextRequest("http://localhost/api/practice/attempt", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}
const valid = { youtubeVideoId: "vid", roundId: ROUND, transcriptId: TRANSCRIPT, segmentIndex: 2, clientAttemptId: CLIENT_ID, recordingDurationSec: 2.5 };

beforeEach(() => {
  jest.clearAllMocks();
  getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  userRpc.mockImplementation(async (fn: string) =>
    fn === "fn_create_or_get_active_round" ? { data: { roundId: ROUND }, error: null } : { data: RECORDED, error: null }
  );
});

it("requires sign-in", async () => {
  getUser.mockResolvedValue({ data: { user: null } });
  expect((await POST(req(valid))).status).toBe(401);
  expect(userRpc).not.toHaveBeenCalled();
});

it.each([
  ["no clientAttemptId", { ...valid, clientAttemptId: undefined }],
  ["non-uuid clientAttemptId", { ...valid, clientAttemptId: "abc" }],
  ["no transcriptId", { ...valid, transcriptId: undefined }],
  ["negative segment", { ...valid, segmentIndex: -1 }],
  ["fractional segment", { ...valid, segmentIndex: 1.5 }],
  ["negative duration", { ...valid, recordingDurationSec: -1 }],
  ["absurd duration", { ...valid, recordingDurationSec: 10_000 }],
  ["bad roundId", { ...valid, roundId: "x" }],
])("rejects %s with 400", async (_label, body) => {
  expect((await POST(req(body))).status).toBe(400);
  expect(userRpc).not.toHaveBeenCalled();
});

it("records with the CALLER's client, passing only metadata; the server decides validity and completion", async () => {
  const res = await POST(req({ ...valid, isPracticeValid: true, audio: "ignored" }));
  expect(res.status).toBe(200);
  expect(userRpc).toHaveBeenCalledTimes(1);
  expect(userRpc).toHaveBeenCalledWith("fn_record_shadowing_attempt", {
    p_round_id: ROUND,
    p_youtube_video_id: "vid",
    p_segment_index: 2,
    p_client_attempt_id: CLIENT_ID,
    p_recording_duration_sec: 2.5,
    p_transcript_id: TRANSCRIPT,
    p_study_session_id: null,
  });
  expect(await res.json()).toEqual({
    attemptId: "att-1",
    clientAttemptId: CLIENT_ID,
    roundId: ROUND,
    wasInserted: true,
    isPracticeValid: true,
    studySessionId: "ss-1",
    roundCompletedByThisRequest: false,
    roundStatus: "active",
    progress: PROGRESS,
    coverage: PROGRESS.coverage,
  });
});

it("without a round, resolves the ACTIVE round first (shared with Dictation), pinned to the client's revision", async () => {
  const res = await POST(req({ ...valid, roundId: undefined }));
  expect(res.status).toBe(200);
  expect(userRpc.mock.calls[0]).toEqual(["fn_create_or_get_active_round", { p_youtube_video_id: "vid", p_expected_transcript_id: TRANSCRIPT }]);
  expect(userRpc.mock.calls[1][1]).toMatchObject({ p_round_id: ROUND });
  expect((await res.json()).roundId).toBe(ROUND);
});

it("a retry reports the stored attempt without re-reporting completion", async () => {
  userRpc.mockResolvedValueOnce({ data: { ...RECORDED, wasInserted: false, roundStatus: "completed" }, error: null });
  const json = await (await POST(req(valid))).json();
  expect(json).toMatchObject({ attemptId: "att-1", wasInserted: false, roundCompletedByThisRequest: false });
});

it.each([
  ["idempotency_key_reused_with_different_payload", 409],
  ["stale_transcript_revision", 409],
  ["segment_not_found", 409],
  ["study_session_mismatch", 409],
  ["round_not_found", 404],
  ["invalid_payload", 400],
  ["write_gate_paused", 503],
])("maps %s to %i and never reports a save", async (message, status) => {
  userRpc.mockResolvedValueOnce({ data: null, error: { message } });
  const res = await POST(req(valid));
  expect(res.status).toBe(status);
  const json = await res.json();
  expect(json.attemptId).toBeUndefined();
  if (status === 503) expect(json).toMatchObject({ code: "write_gate_paused", retryable: true });
});
