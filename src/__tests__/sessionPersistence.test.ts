/**
 * Tests src/app/dictation/[videoId]/sessionPersistence.ts's identity
 * compatibility check — the guard that stops a sessionStorage snapshot from
 * being restored into a different user/revision context than the one it was
 * captured from (see the focused Phase 0 bug fix's audit of
 * "Apply snapshots only when their identity is compatible with the current
 * context" / "legacy snapshots missing identity metadata").
 */
import { isSnapshotCompatible, type DictationSessionSnapshot } from "@/app/dictation/[videoId]/sessionPersistence";

function baseSnapshot(overrides: Partial<DictationSessionSnapshot> = {}): DictationSessionSnapshot {
  return {
    videoId: "vid1",
    userId: "user-1",
    transcriptId: "rev-A",
    uxState: "paused_waiting_input",
    currentSegIdx: 3,
    checkResult: null,
    wrongAttempts: 0,
    hintLevel: 0,
    mistakes: [],
    previousReview: null,
    combo: 0,
    bestCombo: 0,
    cleanSolveCount: 0,
    isLastResultClean: false,
    previousRunSnapshot: null,
    firstAttemptBySegment: {},
    videoCurrentTimeSec: 12,
    inputState: null,
    sessionId: "sess-1",
    totalAttempts: 5,
    correctCount: 5,
    savedAt: Date.now(),
    ...overrides,
  };
}

describe("isSnapshotCompatible", () => {
  it("8. accepts a snapshot whose video/user/revision all match the current context", () => {
    const snap = baseSnapshot();
    expect(isSnapshotCompatible(snap, { videoId: "vid1", userId: "user-1", transcriptId: "rev-A" })).toBe(true);
  });

  it("rejects null (no snapshot present)", () => {
    expect(isSnapshotCompatible(null, { videoId: "vid1", userId: "user-1", transcriptId: "rev-A" })).toBe(false);
  });

  it("rejects a snapshot captured for a different video", () => {
    const snap = baseSnapshot({ videoId: "vid2" });
    expect(isSnapshotCompatible(snap, { videoId: "vid1", userId: "user-1", transcriptId: "rev-A" })).toBe(false);
  });

  it("rejects a snapshot captured under a different signed-in user (shared device/browser)", () => {
    const snap = baseSnapshot({ userId: "user-2" });
    expect(isSnapshotCompatible(snap, { videoId: "vid1", userId: "user-1", transcriptId: "rev-A" })).toBe(false);
  });

  it("rejects a snapshot captured against a different transcript revision than the one currently loaded", () => {
    const snap = baseSnapshot({ transcriptId: "rev-B" });
    expect(isSnapshotCompatible(snap, { videoId: "vid1", userId: "user-1", transcriptId: "rev-A" })).toBe(false);
  });

  it("accepts a matching guest snapshot (userId: null on both sides)", () => {
    const snap = baseSnapshot({ userId: null });
    expect(isSnapshotCompatible(snap, { videoId: "vid1", userId: null, transcriptId: "rev-A" })).toBe(true);
  });

  it("8. rejects a legacy snapshot missing userId/transcriptId entirely rather than guessing at its origin", () => {
    // Simulates JSON.parse of a snapshot written before identity scoping
    // existed — the fields are absent from the object, not merely null.
    const legacy = baseSnapshot() as unknown as Record<string, unknown>;
    delete legacy.userId;
    delete legacy.transcriptId;
    expect(
      isSnapshotCompatible(legacy as unknown as DictationSessionSnapshot, {
        videoId: "vid1",
        userId: "user-1",
        transcriptId: "rev-A",
      })
    ).toBe(false);
  });
});
