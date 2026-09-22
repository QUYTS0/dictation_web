import { NextRequest } from "next/server";

type QueryResult = { data?: unknown; error?: unknown };

function makeBuilder(result: QueryResult) {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  for (const method of ["select", "eq", "order", "limit"]) {
    builder[method] = jest.fn(chain);
  }
  builder.maybeSingle = jest.fn(() => Promise.resolve(result));
  return builder;
}

let queuedResult: QueryResult = { data: null, error: null };
const fromMock = jest.fn(() => makeBuilder(queuedResult));
const getUserMock = jest.fn(async () => ({ data: { user: { id: "user-1" } } }));

jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: getUserMock },
    from: () => fromMock(),
  }),
}));

import { GET } from "@/app/api/session/resume/route";

function makeRequest(videoId: string) {
  return new NextRequest(`http://localhost/api/session/resume?videoId=${encodeURIComponent(videoId)}`);
}

beforeEach(() => {
  fromMock.mockClear();
  getUserMock.mockClear();
  getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
  queuedResult = { data: null, error: null };
});

describe("GET /api/session/resume — Phase 0 pinned-revision exposure", () => {
  it("13. returns the session's pinned transcript_id", async () => {
    queuedResult = {
      data: {
        id: "sess-1",
        current_segment_index: 4,
        video_current_time: 12.5,
        accuracy: 80,
        total_attempts: 5,
        updated_at: "2024-01-01T00:00:00Z",
        status: "active",
        transcript_id: "rev-A",
      },
      error: null,
    };

    const res = await GET(makeRequest("vid1"));
    const json = await res.json();

    expect(json.session).toMatchObject({ sessionId: "sess-1", transcriptId: "rev-A" });
  });

  it("returns transcriptId: null for a legacy session row with no pinned revision, rather than omitting the field", async () => {
    queuedResult = {
      data: {
        id: "sess-2",
        current_segment_index: 0,
        video_current_time: 0,
        accuracy: 0,
        total_attempts: 0,
        updated_at: "2024-01-01T00:00:00Z",
        status: "active",
        transcript_id: null,
      },
      error: null,
    };

    const res = await GET(makeRequest("vid2"));
    const json = await res.json();

    expect(json.session.transcriptId).toBeNull();
  });

  it("returns session: null when no session exists", async () => {
    queuedResult = { data: null, error: null };
    const res = await GET(makeRequest("vid3"));
    const json = await res.json();
    expect(json.session).toBeNull();
  });
});
