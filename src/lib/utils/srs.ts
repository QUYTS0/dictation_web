// =====================================================
// Spaced-repetition scheduling (simplified SM-2) for vocabulary review
// =====================================================

export type ReviewGrade = "again" | "hard" | "good" | "easy";

export interface SrsState {
  intervalDays: number;
  easeFactor: number;
  repetitions: number;
}

export interface SrsResult extends SrsState {
  nextReviewAt: Date;
}

const MIN_EASE_FACTOR = 1.3;
const DAY_MS = 24 * 60 * 60 * 1000;

const EASE_DELTA: Record<ReviewGrade, number> = {
  again: -0.3,
  hard: -0.15,
  good: 0,
  easy: 0.15,
};

/**
 * Computes the next review interval/ease/due-date for a vocabulary item
 * given how well it was recalled. "again" resets progress and schedules
 * the item for today; other grades grow the interval (SM-2-style).
 */
export function computeNextReview(
  state: SrsState,
  grade: ReviewGrade,
  now: Date = new Date()
): SrsResult {
  const easeFactor = Math.max(MIN_EASE_FACTOR, state.easeFactor + EASE_DELTA[grade]);

  let repetitions = state.repetitions;
  let intervalDays: number;

  if (grade === "again") {
    repetitions = 0;
    intervalDays = 0;
  } else {
    repetitions += 1;
    if (repetitions === 1) {
      intervalDays = 1;
    } else if (repetitions === 2) {
      intervalDays = 6;
    } else {
      intervalDays = Math.round(state.intervalDays * easeFactor);
    }
    if (grade === "easy") intervalDays = Math.round(intervalDays * 1.3);
    if (grade === "hard") intervalDays = Math.max(1, Math.round(intervalDays * 0.8));
  }

  return {
    intervalDays,
    easeFactor,
    repetitions,
    nextReviewAt: new Date(now.getTime() + intervalDays * DAY_MS),
  };
}
