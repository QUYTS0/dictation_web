import type { ErrorType } from "@/lib/types";
import { errorTypeLabel } from "@/lib/constants/errorTypes";

interface ErrorPattern {
  errorType: ErrorType;
  count: number;
  percentage: number;
}

/**
 * Recorded Dictation mistake types, most common first (existing error-pattern
 * data). Descriptive only: the one sentence states which type is most common
 * — never a cause, a trend or a prescription.
 */
export function mostCommonMistakeLine(patterns: ErrorPattern[]): string | null {
  if (patterns.length === 0) return null;
  const max = Math.max(...patterns.map((p) => p.count));
  const top = patterns.filter((p) => p.count === max).map((p) => errorTypeLabel(p.errorType));
  if (top.length === 1) return `${top[0]} is your most common recorded mistake.`;
  if (top.length === patterns.length && top.length > 2) return "Your recorded mistakes are spread evenly across these types.";
  const names = top.map((l, i) => (i === 0 ? l : l.toLowerCase()));
  const list = `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${list} are your most common recorded mistakes.`;
}

export function NeedsAttentionCard({ patterns, loading }: { patterns: ErrorPattern[]; loading: boolean }) {
  return (
    <section aria-labelledby="needs-attention-heading" data-testid="needs-attention" className="flex h-full flex-col rounded-3xl border border-slate-200/70 bg-white/60 p-5 sm:p-6">
      <h2 id="needs-attention-heading" className="text-base font-semibold text-slate-900">
        Needs attention
      </h2>
      {loading ? (
        <p className="mt-3 text-sm text-slate-500">Loading…</p>
      ) : patterns.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">No mistakes recorded yet.</p>
      ) : (
        <>
          <p className="mt-1 text-sm text-slate-500">{mostCommonMistakeLine(patterns)}</p>
          <ul className="mt-4 flex flex-col gap-3.5">
            {patterns.map((p) => (
              <li key={p.errorType}>
                <div className="mb-1.5 flex justify-between text-sm">
                  <span className="font-medium text-slate-700">{errorTypeLabel(p.errorType)}</span>
                  <span className="tabular-nums text-slate-400">{p.count}</span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100" aria-hidden="true">
                  <div className="h-full rounded-full bg-primary-500/70" style={{ width: `${Math.min(100, Math.max(0, p.percentage))}%` }} />
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
