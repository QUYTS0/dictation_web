import { QueryClient } from "@tanstack/react-query";
import { PracticeFlushCoordinator, type FlushIdentity } from "@/lib/practiceFlushCoordinator";
import { listeningProgressKeys } from "@/lib/queries/listeningProgress";
import type { ListeningProgressResponse } from "@/lib/practice/listeningTypes";

// Plan §11.6 / §6.3b: the app-level coordinator that owns unsent Listening
// and activity data. fetch is mocked; nothing leaves the process.
const A: FlushIdentity = { userId: "user-a", videoId: "vid", transcriptId: "tr-1", roundId: "round-1" };
const B: FlushIdentity = { userId: "user-b", videoId: "vid", transcriptId: "tr-1", roundId: "round-9" };
const KEY_A = listeningProgressKeys.progress("user-a", "vid", "tr-1");

const ok = (body: unknown = { processed: true, studySessionId: "sess-1", attribution: "current" }) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const status = (code: number) => ({ ok: false, status: code, json: async () => ({}) }) as unknown as Response;
const bodyOf = (call: unknown[]) => JSON.parse((call[1] as RequestInit).body as string);
const listeningOk = (over: Record<string, unknown> = {}) =>
  ok({ processed: true, coverageRatio: 0.2, listenedThrough: false, coveredSec: 6, lastPositionSec: 12, hasHistory: true, transcriptCoveredSec: 30, studySessionId: "s", attribution: "current", ...over });

function setup() {
  const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>();
  let now = 1_000_000;
  const clock = { advance: (ms: number) => (now += ms) };
  const coordinator = new PracticeFlushCoordinator(fetchMock, () => now);
  const qc = new QueryClient();
  const invalidate = jest.spyOn(qc, "invalidateQueries");
  coordinator.setQueryClient(qc);
  coordinator.setAuthUser("user-a");
  return { fetchMock, coordinator, qc, invalidate, clock };
}

