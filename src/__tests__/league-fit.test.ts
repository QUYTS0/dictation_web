/**
 * @jest-environment node
 */
import { rowsThatFit } from "@/lib/leagues/fit";

// The League card's week rows: 54.5px tall, 4px apart; your own row after a 20px "···".
const ROW = 54.5;
const GAP = 4;
const week = (heightPx: number, youRank: number | null, min = 3) =>
  rowsThatFit({ heightPx, rowPx: ROW, gapPx: GAP, youExtraPx: 20 + ROW, youRank, min });

describe("rowsThatFit (plan D14)", () => {
  it("only whole rows: n rows take n·row + (n−1)·gap", () => {
    expect(week(8 * ROW + 7 * GAP, null)).toBe(8); // exactly 8
    expect(week(8 * ROW + 7 * GAP - 1, null)).toBe(7); // 1px short of the 8th
    expect(week(516, null)).toBe(8); // 516px: 8 rows take 464, a 9th needs 58.5 more
  });

  it("your row among the rows that fit needs no extra room", () => {
    expect(week(516, 8)).toBe(8);
    expect(week(516, 1)).toBe(8);
  });

  it("ranked below them, your row (and its ···) takes room from the top rows", () => {
    // 516 − 74.5 = 441.5 → 7 rows (7·54.5 + 6·4 = 405.5; 8 would be 464).
    expect(week(516, 12)).toBe(7);
    expect(week(516, 9)).toBe(7);
  });

  it("never fewer than the minimum, whatever the room", () => {
    expect(week(100, null)).toBe(3);
    expect(week(100, 20)).toBe(3);
    expect(week(0, null)).toBe(3);
    expect(week(-50, 4)).toBe(3);
  });

  it("unmeasured (no height or row height) → the minimum", () => {
    expect(rowsThatFit({ heightPx: NaN, rowPx: ROW, gapPx: GAP, youExtraPx: 0, youRank: null, min: 3 })).toBe(3);
    expect(rowsThatFit({ heightPx: 500, rowPx: 0, gapPx: GAP, youExtraPx: 0, youRank: null, min: 3 })).toBe(3);
  });

  it("a reserve below the rows (e.g. 'Updated hourly.') is kept free", () => {
    const allTime = (heightPx: number, youRank: number | null) =>
      rowsThatFit({ heightPx, rowPx: 50, gapPx: GAP, reservePx: 28, youExtraPx: GAP + 50, youRank, min: 3 });
    // 400 − 28 = 372 → 6 rows (6·50 + 5·4 = 320; 7 would be 374).
    expect(allTime(400, null)).toBe(6);
    // Ranked 14th: your row takes 54 more → 318 → 5 rows.
    expect(allTime(400, 14)).toBe(5);
  });
});
