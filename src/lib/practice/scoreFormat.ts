/**
 * One display rule for ROUND-LEVEL score aggregates (averages over several
 * sentences) on every surface — practice summary, round report, History and
 * Dashboard: one decimal, rounded half away from zero, exactly like the
 * server's `round(…, 1)` in fn_shadowing_summary (migration 040). A server
 * value (already one decimal) formats unchanged, and a client-computed mean
 * formats to the same text, so the two surfaces never disagree by a point.
 *
 * The mean is rounded once, at display time (never intermediate values).
 * Float noise (84.45 computed as 84.4499999…) is removed by first fixing the
 * scaled value to 6 decimals. Single-result scores (one sentence's Azure
 * score) keep their whole-number display.
 */
export function roundAggregateScore(value: number): number {
  const scaled = Number((Math.abs(value) * 10).toFixed(6));
  return (Math.sign(value) * Math.round(scaled)) / 10;
}

export function formatAggregateScore(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return roundAggregateScore(value).toFixed(1);
}
