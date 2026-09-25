import { NextRequest } from "next/server";

// Phase 2: the service-role write moved from a raw .from("attempt_logs")
// .insert() to .rpc("fn_legacy_record_dictation_attempt", ...) — see
// migration 035 / src/app/api/dictation/check/route.ts.
const rpcMock = jest.fn().mockResolvedValue({ data: { attemptId: "attempt-1" }, error: null });

const getUserMock = jest.fn().mockResolvedValue({ data: { user: { id: "user-1" } } });
const maybeSingleMock = jest.fn().mockResolvedValue({ data: { id: "session-1" } });
const ownershipFromMock = jest.fn().mockReturnValue({
  select: jest.fn().mockReturnValue({
    eq: jest.fn().mockReturnValue({
      eq: jest.fn().mockReturnValue({
        maybeSingle: maybeSingleMock,
      }),
    }),
  }),
});

jest.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => ({ rpc: rpcMock }),
  createClient: async () => ({
    auth: { getUser: getUserMock },
    from: ownershipFromMock,
  }),
}));

import { POST } from "@/app/api/dictation/check/route";

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/dictation/check", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("POST /api/dictation/check", () => {
  beforeEach(() => {
    rpcMock.mockClear();
    rpcMock.mockResolvedValue({ data: { attemptId: "attempt-1" }, error: null });
    ownershipFromMock.mockClear();
    getUserMock.mockClear();
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    maybeSingleMock.mockClear();
    maybeSingleMock.mockResolvedValue({ data: { id: "session-1" } });
  });

  it("returns 400 when userText/expectedText are missing", async () => {
    const res = await POST(makeRequest({ segmentIndex: 0 }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when segmentIndex is not a number", async () => {
    const res = await POST(
      makeRequest({ segmentIndex: "0", userText: "hi", expectedText: "hi" })
    );
    expect(res.status).toBe(400);
  });

  it("returns isCorrect=true for a matching relaxed answer", async () => {
    const res = await POST(
      makeRequest({
        segmentIndex: 0,
        userText: "hello world",
        expectedText: "Hello, world!",
        matchMode: "relaxed",
      })
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.isCorrect).toBe(true);
    expect(body.matchMode).toBe("relaxed");
  });

  it("falls back to relaxed mode for an invalid matchMode", async () => {
    const res = await POST(
      makeRequest({
        segmentIndex: 0,
        userText: "hello world",
        expectedText: "Hello, world!",
        matchMode: "bogus",
      })
    );
    const body = await res.json();
    expect(body.matchMode).toBe("relaxed");
  });

  it("logs the attempt via fn_legacy_record_dictation_attempt when sessionId is provided and owned by the caller", async () => {
    await POST(
      makeRequest({
        sessionId: "session-1",
        segmentIndex: 2,
        userText: "he go to school",
        expectedText: "He goes to school.",
      })
    );
    expect(rpcMock).toHaveBeenCalledWith(
      "fn_legacy_record_dictation_attempt",
      expect.objectContaining({ p_session_id: "session-1", p_segment_index: 2 })
    );
  });

  it("does not log an attempt when sessionId is absent", async () => {
    await POST(
      makeRequest({
        segmentIndex: 0,
        userText: "hello",
        expectedText: "hello",
      })
    );
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("does not log an attempt when the session is not owned by the caller", async () => {
    maybeSingleMock.mockResolvedValueOnce({ data: null });
    await POST(
      makeRequest({
        sessionId: "someone-elses-session",
        segmentIndex: 0,
        userText: "hello",
        expectedText: "hello",
      })
    );
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("does not log an attempt when the caller is unauthenticated", async () => {
    getUserMock.mockResolvedValueOnce({ data: { user: null } });
    await POST(
      makeRequest({
        sessionId: "session-1",
        segmentIndex: 0,
        userText: "hello",
        expectedText: "hello",
      })
    );
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("a paused write gate is non-fatal — the grading response is still returned", async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: "write_gate_paused" } });
    const res = await POST(
      makeRequest({
        sessionId: "session-1",
        segmentIndex: 0,
        userText: "hello world",
        expectedText: "Hello, world!",
      })
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.isCorrect).toBe(true);
  });
});
