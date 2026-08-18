import { NextRequest } from "next/server";

const insertMock = jest.fn().mockResolvedValue({ error: null });
const fromMock = jest.fn().mockReturnValue({ insert: insertMock });

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
  createServiceClient: () => ({ from: fromMock }),
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
    insertMock.mockClear();
    fromMock.mockClear();
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

  it("logs the attempt when sessionId is provided and owned by the caller", async () => {
    await POST(
      makeRequest({
        sessionId: "session-1",
        segmentIndex: 2,
        userText: "he go to school",
        expectedText: "He goes to school.",
      })
    );
    expect(fromMock).toHaveBeenCalledWith("attempt_logs");
    expect(insertMock).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: "session-1", segment_index: 2 })
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
    expect(fromMock).not.toHaveBeenCalled();
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
    expect(fromMock).not.toHaveBeenCalled();
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
    expect(fromMock).not.toHaveBeenCalled();
  });
});
