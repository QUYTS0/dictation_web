import { NextRequest } from "next/server";

type QueryResult = { data?: unknown; error?: unknown };

const responseQueues = new Map<string, QueryResult[]>();
function queueResponse(table: string, result: QueryResult) {
  const queue = responseQueues.get(table) ?? [];
  queue.push(result);
  responseQueues.set(table, queue);
}
function nextResponse(table: string): QueryResult {
  const queue = responseQueues.get(table) ?? [];
  return queue.shift() ?? { data: null, error: null };
}

function makeBuilder(table: string) {
  const result = nextResponse(table);
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  for (const method of ["select", "eq", "order", "limit"]) {
    builder[method] = jest.fn(chain);
  }
  builder.insert = jest.fn(chain);
  builder.update = jest.fn(chain);
  builder.maybeSingle = jest.fn(() => Promise.resolve(result));
  builder.single = jest.fn(() => Promise.resolve(result));
  builder.then = (resolve: (v: QueryResult) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return builder;
}

const fromMock = jest.fn((table: string) => makeBuilder(table));
const getUserMock = jest.fn(async () => ({ data: { user: { id: "user-1" } } }));

jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: getUserMock },
    from: (table: string) => fromMock(table),
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
  responseQueues.clear();
  fromMock.mockClear();
  getUserMock.mockClear();
  getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
});

describe("POST /api/session/save-progress — Phase 0 transcript pinning", () => {
  it("13. an update on an existing session (sessionId supplied) never writes transcript_id, even when the supplied id matches the pin", async () => {
    queueResponse("learning_sessions", { data: { id: "sess-1", transcript_id: "rev-A" }, error: null }); // pin lookup
    queueResponse("learning_sessions", { data: { id: "sess-1" }, error: null }); // update ... .single()

    const res = await POST(
      makeRequest({
        sessionId: "sess-1",
        youtubeVideoId: "vid1",
        transcriptId: "rev-A",
        currentSegmentIndex: 3,
        accuracy: 80,
        totalAttempts: 5,
      })
    );
    expect(res.status).toBe(200);

    const calls = fromMock.mock.calls.map((c, i) => ({ table: c[0], builder: fromMock.mock.results[i].value }));
    const updateCalls = calls.filter((c) => c.table === "learning_sessions" && (c.builder.update as jest.Mock).mock.calls.length > 0);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].builder.update.mock.calls[0][0]).not.toHaveProperty("transcript_id");
  });

  it("13. an update on an existing session omitting transcriptId still succeeds (compatibility — no identity to check)", async () => {
    queueResponse("learning_sessions", { data: { id: "sess-1", transcript_id: "rev-A" }, error: null }); // pin lookup
    queueResponse("learning_sessions", { data: { id: "sess-1" }, error: null }); // update ... .single()

    const res = await POST(
      makeRequest({
        sessionId: "sess-1",
        youtubeVideoId: "vid1",
        currentSegmentIndex: 3,
        accuracy: 80,
        totalAttempts: 5,
      })
    );
    expect(res.status).toBe(200);
  });

  it("13. an update on an existing session rejects a supplied transcriptId that mismatches the session's actual pin, without writing progress", async () => {
    queueResponse("learning_sessions", { data: { id: "sess-1", transcript_id: "rev-A" }, error: null }); // pin lookup

    const res = await POST(
      makeRequest({
        sessionId: "sess-1",
        youtubeVideoId: "vid1",
        transcriptId: "rev-B", // client believes it's on B; session is actually pinned to A
        currentSegmentIndex: 3,
        accuracy: 80,
        totalAttempts: 5,
      })
    );
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe("stale_transcript_revision");

    const calls = fromMock.mock.calls.map((c, i) => ({ table: c[0], builder: fromMock.mock.results[i].value }));
    const updateCalls = calls.filter((c) => c.table === "learning_sessions" && (c.builder.update as jest.Mock).mock.calls.length > 0);
    expect(updateCalls).toHaveLength(0);
  });

  it("13. an ordinary progress save for an already-active session never overwrites its pinned transcript_id", async () => {
    queueResponse("learning_sessions", { data: { id: "sess-2", transcript_id: "rev-A" }, error: null }); // existingActiveSession lookup
    queueResponse("learning_sessions", { data: { id: "sess-2" }, error: null }); // update ... .single()

    const res = await POST(
      makeRequest({
        youtubeVideoId: "vid2",
        transcriptId: "rev-A",
        currentSegmentIndex: 4,
        accuracy: 80,
        totalAttempts: 5,
      })
    );
    expect(res.status).toBe(200);

    const calls = fromMock.mock.calls.map((c, i) => ({ table: c[0], builder: fromMock.mock.results[i].value }));
    const updateCalls = calls.filter((c) => c.table === "learning_sessions" && (c.builder.update as jest.Mock).mock.calls.length > 0);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].builder.update.mock.calls[0][0]).not.toHaveProperty("transcript_id");
  });

  it("13. an ordinary progress save rejects a supplied transcriptId that mismatches the active session's pin, without writing progress", async () => {
    queueResponse("learning_sessions", { data: { id: "sess-2", transcript_id: "rev-A" }, error: null }); // existingActiveSession lookup

    const res = await POST(
      makeRequest({
        youtubeVideoId: "vid2",
        transcriptId: "rev-B", // stale: displayed/practiced against a different revision than the pin
        currentSegmentIndex: 4,
        accuracy: 80,
        totalAttempts: 5,
      })
    );
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe("stale_transcript_revision");

    const calls = fromMock.mock.calls.map((c, i) => ({ table: c[0], builder: fromMock.mock.results[i].value }));
    const updateCalls = calls.filter((c) => c.table === "learning_sessions" && (c.builder.update as jest.Mock).mock.calls.length > 0);
    expect(updateCalls).toHaveLength(0);
  });

  it("3. a first-touch session creation resolves transcript_id server-side from the current transcript, ignoring a matching client value", async () => {
    queueResponse("learning_sessions", { data: null, error: null }); // no existing active session
    queueResponse("transcripts", { data: { id: "current-rev" }, error: null }); // is_current lookup
    queueResponse("learning_sessions", { data: { id: "new-sess" }, error: null }); // insert

    const res = await POST(
      makeRequest({
        youtubeVideoId: "vid3",
        transcriptId: "current-rev",
        currentSegmentIndex: 0,
        accuracy: 0,
        totalAttempts: 0,
      })
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.sessionId).toBe("new-sess");

    const insertCalls = fromMock.mock.calls
      .map((c, i) => ({ table: c[0], builder: fromMock.mock.results[i].value }))
      .filter((c) => c.table === "learning_sessions" && (c.builder.insert as jest.Mock).mock.calls.length > 0);
    expect(insertCalls[0].builder.insert.mock.calls[0][0]).toMatchObject({ transcript_id: "current-rev" });
  });

  it("16. a first-touch session creation rejects a client-believed revision that no longer matches current (the regeneration race)", async () => {
    queueResponse("learning_sessions", { data: null, error: null }); // no existing active session
    queueResponse("transcripts", { data: { id: "revision-B" }, error: null }); // is_current is now B

    const res = await POST(
      makeRequest({
        youtubeVideoId: "vid4",
        transcriptId: "revision-A", // client displayed A, unaware B was just published
        currentSegmentIndex: 0,
        accuracy: 0,
        totalAttempts: 0,
      })
    );
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.code).toBe("stale_transcript_revision");

    // No insert ever happens for the mismatched request.
    const insertCalls = fromMock.mock.calls
      .map((c, i) => ({ table: c[0], builder: fromMock.mock.results[i].value }))
      .filter((c) => c.table === "learning_sessions" && (c.builder.insert as jest.Mock).mock.calls.length > 0);
    expect(insertCalls).toHaveLength(0);
  });

  it("a first-touch session creation with no ready current transcript is rejected rather than pinning null", async () => {
    queueResponse("learning_sessions", { data: null, error: null }); // no existing active session
    queueResponse("transcripts", { data: null, error: null }); // no current transcript yet

    const res = await POST(
      makeRequest({
        youtubeVideoId: "vid5",
        currentSegmentIndex: 0,
        accuracy: 0,
        totalAttempts: 0,
      })
    );
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.code).toBe("transcript_not_ready");
  });

  it("a first-touch session creation with no client-supplied transcriptId still resolves and pins the current revision", async () => {
    queueResponse("learning_sessions", { data: null, error: null });
    queueResponse("transcripts", { data: { id: "current-rev" }, error: null });
    queueResponse("learning_sessions", { data: { id: "new-sess-2" }, error: null });

    const res = await POST(
      makeRequest({
        youtubeVideoId: "vid6",
        currentSegmentIndex: 0,
        accuracy: 0,
        totalAttempts: 0,
      })
    );
    expect(res.status).toBe(200);

    const insertCalls = fromMock.mock.calls
      .map((c, i) => ({ table: c[0], builder: fromMock.mock.results[i].value }))
      .filter((c) => c.table === "learning_sessions" && (c.builder.insert as jest.Mock).mock.calls.length > 0);
    expect(insertCalls[0].builder.insert.mock.calls[0][0]).toMatchObject({ transcript_id: "current-rev" });
  });
});

