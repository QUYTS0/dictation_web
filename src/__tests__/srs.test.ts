import { computeNextReview, type SrsState } from "@/lib/utils/srs";

const freshState: SrsState = { intervalDays: 0, easeFactor: 2.5, repetitions: 0 };
const now = new Date("2026-01-01T00:00:00.000Z");

describe("computeNextReview", () => {
  it("schedules a new item 1 day out on first 'good'", () => {
    const result = computeNextReview(freshState, "good", now);
    expect(result.repetitions).toBe(1);
    expect(result.intervalDays).toBe(1);
  });

  it("schedules the second 'good' review 6 days out", () => {
    const afterFirst = computeNextReview(freshState, "good", now);
    const afterSecond = computeNextReview(afterFirst, "good", now);
    expect(afterSecond.repetitions).toBe(2);
    expect(afterSecond.intervalDays).toBe(6);
  });

  it("grows the interval using the ease factor on later reviews", () => {
    let state: SrsState = freshState;
    state = computeNextReview(state, "good", now);
    state = computeNextReview(state, "good", now);
    const third = computeNextReview(state, "good", now);
    expect(third.repetitions).toBe(3);
    expect(third.intervalDays).toBe(Math.round(6 * state.easeFactor));
  });

  it("resets repetitions and interval on 'again'", () => {
    let state: SrsState = freshState;
    state = computeNextReview(state, "good", now);
    state = computeNextReview(state, "good", now);
    const lapsed = computeNextReview(state, "again", now);
    expect(lapsed.repetitions).toBe(0);
    expect(lapsed.intervalDays).toBe(0);
  });

  it("lowers the ease factor on 'hard' and 'again', raises it on 'easy'", () => {
    const hard = computeNextReview(freshState, "hard", now);
    const again = computeNextReview(freshState, "again", now);
    const easy = computeNextReview(freshState, "easy", now);
    expect(hard.easeFactor).toBeLessThan(freshState.easeFactor);
    expect(again.easeFactor).toBeLessThan(hard.easeFactor);
    expect(easy.easeFactor).toBeGreaterThan(freshState.easeFactor);
  });

  it("never drops the ease factor below the floor", () => {
    let state: SrsState = freshState;
    for (let i = 0; i < 20; i++) {
      state = computeNextReview(state, "again", now);
    }
    expect(state.easeFactor).toBeGreaterThanOrEqual(1.3);
  });

  it("computes nextReviewAt as now + intervalDays", () => {
    const result = computeNextReview(freshState, "good", now);
    const expected = now.getTime() + 1 * 24 * 60 * 60 * 1000;
    expect(result.nextReviewAt.getTime()).toBe(expected);
  });
});
