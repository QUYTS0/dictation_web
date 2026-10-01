import { NextRequest } from "next/server";

// Route contract of /api/session/save-progress (authoritative writes only
// since Phase 8 — the pre-cutover legacy branch was removed).
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
import { saveProgress } from "@/app/dictation/[videoId]/api";

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
afterAll(() => {
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

describe("POST /api/session/save-progress — Phase 8 retirement", () => {
  it("a current client (position + identity only, no deprecated fields) saves its checkpoint", async () => {
    rpcMock.mockResolvedValue({ data: { roundId: "sess-1", applied: true, roundStatus: "active" }, error: null });
    const res = await POST(makeRequest({ sessionId: "sess-1", youtubeVideoId: "vid1", transcriptId: "rev-A", currentSegmentIndex: 2, videoCurrentTimeSec: 3 }));
    expect(res.status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith("fn_update_resume_position", {
      p_round_id: "sess-1",
      p_youtube_video_id: "vid1",
      p_segment_index: 2,
      p_video_current_time_sec: 3,
      p_expected_transcript_id: "rev-A",
    });
  });

  it("an old tab's first-touch save with status 'completed' gets/creates the active round and completes nothing", async () => {
    rpcMock.mockResolvedValue({ data: { roundId: "r1", created: false, roundStatus: "active" }, error: null });
    const res = await POST(makeRequest({ ...base, status: "completed" }));
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock.mock.calls[0][0]).toBe("fn_create_or_get_active_round");
    expect(rpcMock.mock.calls[0][1]).not.toHaveProperty("p_status");
    expect(await res.json()).toEqual({ sessionId: "r1", status: "active" });
  });

  it("a leftover PRACTICE_WRITE_PATH=legacy is ignored: the authoritative function is used, never a retired bridge", async () => {
    process.env.PRACTICE_WRITE_PATH = "legacy";
    rpcMock.mockResolvedValue({ data: { roundId: "sess-1", applied: true, roundStatus: "active" }, error: null });
    expect((await POST(makeRequest({ ...base, sessionId: "sess-1" }))).status).toBe(200);
    expect(rpcMock.mock.calls.map(([fn]) => fn)).toEqual(["fn_update_resume_position"]);
  });

  it("a legacy-gate refusal (legacy_writes_retired) still reads as retryable maintenance, never a 500", async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: "legacy_writes_retired" } });
    const res = await POST(makeRequest({ ...base, sessionId: "sess-1" }));
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });
});

describe("client saveProgress (Phase 8)", () => {
  it("sends only position and identity — no completion claim, accuracy or attempt count", async () => {
    const fetchMock = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ sessionId: "sess-1" }) }) as unknown as Response);
    const realFetch = global.fetch;
    global.fetch = fetchMock as unknown as typeof fetch;
    try {
      expect(await saveProgress("vid1", 3, 7.5, "sess-1", "rev-A")).toEqual({ sessionId: "sess-1" });
    } finally {
      global.fetch = realFetch;
    }
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/session/save-progress");
    expect(JSON.parse(init.body as string)).toEqual({
      sessionId: "sess-1",
      youtubeVideoId: "vid1",
      transcriptId: "rev-A",
      currentSegmentIndex: 3,
      videoCurrentTimeSec: 7.5,
    });
  });
});
