/**
 * Celebrations (plan §4.5.7): the first Dashboard visit after the daily
 * goal is met or a level is gained plays the confetti once and shows a
 * toast. Remembered per user in this browser (localStorage), so each goal
 * date and each level is celebrated once here — a second device may
 * celebrate it again (accepted, plan §7).
 */
export interface CelebrationMemory {
  /** The last local date whose met goal was celebrated. */
  goalDate: string | null;
  /** The last level seen (celebrated or the starting point). */
  level: number | null;
}

export interface CelebrationsDue {
  goal: boolean;
  /** The level just reached, or null. */
  levelUp: number | null;
  next: CelebrationMemory;
}

/**
 * Pure decision. The first time a level is seen it is only remembered — an
 * existing learner's current level is not a fresh level-up. A lower level
 * (a rules change, deleted practice) is followed silently.
 */
export function pickCelebrations(
  memory: CelebrationMemory,
  now: { today: string | null; goalMet: boolean; level: number | null }
): CelebrationsDue {
  const goal = !!now.today && now.goalMet && memory.goalDate !== now.today;
  const levelUp = now.level !== null && memory.level !== null && now.level > memory.level ? now.level : null;
  return {
    goal,
    levelUp,
    next: { goalDate: goal ? now.today : memory.goalDate, level: now.level ?? memory.level },
  };
}

const memoryKey = (userId: string) => `dictalearn:celebrations:${userId}`;

export function readCelebrationMemory(userId: string): CelebrationMemory {
  try {
    const raw = JSON.parse(window.localStorage.getItem(memoryKey(userId)) ?? "null") as Partial<CelebrationMemory> | null;
    return {
      goalDate: typeof raw?.goalDate === "string" ? raw.goalDate : null,
      level: typeof raw?.level === "number" ? raw.level : null,
    };
  } catch {
    return { goalDate: null, level: null };
  }
}

export function writeCelebrationMemory(userId: string, memory: CelebrationMemory): void {
  try {
    window.localStorage.setItem(memoryKey(userId), JSON.stringify(memory));
  } catch {
    // Storage unavailable (private mode, quota): celebrations may repeat — harmless.
  }
}

const recapKey = (userId: string) => `dictalearn:weekly-recap-seen:${userId}`;

/**
 * The Monday recap is shown on the first Dashboard visit of a league week.
 * Returns true (and remembers the week) the first time `weekStart` is
 * asked about for this user in this browser.
 */
export function claimWeeklyRecap(userId: string, weekStart: string): boolean {
  try {
    if (window.localStorage.getItem(recapKey(userId)) === weekStart) return false;
    window.localStorage.setItem(recapKey(userId), weekStart);
    return true;
  } catch {
    return false;
  }
}
