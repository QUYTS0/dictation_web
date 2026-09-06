"use client";

import { SEMANTIC_TEXT_CLASS, semanticTierFor } from "../evaluationFeedback";

/** Compact 2-column numeric grid replacing per-category progress bars —
 *  the number is always the primary signal; color (via semanticTierFor,
 *  the same scale used everywhere else in the tab) is a secondary,
 *  quick-scan cue, never the only one. A metric with no value is simply
 *  omitted from the grid, never shown as a fake 0; the whole grid renders
 *  nothing if every metric is missing. */
export function MetricGrid({ metrics }: { metrics: Array<{ label: string; value: number | null }> }) {
  const present = metrics.filter(
    (m): m is { label: string; value: number } => m.value !== null && m.value !== undefined
  );
  if (present.length === 0) return null;
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
      {present.map((m) => {
        const clamped = Math.max(0, Math.min(100, m.value));
        return (
          <div key={m.label} className="flex items-baseline justify-between gap-2">
            <span className="text-xs text-[var(--text-muted)]">{m.label}</span>
            <span className={`text-sm font-semibold tabular-nums ${SEMANTIC_TEXT_CLASS[semanticTierFor(clamped)]}`}>
              {Math.round(clamped)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
