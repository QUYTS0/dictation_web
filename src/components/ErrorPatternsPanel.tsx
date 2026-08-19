import type { ErrorType } from "@/lib/types";
import { errorTypeLabel } from "@/lib/constants/errorTypes";

interface ErrorPattern {
  errorType: ErrorType;
  count: number;
  percentage: number;
}

export default function ErrorPatternsPanel({
  patterns,
  loading,
}: {
  patterns: ErrorPattern[];
  loading?: boolean;
}) {
  return (
    <section className="rounded-3xl border border-white/60 bg-white/50 p-4 shadow-xl backdrop-blur-md">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-900">
        Most Common Mistakes
      </h2>
      {loading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : patterns.length === 0 ? (
        <p className="text-sm text-slate-500">No mistakes logged yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {patterns.map((pattern) => (
            <li key={pattern.errorType}>
              <div className="mb-1 flex justify-between text-xs font-medium text-slate-600">
                <span>{errorTypeLabel(pattern.errorType)}</span>
                <span className="text-slate-400">{pattern.count}</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full rounded-full bg-primary-500"
                  style={{ width: `${Math.min(100, Math.max(0, pattern.percentage))}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
