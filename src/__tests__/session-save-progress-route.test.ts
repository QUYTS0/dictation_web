import { NextRequest } from "next/server";

// Route contract of /api/session/save-progress in both deployment modes.
// The SQL functions' behavior (pin checks, atomic create, lifecycle
// protection) is verified on real PostgreSQL in
// src/__tests__/integration/phase3-authoritative.integration.test.ts.
const rpcMock = jest.fn();
const getUserMock = jest.fn(async (): Promise<{ data: { user: { id: string } | null } }> => ({
  data: { user: { id: "user-1" } },
}));

jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: getUserMock }, rpc: rpcMock }),
}));

import { POST } from "@/app/api/session/save-progress/route";

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/session/save-progress", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}
const base = { youtubeVideoId: "vid1", currentSegmentIndex: 4, videoCurrentTimeSec: 12.5, accuracy: 80, totalAttempts: 5 };

beforeEach(() => {
  rpcMock.mockReset();
  getUserMock.mockClear();
  getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
  delete process.env.PRACTICE_WRITE_PATH;
});

describe("POST /api/session/save-progress — authoritative (default)", () => {
  it("requires authentication and a video id before any RPC", async () => {
    getUserMock.mockResolvedValueOnce({ data: { user: null } });
    expect((await POST(makeRequest(base))).status).toBe(401);
    expect((await POST(makeRequest({ ...base, youtubeVideoId: undefined }))).status).toBe(400);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("a known round: updates only the checkpoint via fn_update_resume_position", async () => {
    rpcMock.mockResolvedValue({ data: { roundId: "sess-1", applied: true, roundStatus: "active" }, error: null });
    const res = await POST(makeRequest({ ...base, sessionId: "sess-1", transcriptId: "rev-A" }));
    expect(rpcMock).toHaveBeenCalledWith("fn_update_resume_position", {
      p_round_id: "sess-1",
      p_youtube_video_id: "vid1",
      p_segment_index: 4,
      p_video_current_time_sec: 12.5,
      p_expected_transcript_id: "rev-A",
    });
    expect(await res.json()).toEqual({ sessionId: "sess-1", status: "active" });
  });

  it("first touch: fn_create_or_get_active_round with the client's revision checked atomically", async () => {
    rpcMock.mockResolvedValue({ data: { roundId: "new", created: true, roundStatus: "active" }, error: null });
    const res = await POST(makeRequest({ ...base, transcriptId: "rev-A" }));
    expect(rpcMock).toHaveBeenCalledWith("fn_create_or_get_active_round", {
      p_youtube_video_id: "vid1",
      p_expected_transcript_id: "rev-A",
      p_segment_index: 4,
      p_video_current_time_sec: 12.5,
    });
    expect(await res.json()).toEqual({ sessionId: "new", status: "active" });
  });

  it("client counters and a client 'completed' status never reach the database", async () => {
    rpcMock.mockResolvedValue({ data: { roundId: "sess-1", applied: true, roundStatus: "active" }, error: null });
    const res = await POST(makeRequest({ ...base, sessionId: "sess-1", status: "completed", accuracy: 100, totalAttempts: 99 }));
    const params = rpcMock.mock.calls[0][1];
    expect(Object.keys(params)).not.toEqual(expect.arrayContaining(["p_status"]));
    expect(params).not.toHaveProperty("p_accuracy");
    expect(params).not.toHaveProperty("p_total_attempts");
    expect((await res.json()).status).toBe("active");
  });

  it("rejects a malformed checkpoint", async () => {
    expect((await POST(makeRequest({ ...base, currentSegmentIndex: -1 }))).status).toBe(400);
    expect((await POST(makeRequest({ ...base, currentSegmentIndex: 1.5 }))).status).toBe(400);
  });

  it.each([
    ["stale_transcript_revision", 409],
    ["transcript_not_ready", 409],
    ["round_not_found", 404],
    ["write_gate_paused", 503],
  ])("maps %s to %i", async (message, status) => {
    rpcMock.mockResolvedValue({ data: null, error: { message } });
    const res = await POST(makeRequest({ ...base, sessionId: "sess-1" }));
    expect(res.status).toBe(status);
  });
});

describe("POST /api/session/save-progress — legacy (preparation release)", () => {
  beforeEach(() => {
    process.env.PRACTICE_WRITE_PATH = "legacy";
  });

  it("maps onto fn_legacy_save_progress exactly as in Phase 2", async () => {
    rpcMock.mockResolvedValue({ data: { sessionId: "sess-1", status: "active" }, error: null });
    await POST(makeRequest({ ...base, sessionId: "sess-1", transcriptId: "rev-A", status: "active" }));
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

  it("maintenance (paused or retired bridge) is a retryable 503", async () => {
    for (const message of ["write_gate_paused", "legacy_writes_retired"]) {
      rpcMock.mockResolvedValueOnce({ data: null, error: { message } });
      const res = await POST(makeRequest(base));
      expect(res.status).toBe(503);
      expect(res.headers.get("Retry-After")).toBeTruthy();
    }
  });
});
