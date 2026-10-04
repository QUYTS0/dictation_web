"use client";

import { useState } from "react";
import { BarChart3, ChevronDown, ChevronRight, Sparkles, TrendingUp } from "lucide-react";
import type { ShadowingRoundSummary } from "@/lib/practice/shadowingSummary";
import { formatAggregateScore } from "@/lib/practice/scoreFormat";
import { PriorityList, detailStatement } from "@/components/report/ShadowingSummaryView";
import { useEvaluationSummaryCollapsedPreference } from "../useEvaluationSummaryCollapsedPreference";
import { MetricGrid } from "./MetricGrid";
import { VideoPracticeSummaryModal } from "./VideoPracticeSummaryModal";

const WEAKEST_SENTENCE_INITIAL_LIMIT = 2;
const IMPROVEMENTS_SHOWN = 2;

const LEVEL_LABEL = { great: "Great improvement", nice: "Nice improvement", improving: "Improving" } as const;

/**
 * Compact summary of the CURRENT ROUND's Shadowing evidence — every saved
 * result of the round across all its study sessions (restored from the
 * server), not just this visit. Built by the shared summary builder
 * (src/lib/practice/shadowingSummary.ts) that every round report also uses.
 * No blended "overall" score: each Azure metric with data shows its own
 * round average (one decimal, the shared display rule); a metric no
 * evaluation produced is omitted, never 0. Collapsed by default so the
 * current sentence stays the primary content; the full view opens in the
 * "Round summary" dialog.
 */
