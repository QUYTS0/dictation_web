/**
 * How many top rows of a board fit the League card's list when the card runs
 * beside Continue and the review deck (plan D14): its height comes from those
 * two cards, so it shows as many WHOLE rows as fit — never a cut-off row, and
 * never fewer than `min`.
 *
 * - `heightPx`   the list area's height
 * - `rowPx`      one row's height; `gapPx` the space between rows
 * - `reservePx`  room always taken below the rows (e.g. "Updated hourly.")
 * - `youExtraPx` room the learner's own row takes when they rank below the
 *                rows shown (it is added after them, e.g. after a "···")
 * - `youRank`    the learner's rank, or null when they aren't on the board
 */
export function rowsThatFit({
  heightPx,
  rowPx,
  gapPx,
  reservePx = 0,
  youExtraPx,
  youRank,
  min,
}: {
  heightPx: number;
  rowPx: number;
  gapPx: number;
  reservePx?: number;
  youExtraPx: number;
  youRank: number | null;
  min: number;
}): number {
  if (!(heightPx > 0) || !(rowPx > 0)) return min;
  const slots = (h: number) => Math.max(0, Math.floor((h + gapPx) / (rowPx + gapPx)));
  const room = heightPx - reservePx;
  const all = slots(room);
  // Your row is among the rows that fit: nothing extra to make room for.
  if (youRank === null || youRank <= all) return Math.max(min, all);
  return Math.max(min, slots(room - youExtraPx));
}
