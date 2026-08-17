import { computeStreakDays } from "@/lib/utils/streak";

const now = new Date("2026-01-10T12:00:00.000Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000);

describe("computeStreakDays", () => {
  it("returns 0 for no activity", () => {
    expect(computeStreakDays([], now)).toBe(0);
  });

  it("counts 1 for activity only today", () => {
    expect(computeStreakDays([daysAgo(0)], now)).toBe(1);
  });

  it("counts consecutive days ending today", () => {
    const dates = [daysAgo(0), daysAgo(1), daysAgo(2)];
    expect(computeStreakDays(dates, now)).toBe(3);
  });

  it("still counts the streak if today has no activity yet but yesterday does", () => {
    const dates = [daysAgo(1), daysAgo(2)];
    expect(computeStreakDays(dates, now)).toBe(2);
  });

  it("breaks the streak on a gap day", () => {
    const dates = [daysAgo(0), daysAgo(1), daysAgo(3)];
    expect(computeStreakDays(dates, now)).toBe(2);
  });

  it("returns 0 when the last activity was 2+ days ago", () => {
    expect(computeStreakDays([daysAgo(2)], now)).toBe(0);
  });

  it("counts multiple timestamps on the same day as one day", () => {
    const sameDay1 = new Date(now.getTime());
    const sameDay2 = new Date(now.getTime() - 60 * 60 * 1000);
    expect(computeStreakDays([sameDay1, sameDay2], now)).toBe(1);
  });
});
