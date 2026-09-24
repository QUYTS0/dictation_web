import { NextRequest } from "next/server";

// Phase 2: save-progress/route.ts now delegates entirely to
// fn_legacy_save_progress (migration 035) via .rpc() — the transcript-pin
// validation, race-winner-reuse, and creation logic all moved into that
// SQL function (covered by src/__tests__/integration/phase2-schema.
// integration.test.ts against a real Postgres instance). These tests
// verify the route's own, narrower job: mapping the request body onto the
// RPC's parameters, and mapping the RPC's response/errors onto the HTTP
// response.
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

import { POST } from "@/app/api/session/save-progress/route";

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/session/save-progress", {
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

describe("POST /api/session/save-progress (Phase 2 — delegates to fn_legacy_save_progress)", () => {
  it("requires authentication before calling the RPC at all", async () => {
    getUserMock.mockResolvedValueOnce({ data: { user: null } });
    const res = await POST(makeRequest({ youtubeVideoId: "vid1", currentSegmentIndex: 0, accuracy: 0, totalAttempts: 0 }));
    expect(res.status).toBe(401);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("requires youtubeVideoId before calling the RPC", async () => {
    const res = await POST(makeRequest({ currentSegmentIndex: 0, accuracy: 0, totalAttempts: 0 }));
    expect(res.status).toBe(400);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("maps the request body onto fn_legacy_save_progress's exact parameter names", async () => {
    rpcMock.mockResolvedValue({ data: { sessionId: "sess-1", status: "active" }, error: null });
    await POST(
      makeRequest({
        sessionId: "sess-1",
        youtubeVideoId: "vid1",
        transcriptId: "rev-A",
        currentSegmentIndex: 4,
        videoCurrentTimeSec: 12.5,
        accuracy: 80,
        totalAttempts: 5,
        status: "active",
      })
    );
    expect(rpcMock).toHaveBeenCalledWith("fn_legacy_save_progress", {
      p_session_id: "sess-1",
      p_youtube_video_id: "vid1",
      p_transcript_id: "rev-A",
      p_current_segment_index: 4,
      p_video_current_time_sec: 12.5,
      p_accuracy: 80,
      p_total_attempts: 5,
      p_status: "active",
    });
  });

  it("defaults omitted optional fields to null rather than undefined", async () => {
    rpcMock.mockResolvedValue({ data: { sessionId: "sess-2", status: "active" }, error: null });
    await POST(makeRequest({ youtubeVideoId: "vid2", currentSegmentIndex: 0, accuracy: 0, totalAttempts: 0 }));
    const call = rpcMock.mock.calls[0][1];
    expect(call.p_session_id).toBeNull();
    expect(call.p_transcript_id).toBeNull();
  });

  it("returns the RPC's sessionId/status on success", async () => {
    rpcMock.mockResolvedValue({ data: { sessionId: "sess-3", status: "active" }, error: null });
    const res = await POST(makeRequest({ youtubeVideoId: "vid3", currentSegmentIndex: 0, accuracy: 0, totalAttempts: 0 }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toEqual({ sessionId: "sess-3", status: "active" });
  });

  it("maps a stale_transcript_revision RPC error to 409 with the stable code", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "stale_transcript_revision" } });
    const res = await POST(
      makeRequest({ youtubeVideoId: "vid4", transcriptId: "rev-A", currentSegmentIndex: 0, accuracy: 0, totalAttempts: 0 })
    );
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe("stale_transcript_revision");
  });

  it("maps a transcript_not_ready RPC error to 409 with the stable code", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "transcript_not_ready" } });
    const res = await POST(makeRequest({ youtubeVideoId: "vid5", currentSegmentIndex: 0, accuracy: 0, totalAttempts: 0 }));
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe("transcript_not_ready");
  });

  it("maps a write_gate_paused RPC error to a retryable 503 with Retry-After", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "write_gate_paused" } });
    const res = await POST(makeRequest({ youtubeVideoId: "vid6", currentSegmentIndex: 0, accuracy: 0, totalAttempts: 0 }));
    const json = await res.json();
    expect(res.status).toBe(503);
    expect(json.code).toBe("write_gate_paused");
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });

  it("maps an unrecognized RPC error to a generic 500, not a raw table-write fallback", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "some_unexpected_db_error" } });
    const res = await POST(makeRequest({ youtubeVideoId: "vid7", currentSegmentIndex: 0, accuracy: 0, totalAttempts: 0 }));
    expect(res.status).toBe(500);
  });
});
