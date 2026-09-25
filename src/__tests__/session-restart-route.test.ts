import { NextRequest } from "next/server";

const rpcMock = jest.fn();
const getUserMock = jest.fn(async (): Promise<{ data: { user: { id: string } | null } }> => ({
  data: { user: { id: "user-1" } },
}));

jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: getUserMock }, rpc: rpcMock }),
}));

import { POST } from "@/app/api/session/restart/route";

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/session/restart", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  rpcMock.mockReset();
  getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
  delete process.env.PRACTICE_WRITE_PATH;
});

describe("POST /api/session/restart — authoritative (default)", () => {
  it("requires videoId and authentication before any RPC", async () => {
    expect((await POST(makeRequest({}))).status).toBe(400);
    getUserMock.mockResolvedValueOnce({ data: { user: null } });
    expect((await POST(makeRequest({ videoId: "vid1" }))).status).toBe(401);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("calls fn_restart_round with the round being restarted and returns the new round", async () => {
    rpcMock.mockResolvedValue({
      data: { roundId: "new-round", transcriptId: "rev-B", created: true, roundNumber: 3 },
      error: null,
    });
    const res = await POST(makeRequest({ videoId: "vid1", sessionId: "old-round" }));
    expect(rpcMock).toHaveBeenCalledWith("fn_restart_round", { p_youtube_video_id: "vid1", p_expected_round_id: "old-round" });
    expect(await res.json()).toEqual({ status: "ok", sessionId: "new-round", transcriptId: "rev-B", created: true, roundNumber: 3 });
  });

  it("passes null when the client doesn't know its round", async () => {
    rpcMock.mockResolvedValue({ data: { roundId: "r", transcriptId: "t", created: true, roundNumber: 1 }, error: null });
    await POST(makeRequest({ videoId: "vid2" }));
    expect(rpcMock).toHaveBeenCalledWith("fn_restart_round", { p_youtube_video_id: "vid2", p_expected_round_id: null });
  });

  it.each([
    ["write_gate_paused", 503],
    ["transcript_not_ready", 409],
    ["boom", 500],
  ])("maps %s to %i", async (message, status) => {
    rpcMock.mockResolvedValue({ data: null, error: { message } });
    expect((await POST(makeRequest({ videoId: "vid" }))).status).toBe(status);
  });
});

describe("POST /api/session/restart — legacy (preparation release)", () => {
  beforeEach(() => {
    process.env.PRACTICE_WRITE_PATH = "legacy";
  });

  it("calls fn_legacy_restart_round exactly as in Phase 2", async () => {
    rpcMock.mockResolvedValue({ data: { status: "ok" }, error: null });
    const res = await POST(makeRequest({ videoId: "vid1", sessionId: "sess-1" }));
    expect(rpcMock).toHaveBeenCalledWith("fn_legacy_restart_round", { p_youtube_video_id: "vid1", p_session_id: "sess-1" });
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("maps a paused gate to a retryable 503", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "write_gate_paused" } });
    const res = await POST(makeRequest({ videoId: "vid4" }));
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });
});
