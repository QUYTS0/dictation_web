"use client";

/** A labeled 0-100 bar for one evaluation category (accuracy, fluency, etc).
 *  Renders nothing when the value is null — a category no evaluation
 *  produced a number for is omitted, never shown as a fake 0. */
export function MetricBar({ label, value }: { label: string; value: number | null }) {
  if (value === null) return null;
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-[11px]">
        <span className="font-medium text-[var(--text-muted)]">{label}</span>
        <span className="font-semibold text-[var(--text)]">{Math.round(clamped)}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface)]">
        <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${clamped}%` }} />
      </div>
    </div>
  );
}
