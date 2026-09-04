"use client";

import { ChevronRight, Sparkles } from "lucide-react";
import type { ShadowingEvaluationSummary } from "../useShadowingEvaluations";
import { MetricBar } from "./MetricBar";

/**
 * Session-scoped summary over every SentenceEvaluation recorded so far this
 * video — updates live as more sentences are evaluated, not a separate
 * "end of session" event. See "Shadowing and Pronunciation Practice
 * Plan.md" §11. No blended "Overall Score" — each category that has data
 * shows its own bar; a category no evaluation produced (e.g. fluency/prosody
 * while only Word Match is wired up) is simply omitted, never shown as 0.
 */
export function EvaluationSessionSummary({
  summary,
  onJumpToSegment,
}: {
  summary: ShadowingEvaluationSummary;
  onJumpToSegment: (segmentIndex: number) => void;
}) {
  const {
    evaluatedCount,
    totalCount,
    notEvaluatedCount,
    weightedAccuracy,
    weightedCompleteness,
    weightedFluency,
    weightedProsody,
    problemWords,
    weakestSentences,
  } = summary;

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-2.5">
      <div className="flex flex-wrap items-center justify-between gap-1">
        <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-faint)]">
          <Sparkles size={12} /> Session summary
        </p>
        <span className="text-[11px] font-medium text-[var(--text-muted)]">
          {evaluatedCount} of {totalCount} sentence{totalCount !== 1 ? "s" : ""} evaluated
        </span>
      </div>

      {notEvaluatedCount > 0 && (
        <p className="text-[11px] text-[var(--text-faint)]">
          {notEvaluatedCount} sentence{notEvaluatedCount !== 1 ? "s" : ""} not evaluated
        </p>
      )}

      <div className="flex flex-col gap-2">
        <MetricBar label="Accuracy" value={weightedAccuracy} />
        <MetricBar label="Completeness" value={weightedCompleteness} />
        <MetricBar label="Fluency" value={weightedFluency} />
        <MetricBar label="Prosody" value={weightedProsody} />
      </div>

      {problemWords.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="text-[11px] font-semibold text-[var(--text-faint)]">Words to practice</p>
          <div className="flex flex-wrap gap-1.5">
            {problemWords.map((p) => (
              <span
                key={p.word}
                className="rounded-full border border-[var(--red)]/25 bg-[var(--red)]/[0.08] px-2 py-0.5 text-[11px] font-medium text-[var(--red)]"
              >
                {p.word}
                {p.count > 1 ? ` ×${p.count}` : ""}
              </span>
            ))}
          </div>
        </div>
      )}

      {weakestSentences.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="text-[11px] font-semibold text-[var(--text-faint)]">Needs more practice</p>
          <div className="flex flex-col gap-1">
            {weakestSentences.map((s) => (
              <button
                key={s.segmentIndex}
                type="button"
                onClick={() => onJumpToSegment(s.segmentIndex)}
                className="flex items-center justify-between gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-left text-[11px] transition-colors hover:bg-white/5"
              >
                <span className="min-w-0 flex-1 truncate text-[var(--text)]">{s.referenceText}</span>
                <span className="shrink-0 font-semibold text-[var(--text-muted)]">{Math.round(s.accuracy)}%</span>
                <ChevronRight size={12} className="shrink-0 text-[var(--text-faint)]" />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