describe("POST /api/session/save-progress — Phase 1 concurrent-first-save compatibility (migration 030)", () => {
  it("a concurrent first-save that loses the learning_sessions_one_active_per_video race reuses the winner's round instead of failing", async () => {
    queueResponse("learning_sessions", { data: null, error: null }); // no existing active session (checked before the race)
    queueResponse("transcripts", { data: { id: "current-rev" }, error: null }); // is_current lookup
    queueResponse("learning_sessions", {
      data: null,
      error: { code: "23505", message: 'duplicate key value violates unique constraint "learning_sessions_one_active_per_video"' },
    }); // insert loses the race
    queueResponse("learning_sessions", { data: { id: "winner-sess" }, error: null }); // post-conflict active lookup

    const res = await POST(
      makeRequest({
        youtubeVideoId: "vid7",
        currentSegmentIndex: 0,
        accuracy: 0,
        totalAttempts: 0,
      })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ sessionId: "winner-sess", status: "active" });
  });

  it("an insert failure unrelated to the unique constraint still reports a 500, not a false recovery", async () => {
    queueResponse("learning_sessions", { data: null, error: null }); // no existing active session
    queueResponse("transcripts", { data: { id: "current-rev" }, error: null }); // is_current lookup
    queueResponse("learning_sessions", { data: null, error: { code: "23503", message: "some other constraint" } }); // unrelated FK error

    const res = await POST(
      makeRequest({
        youtubeVideoId: "vid8",
        currentSegmentIndex: 0,
        accuracy: 0,
        totalAttempts: 0,
      })
    );

    expect(res.status).toBe(500);
  });
});
