import { NextRequest } from "next/server";

// Phase 2: session/restart/route.ts now delegates to fn_legacy_restart_round
// (migration 035) via .rpc().
const rpcMock = jest.fn();
const getUserMock = jest.fn(async (): Promise<{ data: { user: { id: string } | null } }> => ({
  data: { user: { id: "user-1" } },
}));

jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: getUserMock },
    rpc: rpcMock,
  }),
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
  getUserMock.mockClear();
  getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
});

describe("POST /api/session/restart (Phase 2 — delegates to fn_legacy_restart_round)", () => {
  it("requires videoId before calling the RPC", async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("requires authentication before calling the RPC", async () => {
    getUserMock.mockResolvedValueOnce({ data: { user: null } });
    const res = await POST(makeRequest({ videoId: "vid1" }));
    expect(res.status).toBe(401);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("calls fn_legacy_restart_round with the video id and optional session id", async () => {
    rpcMock.mockResolvedValue({ data: { status: "ok" }, error: null });
    await POST(makeRequest({ videoId: "vid1", sessionId: "sess-1" }));
    expect(rpcMock).toHaveBeenCalledWith("fn_legacy_restart_round", {
      p_youtube_video_id: "vid1",
      p_session_id: "sess-1",
    });
  });

  it("passes null when sessionId is omitted", async () => {
    rpcMock.mockResolvedValue({ data: { status: "ok" }, error: null });
    await POST(makeRequest({ videoId: "vid2" }));
    expect(rpcMock).toHaveBeenCalledWith("fn_legacy_restart_round", {
      p_youtube_video_id: "vid2",
      p_session_id: null,
    });
  });

  it("returns ok on success", async () => {
    rpcMock.mockResolvedValue({ data: { status: "ok" }, error: null });
    const res = await POST(makeRequest({ videoId: "vid3" }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toEqual({ status: "ok" });
  });

  it("maps a write_gate_paused RPC error to a retryable 503", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "write_gate_paused" } });
    const res = await POST(makeRequest({ videoId: "vid4" }));
    const json = await res.json();
    expect(res.status).toBe(503);
    expect(json.code).toBe("write_gate_paused");
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });

  it("maps an unrecognized RPC error to a generic 500", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "boom" } });
    const res = await POST(makeRequest({ videoId: "vid5" }));
    expect(res.status).toBe(500);
  });
});
