import { NextRequest } from "next/server";

// POST /api/practice/evaluate — attempt-scoped. Azure is MOCKED: no quota
// is spent. The lifecycle functions it calls are verified on real
// PostgreSQL in integration/phase4-shadowing.integration.test.ts.
const assessPronunciation = jest.fn();
const isAzureSpeechConfigured = jest.fn(() => true);
const reservePracticeQuota = jest.fn();
const recordPracticeUsage = jest.fn();
const serviceRpc = jest.fn();
const getUser = jest.fn();

jest.mock("@/lib/azureSpeech", () => {
  class AzureSpeechError extends Error {}
  return {
    assessPronunciation: (...a: unknown[]) => assessPronunciation(...a),
    isAzureSpeechConfigured: () => isAzureSpeechConfigured(),
    AzureSpeechError,
  };
});
jest.mock("@/lib/practiceQuota", () => ({
  reservePracticeQuota: (...a: unknown[]) => reservePracticeQuota(...a),
  recordPracticeUsage: (...a: unknown[]) => recordPracticeUsage(...a),
}));
jest.mock("@/lib/rateLimit", () => ({ checkRateLimit: async () => null }));
jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser } }),
  createServiceClient: () => ({ rpc: serviceRpc }),
}));

import { POST } from "@/app/api/practice/evaluate/route";
import { AzureSpeechError } from "@/lib/azureSpeech";
import { verifyRecoveryToken } from "@/lib/practice/recoveryToken";

const SECRET = "test-secret-that-is-long-enough-for-hmac-signing!!";
const ATTEMPT = "7b0c3b9e-0000-4000-8000-000000000001";
const AZURE = {
  pronScore: 82,
  accuracy: 90,
  fluency: 75,
  completeness: 100,
  prosody: null,
  words: [{ word: "hello", accuracyScore: 95, errorType: "None" }],
  recognizedText: "hello there",
  rawResult: { NBest: [] },
};

function form(fields: Record<string, string | Blob>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return new NextRequest("http://localhost/api/practice/evaluate", { method: "POST", body: fd });
}
const audio = () => new Blob([new Uint8Array(1000)], { type: "audio/wav" });
let finishResults: Array<{ data: unknown; error: unknown }>;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.AZURE_RECOVERY_SIGNING_SECRET = SECRET;
  isAzureSpeechConfigured.mockReturnValue(true);
  getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  reservePracticeQuota.mockResolvedValue({ allowed: true });
  assessPronunciation.mockResolvedValue(AZURE);
  finishResults = [];
  serviceRpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
    if (fn === "fn_begin_azure_evaluation") {
      return { data: { attemptId: ATTEMPT, seq: 3, referenceText: "Hello there.", recordingDurationSec: 2.5 }, error: null };
    }
    if (fn === "fn_finish_azure_evaluation") {
      if (args.p_status === "failed") return { data: { applied: true, outcome: "applied" }, error: null };
      return finishResults.shift() ?? { data: { applied: true, outcome: "applied", currentSeq: 3, status: "completed" }, error: null };
    }
    throw new Error(`unexpected rpc ${fn}`);
  });
});

const rpcNames = () => serviceRpc.mock.calls.map((c) => c[0]);

it("17. an old client without attemptId gets 409 stale_client_version / reload_required — nothing is spent or written", async () => {
  const res = await POST(form({ audio: audio(), referenceText: "anything", durationSec: "2" }));
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({ code: "stale_client_version", action: "reload_required" });
  expect(serviceRpc).not.toHaveBeenCalled();
  expect(assessPronunciation).not.toHaveBeenCalled();
});

it("refuses before spending anything when the recovery signing secret is missing", async () => {
  delete process.env.AZURE_RECOVERY_SIGNING_SECRET;
  const res = await POST(form({ attemptId: ATTEMPT, audio: audio() }));
  expect(res.status).toBe(503);
  expect(await res.json()).toMatchObject({ code: "evaluation_not_configured" });
  expect(serviceRpc).not.toHaveBeenCalled();
  expect(assessPronunciation).not.toHaveBeenCalled();
});

it("requires sign-in before any privileged write or provider call", async () => {
  getUser.mockResolvedValue({ data: { user: null } });
  expect((await POST(form({ attemptId: ATTEMPT, audio: audio() }))).status).toBe(401);
  expect(serviceRpc).not.toHaveBeenCalled();
  expect(assessPronunciation).not.toHaveBeenCalled();
});

it.each([
  ["attempt_not_found", 404],
  ["attempt_relationship_invalid", 409],
  ["reference_unavailable", 409],
  ["attempt_not_evaluable", 409],
  ["azure_already_evaluated", 409],
])("admission refused (%s → %i): Azure is never called", async (message, status) => {
  serviceRpc.mockResolvedValueOnce({ data: null, error: { message } });
  const res = await POST(form({ attemptId: ATTEMPT, audio: audio() }));
  expect(res.status).toBe(status);
  expect(assessPronunciation).not.toHaveBeenCalled();
});

