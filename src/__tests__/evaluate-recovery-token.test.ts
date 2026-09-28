import { NextRequest } from "next/server";

// Signed recovery token + POST /api/practice/evaluate/persist-recovery.
// Azure must NEVER be called here (it is mocked to fail loudly).
const serviceRpc = jest.fn();
const getUser = jest.fn();
const assessPronunciation = jest.fn(() => {
  throw new Error("recovery must not call Azure");
});

const reservePracticeQuota = jest.fn();
const recordPracticeUsage = jest.fn();
jest.mock("@/lib/azureSpeech", () => ({ assessPronunciation: () => assessPronunciation() }));
jest.mock("@/lib/practiceQuota", () => ({
  reservePracticeQuota: (...a: unknown[]) => reservePracticeQuota(...a),
  recordPracticeUsage: (...a: unknown[]) => recordPracticeUsage(...a),
}));
jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser } }),
  createServiceClient: () => ({ rpc: serviceRpc }),
}));

import { POST } from "@/app/api/practice/evaluate/persist-recovery/route";
import { issueRecoveryToken, verifyRecoveryToken, type RecoveryResult } from "@/lib/practice/recoveryToken";

const SECRET = "test-secret-that-is-long-enough-for-hmac-signing!!";
const ATTEMPT = "7b0c3b9e-0000-4000-8000-000000000001";
const RESULT: RecoveryResult = {
  pronunciationScore: 82,
  accuracyScore: 90,
  fluencyScore: 75,
  completenessScore: 100,
  prosodyScore: null,
  detail: { recognizedText: "hello", words: [] },
  engineVersion: "test",
};
const token = (over: Partial<{ userId: string; seq: number }> = {}, now?: number) =>
  issueRecoveryToken(SECRET, { userId: "user-1", attemptId: ATTEMPT, seq: 3, result: RESULT, ...over }, now);

function req(body: unknown) {
  return new NextRequest("http://localhost/api/practice/evaluate/persist-recovery", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.AZURE_RECOVERY_SIGNING_SECRET = SECRET;
  getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  serviceRpc.mockResolvedValue({ data: { applied: true, outcome: "applied", currentSeq: 3, status: "completed" }, error: null });
});

describe("token", () => {
  it("round-trips, and any change to payload or signature is rejected", () => {
    const t = token();
    expect(verifyRecoveryToken(SECRET, t).ok).toBe(true);
    const [part, sig] = t.split(".");
    const payload = JSON.parse(Buffer.from(part, "base64url").toString());
    payload.result.pronunciationScore = 100;
    const forged = `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${sig}`;
    expect(verifyRecoveryToken(SECRET, forged)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyRecoveryToken("another-secret-that-is-also-long-enough!!", t)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyRecoveryToken(SECRET, `${part}.`)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyRecoveryToken(SECRET, 42)).toEqual({ ok: false, reason: "malformed" });
  });

  it("expires after the TTL", () => {
    const issued = 1_000_000;
    const t = token({}, issued);
    expect(verifyRecoveryToken(SECRET, t, issued + 599).ok).toBe(true);
    expect(verifyRecoveryToken(SECRET, t, issued + 600)).toEqual({ ok: false, reason: "expired" });
  });
});

describe("persist-recovery route", () => {
  it("writes ONLY the signed result for the signed attempt/seq and never calls Azure", async () => {
    const res = await POST(req({ recoveryToken: token(), pronunciationScore: 100 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ persisted: true, attemptId: ATTEMPT, seq: 3, alreadySaved: false });
    expect(serviceRpc).toHaveBeenCalledTimes(1);
    expect(serviceRpc.mock.calls[0]).toEqual([
      "fn_finish_azure_evaluation",
      expect.objectContaining({
        p_attempt_id: ATTEMPT,
        p_user_id: "user-1",
        p_seq: 3,
        p_status: "completed",
        p_pronunciation_score: 82,
        p_prosody_score: null,
      }),
    ]);
    expect(assessPronunciation).not.toHaveBeenCalled();
  });

  it("a repeated valid recovery reports already saved (no second write happens in SQL)", async () => {
    serviceRpc.mockResolvedValueOnce({ data: { applied: false, outcome: "already_applied", currentSeq: 3, status: "completed" }, error: null });
    const json = await (await POST(req({ recoveryToken: token() }))).json();
    expect(json).toMatchObject({ persisted: true, alreadySaved: true });
  });

  it("13. rejects a tampered token (400)", async () => {
    const t = token();
    const tampered = t.slice(0, -2) + (t.endsWith("AA") ? "BB" : "AA");
    const res = await POST(req({ recoveryToken: tampered }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_recovery_token");
    expect(serviceRpc).not.toHaveBeenCalled();
  });

  it("13. rejects an expired token (410)", async () => {
    const res = await POST(req({ recoveryToken: token({}, Math.floor(Date.now() / 1000) - 601) }));
    expect(res.status).toBe(410);
    expect((await res.json()).code).toBe("recovery_token_expired");
    expect(serviceRpc).not.toHaveBeenCalled();
  });

  it("13. rejects another account's token (403) before any write", async () => {
    const res = await POST(req({ recoveryToken: token({ userId: "user-2" }) }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("recovery_account_mismatch");
    expect(serviceRpc).not.toHaveBeenCalled();
  });

  it("13. a superseded token (newer evaluation request) is refused with 409", async () => {
    serviceRpc.mockResolvedValueOnce({ data: { applied: false, outcome: "superseded", currentSeq: 4, status: "pending" }, error: null });
    const res = await POST(req({ recoveryToken: token() }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("recovery_superseded");
  });

  it("requires sign-in and the server secret", async () => {
    getUser.mockResolvedValueOnce({ data: { user: null } });
    expect((await POST(req({ recoveryToken: token() }))).status).toBe(401);
    delete process.env.AZURE_RECOVERY_SIGNING_SECRET;
    expect((await POST(req({ recoveryToken: "x.y" }))).status).toBe(503);
    expect(serviceRpc).not.toHaveBeenCalled();
  });

  it("a transient database error is reported retryable (500), token kept by the client", async () => {
    serviceRpc.mockResolvedValueOnce({ data: null, error: { code: "08006", message: "connection failure" } });
    expect((await POST(req({ recoveryToken: token() }))).status).toBe(500);
  });

  it("15. recovery (first write, replay, or refusal) never calls Azure and never checks or counts quota", async () => {
    await POST(req({ recoveryToken: token() }));
    serviceRpc.mockResolvedValueOnce({ data: { applied: false, outcome: "already_applied", currentSeq: 3, status: "completed" }, error: null });
    await POST(req({ recoveryToken: token() }));
    serviceRpc.mockResolvedValueOnce({ data: { applied: false, outcome: "conflict", currentSeq: 3, status: "completed" }, error: null });
    const conflict = await POST(req({ recoveryToken: token() }));
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).code).toBe("recovery_conflict");
    expect(assessPronunciation).not.toHaveBeenCalled();
    expect(reservePracticeQuota).not.toHaveBeenCalled();
    expect(recordPracticeUsage).not.toHaveBeenCalled();
  });
});