describe("PracticeFlushCoordinator", () => {
  beforeEach(() => jest.spyOn(console, "warn").mockImplementation(() => {}));
  afterEach(() => jest.restoreAllMocks());

  it("sends buffered listening intervals raw (not merged) with the identity captured at record time — including the round", async () => {
    const { fetchMock, coordinator } = setup();
    fetchMock.mockResolvedValue(listeningOk());
    coordinator.record("listening", A, [{ start: 0, end: 5 }, { start: 0, end: 5 }], 12);
    await coordinator.requestFlush("periodic");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/listening/sync");
    expect(init.method).toBe("POST");
    expect(bodyOf(fetchMock.mock.calls[0])).toMatchObject({
      videoId: "vid",
      transcriptId: "tr-1",
      roundId: "round-1",
      intervals: [{ start: 0, end: 5 }, { start: 0, end: 5 }],
      currentPositionSec: 12,
      observedAgeSec: 0,
    });
    expect(bodyOf(fetchMock.mock.calls[0])).not.toHaveProperty("studySessionId"); // the client never picks a session
    expect(coordinator.pendingBatchCount).toBe(0);
  });

  it("a retry sends the SAME batch id and the SAME payload; only the observation age grows; nothing is patched or invalidated until success", async () => {
    const { fetchMock, coordinator, qc, invalidate, clock } = setup();
    fetchMock.mockRejectedValueOnce(new TypeError("offline")).mockResolvedValueOnce(status(503)).mockResolvedValue(listeningOk({ coverageRatio: 0.5, coveredSec: 10 }));
    coordinator.record("listening", A, [{ start: 0, end: 10 }], 10);
    await coordinator.requestFlush("navigation");
    clock.advance(40_000);
    await coordinator.requestFlush("navigation");
    expect(invalidate).not.toHaveBeenCalled();
    expect(qc.getQueryData(KEY_A)).toBeUndefined();
    clock.advance(20_000);
    await coordinator.requestFlush("navigation");
    const bodies = fetchMock.mock.calls.map(bodyOf);
    expect(bodies.map((b) => b.observedAgeSec)).toEqual([0, 40, 60]);
    const stripAge = (b: Record<string, unknown>) => ({ ...b, observedAgeSec: undefined });
    expect(stripAge(bodies[1])).toEqual(stripAge(bodies[0]));
    expect(stripAge(bodies[2])).toEqual(stripAge(bodies[0]));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["dashboard-summary", "user-a"] });
    expect(qc.getQueryData(KEY_A)).toMatchObject({ coverageRatio: 0.5, coveredSec: 10 });
  });

  it("a sealed activity batch keeps the timezone captured when it was sealed — a later browser zone only affects new batches", async () => {
    const { fetchMock, coordinator, clock } = setup();
    let zone = "Asia/Ho_Chi_Minh";
    const real = Intl.DateTimeFormat.prototype.resolvedOptions;
    jest.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(function (this: Intl.DateTimeFormat) {
      return { ...real.call(this), timeZone: zone };
    });
    fetchMock.mockRejectedValueOnce(new TypeError("offline")).mockResolvedValue(ok());
    const act = { ...A, transcriptId: null };
    coordinator.record("activity", act, [{ start: 1_000, end: 1_030 }]);
    await coordinator.requestFlush("periodic"); // fails after sealing
    zone = "America/New_York"; // the device moved / the zone changed after midnight
    clock.advance(3_600_000);
    await coordinator.requestFlush("periodic"); // the retry
    coordinator.record("activity", act, [{ start: 4_700, end: 4_730 }]);
    await coordinator.requestFlush("periodic");
    const bodies = fetchMock.mock.calls.map(bodyOf);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(Array(3).fill("/api/study-session/activity"));
    expect(bodies.map((b) => b.clientTimezone)).toEqual(["Asia/Ho_Chi_Minh", "Asia/Ho_Chi_Minh", "America/New_York"]);
    expect(bodies[1].flushBatchId).toBe(bodies[0].flushBatchId);
    expect(bodies[1].intervals).toEqual(bodies[0].intervals);
    expect(bodies[2].flushBatchId).not.toBe(bodies[0].flushBatchId);
  });

  it("observations that arrive while a batch is in flight never alter it — they become the next batch", async () => {
    const { fetchMock, coordinator } = setup();
    let resolve!: (r: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => (resolve = r))).mockResolvedValue(listeningOk());
    coordinator.record("listening", A, [{ start: 0, end: 15 }], 15);
    const first = coordinator.requestFlush("periodic");
    await Promise.resolve();
    const inFlightBody = (fetchMock.mock.calls[0][1] as RequestInit).body;
    coordinator.record("listening", A, [{ start: 15, end: 20 }], 20); // new observation during the send
    const second = coordinator.requestFlush("periodic");
    expect((fetchMock.mock.calls[0][1] as RequestInit).body).toBe(inFlightBody);
    expect(bodyOf(fetchMock.mock.calls[0]).intervals).toEqual([{ start: 0, end: 15 }]);
    resolve(listeningOk());
    await Promise.all([first, second]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [b1, b2] = fetchMock.mock.calls.map(bodyOf);
    expect(b2.intervals).toEqual([{ start: 15, end: 20 }]);
    expect(b2.flushBatchId).not.toBe(b1.flushBatchId);
  });

  it("observations made under different rounds (before/after a Restart) never share a batch", async () => {
    const { fetchMock, coordinator } = setup();
    fetchMock.mockResolvedValue(listeningOk());
    coordinator.record("listening", A, [{ start: 0, end: 5 }], 5);
    coordinator.record("listening", { ...A, roundId: "round-2" }, [{ start: 5, end: 9 }], 9);
    coordinator.record("listening", { ...A, roundId: null }, [{ start: 9, end: 11 }], 11);
    await coordinator.requestFlush("mode");
    const sent = fetchMock.mock.calls.map(bodyOf).map((b) => [b.roundId, b.intervals[0].start]);
    expect(sent).toEqual([["round-1", 0], ["round-2", 5], [null, 9]]);
  });

  it("a refused batch (4xx) is dropped, not retried forever", async () => {
    const { fetchMock, coordinator } = setup();
    fetchMock.mockResolvedValueOnce(status(409)).mockResolvedValue(ok());
    coordinator.record("activity", A, [{ start: 100, end: 110 }]);
    await coordinator.requestFlush("periodic");
    await coordinator.requestFlush("periodic");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(coordinator.pendingBatchCount).toBe(0);
  });

  it("nothing buffered → no request at all (route changes on Dashboard/History send nothing)", async () => {
    const { fetchMock, coordinator } = setup();
    await coordinator.requestFlush("navigation");
    await coordinator.requestFlush("visibility");
    coordinator.record("activity", A, []); // an empty activity hand-over
    coordinator.record("listening", A, [], null); // opened Listening, never played: no checkpoint
    await coordinator.requestFlush("navigation");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(coordinator.pendingBatchCount).toBe(0);
  });

  it("navigation while a periodic send is in flight waits for it, then invalidates only after it succeeded (#75/#65)", async () => {
    const { fetchMock, coordinator, invalidate } = setup();
    let resolve!: (r: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => (resolve = r)));
    coordinator.record("listening", A, [{ start: 0, end: 15 }], 15);
    const periodic = coordinator.requestFlush("periodic");
    const navigation = coordinator.requestFlush("navigation"); // buffer already empty
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1); // no second request for the same data
    expect(invalidate).not.toHaveBeenCalled();
    resolve(listeningOk({ coverageRatio: 0.1, coveredSec: 3, lastPositionSec: 15 }));
    await Promise.all([periodic, navigation]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["dashboard-summary", "user-a"] });
  });

  it("navigation / visibility flushes use keepalive; periodic ones don't", async () => {
    const { fetchMock, coordinator } = setup();
    fetchMock.mockResolvedValue(ok());
    coordinator.record("activity", A, [{ start: 1, end: 2 }]);
    await coordinator.requestFlush("periodic");
    coordinator.record("activity", A, [{ start: 3, end: 4 }]);
    await coordinator.requestFlush("visibility");
    expect(fetchMock.mock.calls.map((c) => c[1].keepalive)).toEqual([false, true]);
  });

  it("account switch: another account's unsent data is never sent under the new account and nothing of B is touched (#77)", async () => {
    const { fetchMock, coordinator, qc, invalidate } = setup();
    fetchMock.mockResolvedValue(status(503));
    coordinator.record("listening", A, [{ start: 0, end: 10 }], 10);
    await coordinator.requestFlush("periodic"); // fails, stays pending for A
    coordinator.record("listening", A, [{ start: 10, end: 12 }], 12); // still only buffered
    coordinator.setAuthUser("user-b");
    expect(coordinator.pendingBatchCount).toBe(0); // A's pending batch and buffer are gone
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(listeningOk({ coverageRatio: 0.9, listenedThrough: true }));
    coordinator.record("listening", A, [{ start: 12, end: 20 }], 20); // late observation from A's page: ignored
    await coordinator.requestFlush("navigation");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
    expect(qc.getQueryData(listeningProgressKeys.progress("user-b", "vid", "tr-1"))).toBeUndefined();
    coordinator.record("listening", B, [{ start: 0, end: 5 }], 5);
    await coordinator.requestFlush("periodic");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bodyOf(fetchMock.mock.calls[0])).toMatchObject({ roundId: "round-9", intervals: [{ start: 0, end: 5 }] });
  });

  it("a response arriving after sign-out patches and invalidates nothing", async () => {
    const { fetchMock, coordinator, qc, invalidate } = setup();
    let resolve!: (r: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => (resolve = r)));
    coordinator.record("listening", A, [{ start: 0, end: 10 }], 10);
    const pending = coordinator.requestFlush("navigation");
    await Promise.resolve();
    coordinator.setAuthUser(null);
    resolve(listeningOk({ coverageRatio: 1, listenedThrough: true, coveredSec: 30 }));
    await pending;
    expect(qc.getQueryData(KEY_A)).toBeUndefined();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("the cache patch carries exactly what the server stored (checkpoint, history, denominator), in send order", async () => {
    const { fetchMock, coordinator, qc } = setup();
    fetchMock
      .mockResolvedValueOnce(listeningOk({ coveredSec: 10, coverageRatio: 1 / 3, lastPositionSec: 48, transcriptCoveredSec: 30 }))
      .mockResolvedValueOnce(listeningOk({ coveredSec: 10, coverageRatio: 1 / 3, lastPositionSec: 3, transcriptCoveredSec: 30 }));
    coordinator.record("listening", A, [{ start: 40, end: 48 }], 48);
    await coordinator.requestFlush("periodic");
    expect(qc.getQueryData<ListeningProgressResponse>(KEY_A)).toMatchObject({ lastPositionSec: 48, hasHistory: true, transcriptCoveredSec: 30, coveredSec: 10 });
    coordinator.record("listening", A, [{ start: 0, end: 3 }], 3); // went back: the checkpoint moves backward
    await coordinator.requestFlush("periodic");
    expect(qc.getQueryData<ListeningProgressResponse>(KEY_A)).toMatchObject({ lastPositionSec: 3, coveredSec: 10 });
  });

  it("a progress read that started before the sync committed cannot overwrite the newer patch", async () => {
    const { fetchMock, coordinator, qc } = setup();
    let answerRead!: (v: ListeningProgressResponse) => void;
    const stale = qc
      .fetchQuery({ queryKey: KEY_A, queryFn: () => new Promise<ListeningProgressResponse>((r) => (answerRead = r)) })
      .catch(() => undefined); // cancelled reads reject
    fetchMock.mockResolvedValue(listeningOk({ coveredSec: 20, coverageRatio: 2 / 3, lastPositionSec: 30 }));
    coordinator.record("listening", A, [{ start: 20, end: 30 }], 30);
    await coordinator.requestFlush("periodic");
    answerRead({ videoId: "vid", transcriptId: "tr-1", coveredSec: 0, transcriptCoveredSec: 30, coverageRatio: 0, listenedThrough: false, listenedThroughAt: null, lastPositionSec: 0, hasHistory: false });
    await stale;
    await Promise.resolve();
    expect(qc.getQueryData<ListeningProgressResponse>(KEY_A)).toMatchObject({ coveredSec: 20, lastPositionSec: 30, hasHistory: true });
  });

  it("the first listened-through response invalidates the Dashboard once; a later one doesn't", async () => {
    const { fetchMock, coordinator, invalidate } = setup();
    fetchMock.mockResolvedValue(listeningOk({ coverageRatio: 0.92, listenedThrough: true, coveredSec: 28 }));
    coordinator.record("listening", A, [{ start: 0, end: 28 }], 28);
    await coordinator.requestFlush("periodic");
    coordinator.record("listening", A, [{ start: 28, end: 29 }], 29);
    await coordinator.requestFlush("periodic");
    const dashboardCalls = invalidate.mock.calls.filter(([arg]) => JSON.stringify(arg?.queryKey) === '["dashboard-summary","user-a"]');
    expect(dashboardCalls).toHaveLength(1);
  });

  it("Phase 6: partial Listening progress marks the Library stale (not the Dashboard); an unchanged response marks nothing", async () => {
    const { fetchMock, coordinator, invalidate } = setup();
    fetchMock.mockResolvedValue(listeningOk({ coverageRatio: 0.25, listenedThrough: false, coveredSec: 10, lastPositionSec: 10 }));
    coordinator.record("listening", A, [{ start: 0, end: 10 }], 10);
    await coordinator.requestFlush("periodic");
    const keys = () => invalidate.mock.calls.map(([arg]) => JSON.stringify(arg?.queryKey));
    expect(keys()).toEqual(['["video-library","user-a"]']);
    coordinator.record("listening", A, [{ start: 0, end: 10 }], 10); // a replay: same coverage, same checkpoint
    await coordinator.requestFlush("periodic");
    expect(keys()).toEqual(['["video-library","user-a"]']);
  });

  it("Phase 6: a navigation flush invalidates Dashboard, Library and History — only after the write succeeded, only for its own user", async () => {
    const { fetchMock, coordinator, invalidate } = setup();
    let answer!: (r: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => (answer = r)));
    coordinator.record("activity", A, [{ start: 100, end: 120 }]);
    const done = coordinator.requestFlush("navigation");
    await Promise.resolve();
    expect(invalidate).not.toHaveBeenCalled();
    answer(ok());
    await done;
    expect(invalidate.mock.calls.map(([arg]) => JSON.stringify(arg?.queryKey)).sort()).toEqual([
      '["dashboard-summary","user-a"]',
      '["history-sessions","user-a"]',
      '["video-library","user-a"]',
    ]);
  });

  it("the unsent queue keeps at most MAX_PENDING_BUFFER_SEC (300 s) of listening: under sustained failure the oldest is dropped", async () => {
    const { fetchMock, coordinator } = setup();
    fetchMock.mockResolvedValue(status(503));
    for (let i = 0; i < 12; i++) {
      coordinator.record("listening", A, [{ start: i * 30, end: i * 30 + 30 }], i * 30 + 30);
      await coordinator.requestFlush("periodic");
    }
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(ok());
    await coordinator.requestFlush("periodic");
    const sent = fetchMock.mock.calls.map((c) => bodyOf(c).intervals[0].start);
    // 360 s were observed; 60 s are lost for good — the bound limits the queue, not the loss.
    expect(sent).toEqual([60, 90, 120, 150, 180, 210, 240, 270, 300, 330]);
  });

  it("flushWithin never waits longer than its bound", async () => {
    const { fetchMock, coordinator } = setup();
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    coordinator.record("activity", A, [{ start: 1, end: 2 }]);
    const started = Date.now();
    await coordinator.flushWithin("signout", 50);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