it("5. scores against the SERVER-resolved sentence (client text ignored) and stores the result for this attempt+seq", async () => {
  const res = await POST(form({ attemptId: ATTEMPT, audio: audio(), referenceText: "Something the client made up" }));
  expect(res.status).toBe(200);
  expect(serviceRpc.mock.calls[0]).toEqual(["fn_begin_azure_evaluation", { p_attempt_id: ATTEMPT, p_user_id: "user-1" }]);
  expect(assessPronunciation.mock.calls[0][0].referenceText).toBe("Hello there.");
  // Quota is charged by the STORED duration.
  expect(reservePracticeQuota).toHaveBeenCalledWith(2.5);
  expect(recordPracticeUsage).toHaveBeenCalledWith(2.5);
  const finish = serviceRpc.mock.calls.find((c) => c[0] === "fn_finish_azure_evaluation")![1];
  expect(finish).toMatchObject({
    p_attempt_id: ATTEMPT,
    p_user_id: "user-1",
    p_seq: 3,
    p_status: "completed",
    p_pronunciation_score: 82,
    p_accuracy_score: 90,
    p_fluency_score: 75,
    p_completeness_score: 100,
    p_prosody_score: null, // unavailable stays unavailable, never 0
  });
  expect(finish.p_detail).toEqual({ recognizedText: "hello there", words: AZURE.words });
  expect(finish.p_detail.rawResult).toBeUndefined(); // raw provider payload is never stored
  const json = await res.json();
  expect(json).toMatchObject({ attemptId: ATTEMPT, seq: 3, persisted: true, pronScore: 82, prosody: null });
  expect(json.recoveryToken).toBeUndefined();
});

it("9. a response for a superseded request is returned as superseded, not saved, with no recovery token", async () => {
  finishResults.push({ data: { applied: false, outcome: "superseded", currentSeq: 4, status: "pending" }, error: null });
  const json = await (await POST(form({ attemptId: ATTEMPT, audio: audio() }))).json();
  expect(json).toMatchObject({ persisted: false, superseded: true });
  expect(json.recoveryToken).toBeUndefined();
});

it("11. a provider failure records a failed evaluation for this seq only and spends no quota", async () => {
  assessPronunciation.mockRejectedValueOnce(new AzureSpeechError("No speech was recognized in the recording."));
  const res = await POST(form({ attemptId: ATTEMPT, audio: audio() }));
  expect(res.status).toBe(502);
  expect((await res.json()).error).toBe("No speech was recognized in the recording.");
  const failed = serviceRpc.mock.calls.find((c) => c[0] === "fn_finish_azure_evaluation")![1];
  expect(failed).toMatchObject({ p_seq: 3, p_status: "failed", p_error_reason: "No speech was recognized in the recording." });
  expect(recordPracticeUsage).not.toHaveBeenCalled();
  // Practice credit is never touched by this route.
  expect(rpcNames()).not.toContain("fn_record_shadowing_attempt");
});

it("quota exhaustion is recorded as a failed evaluation before Azure is called", async () => {
  reservePracticeQuota.mockResolvedValueOnce({ allowed: false });
  const res = await POST(form({ attemptId: ATTEMPT, audio: audio() }));
  expect(res.status).toBe(429);
  expect(assessPronunciation).not.toHaveBeenCalled();
  expect(serviceRpc.mock.calls.find((c) => c[0] === "fn_finish_azure_evaluation")![1]).toMatchObject({ p_status: "failed", p_error_reason: "quota_exceeded" });
});

it("12. a database failure after a paid result: bounded retries, then persisted:false + a signed token bound to user/attempt/seq/result", async () => {
  for (let i = 0; i < 3; i++) finishResults.push({ data: null, error: { code: "08006", message: "connection failure" } });
  const res = await POST(form({ attemptId: ATTEMPT, audio: audio() }));
  const json = await res.json();
  expect(res.status).toBe(200);
  expect(json).toMatchObject({ persisted: false, pronScore: 82 });
  expect(rpcNames().filter((n) => n === "fn_finish_azure_evaluation")).toHaveLength(3);
  expect(assessPronunciation).toHaveBeenCalledTimes(1);
  const verified = verifyRecoveryToken(SECRET, json.recoveryToken);
  expect(verified.ok).toBe(true);
  if (verified.ok) {
    expect(verified.payload).toMatchObject({ userId: "user-1", attemptId: ATTEMPT, seq: 3, result: { pronunciationScore: 82, prosodyScore: null } });
    expect(verified.payload.exp - verified.payload.iat).toBe(600);
  }
  expect(typeof json.recoveryExpiresAt).toBe("string");
});

it("a result the database definitively rejects is reported unsaved WITHOUT a token", async () => {
  finishResults.push({ data: null, error: { message: "attempt_not_found" } });
  const json = await (await POST(form({ attemptId: ATTEMPT, audio: audio() }))).json();
  expect(json).toMatchObject({ persisted: false });
  expect(json.recoveryToken).toBeUndefined();
});

it("a missing headline score is a failed evaluation, not a zero", async () => {
  assessPronunciation.mockResolvedValueOnce({ ...AZURE, pronScore: null });
  const res = await POST(form({ attemptId: ATTEMPT, audio: audio() }));
  expect(res.status).toBe(502);
  expect(serviceRpc.mock.calls.find((c) => c[0] === "fn_finish_azure_evaluation")![1]).toMatchObject({ p_status: "failed", p_error_reason: "incomplete_result" });
});