export function EvaluationSessionSummary({
  summary,
  onJumpToSegment,
}: {
  summary: ShadowingRoundSummary;
  onJumpToSegment: (segmentIndex: number) => void;
}) {
  const { collapsed, setCollapsed } = useEvaluationSummaryCollapsedPreference();
  const [showAllWeakestSentences, setShowAllWeakestSentences] = useState(false);
  const [showRoundSummary, setShowRoundSummary] = useState(false);

  const { coverage, metrics, detail, priorities, weakestSentences } = summary;
  const scored = coverage.scoredSentences;
  const eligible = coverage.eligibleSentences;
  // Unknown or zero denominator → a count, no percentage, never "complete".
  const coveragePct = eligible !== null && eligible > 0 ? Math.min(100, Math.round((scored / eligible) * 100)) : null;
  const visibleWeakestSentences = showAllWeakestSentences ? weakestSentences : weakestSentences.slice(0, WEAKEST_SENTENCE_INITIAL_LIMIT);
  const usedFallbackScore = weakestSentences.some((s) => s.usedFallbackScore);
  const improvements = [...summary.wordImprovements, ...summary.sentenceImprovements].slice(0, IMPROVEMENTS_SHOWN);
  const detailText = detailStatement(summary);

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-2.5">
      <button
        type="button"
        onClick={() => setCollapsed(!collapsed)}
        aria-expanded={!collapsed}
        aria-controls="evaluation-session-summary-body"
        className="flex w-full min-h-[36px] items-center justify-between gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] rounded-lg"
      >
        <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--text-faint)]">
          <ChevronDown
            size={13}
            className={`shrink-0 transition-transform motion-reduce:transition-none ${collapsed ? "-rotate-90" : ""}`}
          />
          <Sparkles size={12} /> This round
        </span>
        <span className="text-xs font-medium text-[var(--text-muted)] tabular-nums" aria-live="polite">
          {coveragePct === null ? `${scored} scored` : `${scored}/${eligible} scored · ${coveragePct}%`}
        </span>
      </button>

      {!collapsed && (
        <div id="evaluation-session-summary-body" className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold text-[var(--text-faint)]">Round averages</p>
              <button
                type="button"
                onClick={() => setShowRoundSummary(true)}
                className="flex min-h-[28px] items-center gap-1 rounded-lg px-1.5 text-xs font-semibold text-[var(--accent)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              >
                <BarChart3 size={12} /> Round summary
              </button>
            </div>
            <MetricGrid
              format={formatAggregateScore}
              metrics={[
                { label: "Accuracy", value: metrics.accuracy?.value ?? null },
                { label: "Fluency", value: metrics.fluency?.value ?? null },
                { label: "Completeness", value: metrics.completeness?.value ?? null },
                { label: "Prosody", value: metrics.prosody?.value ?? null },
              ]}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <p className="text-xs font-semibold text-[var(--text-faint)]">Words to practice</p>
            {detailText && <p className="text-xs text-[var(--text-faint)]">{detailText}</p>}
            {detail.scoredWithWordDetail === 0 ? null : priorities.length === 0 ? (
              <p className="text-xs text-[var(--text-faint)]">
                No words were flagged in the {detail.scoredWithWordDetail} scored sentence{detail.scoredWithWordDetail === 1 ? "" : "s"} with word-level
                feedback.
              </p>
            ) : (
              <PriorityList priorities={priorities} onOpenSentence={onJumpToSegment} />
            )}
          </div>

          {improvements.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <p className="text-xs font-semibold text-[var(--text-faint)]">Improvement on the same sentence</p>
              <div className="flex flex-col gap-1">
                {improvements.map((i) => (
                  <button
                    key={`${i.kind === "word" ? `w${i.position}` : "s"}-${i.segmentIndex}`}
                    type="button"
                    onClick={() => onJumpToSegment(i.segmentIndex)}
                    className="flex min-h-[36px] flex-col gap-0.5 rounded-lg border border-[var(--green)]/25 bg-[var(--green)]/[0.08] px-2 py-1.5 text-left text-xs"
                  >
                    <span className="flex items-center gap-1 font-semibold text-[var(--green)]">
                      <TrendingUp size={12} /> {LEVEL_LABEL[i.level]}
                    </span>
                    <span className="truncate text-[var(--text)]">
                      {i.kind === "word" ? `“${i.word}” · ` : ""}sentence {i.segmentIndex + 1}{" "}
                      <span className="text-[var(--text-muted)]">
                        {Math.round(i.fromScore)} → {Math.round(i.toScore)}
                        {i.sinceFirstResult ? "" : " (recent)"}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <p className="text-xs font-semibold text-[var(--text-faint)]">
              Lowest-scoring sentences
              {weakestSentences.length > 0 && (
                <span className="ml-1 font-normal normal-case text-[var(--text-faint)]">
                  (sorted by Azure pronunciation score{usedFallbackScore ? "*" : ""})
                </span>
              )}
            </p>
            {weakestSentences.length === 0 ? (
              <p className="text-xs text-[var(--text-faint)]">No sentences scored yet.</p>
            ) : (
              <>
                <div className="flex flex-col gap-1">
                  {visibleWeakestSentences.map((s) => (
                    <button
                      key={s.segmentIndex}
                      type="button"
                      onClick={() => onJumpToSegment(s.segmentIndex)}
                      aria-label={`Jump to sentence ${s.segmentIndex + 1}, score ${Math.round(s.score)}`}
                      className="flex min-h-[36px] items-center justify-between gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-left text-xs transition-colors hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                    >
                      <span className="min-w-0 flex-1 truncate text-[var(--text)]">{s.referenceText}</span>
                      <span className="shrink-0 font-semibold text-[var(--text-muted)]">{Math.round(s.score)}</span>
                      <ChevronRight size={12} className="shrink-0 text-[var(--text-faint)]" />
                    </button>
                  ))}
                </div>
                {!showAllWeakestSentences && weakestSentences.length > WEAKEST_SENTENCE_INITIAL_LIMIT && (
                  <button
                    type="button"
                    onClick={() => setShowAllWeakestSentences(true)}
                    className="min-h-[36px] self-start rounded-lg px-1.5 text-xs font-semibold text-[var(--accent)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                  >
                    View all
                  </button>
                )}
              </>
            )}
            {usedFallbackScore && weakestSentences.length > 0 && (
              <p className="text-xs text-[var(--text-faint)]">* Azure accuracy shown where the overall pronunciation score isn&apos;t available.</p>
            )}
          </div>
        </div>
      )}

      <VideoPracticeSummaryModal
        open={showRoundSummary}
        onClose={() => setShowRoundSummary(false)}
        summary={summary}
        onJumpToSegment={(segmentIndex) => {
          setShowRoundSummary(false);
          onJumpToSegment(segmentIndex);
        }}
      />
    </div>
  );
}
