"use client";

import { useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { AlertCircle, ArrowRight } from "lucide-react";
import type { ErrorType } from "@/lib/types";
import { errorTypeDescription, errorTypeLabel } from "@/lib/constants/errorTypes";
import { useDashboardMistakeExampleQuery } from "@/lib/queries/dashboard";
import { formatLastActive } from "@/lib/utils/time";

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

function ExamplePanel({ userId, errorType }: { userId: string | undefined; errorType: ErrorType }) {
  const example = useDashboardMistakeExampleQuery(userId, errorType);
  const label = errorTypeLabel(errorType);

  return (
    <div data-testid="mistake-example-panel" className="space-y-3 rounded-xl border border-line bg-surface p-4">
      <p className="text-xs font-bold uppercase tracking-wider text-ink">Example: {label}</p>
      <p className="text-xs leading-relaxed text-muted">{errorTypeDescription(errorType)}</p>
      {example.isPending ? (
        <div aria-busy="true" aria-label="Loading an example" className="h-16 animate-pulse rounded-lg bg-white" />
      ) : example.isError ? (
        <p className="text-xs text-muted">Couldn&apos;t load an example.</p>
      ) : !example.data ? (
        <p className="text-xs text-muted">No example to show for this type yet.</p>
      ) : (
        <>
          <dl data-testid="mistake-example" className="space-y-1.5 rounded-lg border border-line bg-white p-3 font-mono text-xs">
            <div className="flex items-start gap-2">
              <dt className="shrink-0 font-bold text-red-600">Your answer:</dt>
              <dd className="text-red-600 line-through decoration-red-300">&ldquo;{example.data.userText}&rdquo;</dd>
            </div>
            <div className="flex items-start gap-2">
              <dt className="shrink-0 font-bold text-emerald-700">Correct:</dt>
              <dd className="font-semibold text-emerald-700">&ldquo;{example.data.expectedText}&rdquo;</dd>
            </div>
          </dl>
          <p className="text-[11px] text-muted">
            {[example.data.videoTitle, formatLastActive(example.data.createdAt)].filter(Boolean).join(" · ")}
          </p>
          {example.data.explanation && (
            <div className="rounded-lg border border-line bg-white p-2.5 text-[11px] leading-relaxed text-ink">
              <p className="mb-0.5 font-semibold text-primary-600">Saved explanation</p>
              <p className="whitespace-pre-wrap">{example.data.explanation}</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * "Needs attention · error diagnostics" (plan §1): selectable frequency
 * bars, and for the selected type its meaning, the latest real mistake of
 * that type and its saved explanation, plus a link to all of them in
 * History (which reads `?errorType=`).
 */
export function NeedsAttentionCard({ userId, patterns, loading }: { userId: string | undefined; patterns: ErrorPattern[]; loading: boolean }) {
  const [selected, setSelected] = useState<ErrorType | null>(null);
  const active = patterns.find((p) => p.errorType === selected) ?? patterns[0] ?? null;

  return (
    <section
      aria-labelledby="needs-attention-heading"
      data-testid="needs-attention"
      className="@container rounded-2xl border border-line bg-white p-5 shadow-xs sm:p-6"
    >
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-danger/30 bg-danger/10 text-danger" aria-hidden="true">
            <AlertCircle size={16} />
          </span>
          <div>
            <h2 id="needs-attention-heading" className="text-base font-bold leading-tight text-ink">
              Needs attention
            </h2>
            {!loading && patterns.length > 0 && <p className="mt-0.5 text-xs text-muted">{mostCommonMistakeLine(patterns)}</p>}
          </div>
        </div>
        {active && (
          <Link
            href={`/history?errorType=${encodeURIComponent(active.errorType)}`}
            className="inline-flex items-center gap-1.5 rounded-xl bg-primary-600 px-4 py-2 text-xs font-bold text-white shadow-xs transition-colors hover:bg-primary-700"
          >
            Review {errorTypeLabel(active.errorType).toLowerCase()} mistakes <ArrowRight size={14} aria-hidden="true" />
          </Link>
        )}
      </div>

      {loading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : !active ? (
        <p className="text-sm text-muted">No mistakes recorded yet.</p>
      ) : (
        <div className="grid items-start gap-5 @3xl:grid-cols-12">
          <div className="space-y-2.5 @3xl:col-span-5">
            <p className="text-xs font-semibold text-muted">Mistakes by type</p>
            <ul className="space-y-2">
              {patterns.map((p) => {
                const isActive = p.errorType === active.errorType;
                return (
                  <li key={p.errorType}>
                    <button
                      type="button"
                      aria-pressed={isActive}
                      onClick={() => setSelected(p.errorType)}
                      className={clsx(
                        "w-full rounded-xl border p-3 text-left transition-colors",
                        isActive ? "border-primary-600 bg-surface" : "border-line hover:border-primary-500/40"
                      )}
                    >
                      <span className="mb-1.5 flex justify-between text-xs">
                        <span className="font-bold text-ink">{errorTypeLabel(p.errorType)}</span>
                        <span className="font-mono tabular-nums text-muted">
                          {p.count} ({p.percentage}%)
                        </span>
                      </span>
                      <span className="block h-1.5 w-full overflow-hidden rounded-full bg-line" aria-hidden="true">
                        <span
                          className={clsx("block h-full rounded-full", isActive ? "bg-primary-600" : "bg-muted/50")}
                          style={{ width: `${Math.min(100, Math.max(0, p.percentage))}%` }}
                        />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
          <div className="@3xl:col-span-7">
            <ExamplePanel userId={userId} errorType={active.errorType} />
          </div>
        </div>
      )}
    </section>
  );
}
