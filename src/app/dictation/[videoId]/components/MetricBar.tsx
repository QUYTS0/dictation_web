"use client";

import { semanticTierFor, type SemanticTier } from "../evaluationFeedback";

const FILL_CLASS: Record<SemanticTier, string> = {
  strong: "bg-[var(--green)]",
  moderate: "bg-[var(--accent)]",
  weak: "bg-[var(--red)]",
};

const TEXT_CLASS: Record<SemanticTier, string> = {
  strong: "text-[var(--green)]",
  moderate: "text-[var(--text)]",
  weak: "text-[var(--red)]",
};

/** A labeled 0-100 bar for one evaluation category (accuracy, fluency, etc).
 *  Renders nothing when the value is null — a category no evaluation
 *  produced a number for is omitted, never shown as a fake 0. The fill color
 *  (and number color, for weak/strong) reflects semanticTierFor() so a
 *  learner gets a pass/fail-at-a-glance signal without losing the exact
 *  number — color is never the only signal. Pass `neutral` to always use
 *  the plain accent color (e.g. for a bar that isn't itself a score, if one
 *  is ever needed) instead of semantic coloring. */
export function MetricBar({
  label,
  value,
  neutral = false,
}: {
  label: string;
  value: number | null;
  neutral?: boolean;
}) {
  if (value === null) return null;
  const clamped = Math.max(0, Math.min(100, value));
  const tier = semanticTierFor(clamped);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-[11px]">
        <span className="font-medium text-[var(--text-muted)]">{label}</span>
        <span className={`font-semibold ${neutral ? "text-[var(--text)]" : TEXT_CLASS[tier]}`}>
          {Math.round(clamped)}%
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface)]">
        <div
          className={`h-full rounded-full ${neutral ? "bg-[var(--accent)]" : FILL_CLASS[tier]}`}
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}
