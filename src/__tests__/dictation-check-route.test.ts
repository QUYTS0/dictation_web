import { NextRequest } from "next/server";

const insertMock = jest.fn().mockResolvedValue({ error: null });
const fromMock = jest.fn().mockReturnValue({ insert: insertMock });

jest.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => ({ from: fromMock }),
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

  it("logs the attempt when sessionId is provided", async () => {
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
});
