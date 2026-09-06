"use client";

import { useState } from "react";
import { BarChart3, ChevronDown, ChevronRight, Sparkles, TrendingUp } from "lucide-react";
import type { ImprovementEvent, ShadowingEvaluationSummary } from "../useShadowingEvaluations";
import { useEvaluationSummaryCollapsedPreference } from "../useEvaluationSummaryCollapsedPreference";
import { MetricGrid } from "./MetricGrid";
import { VideoPracticeSummaryModal } from "./VideoPracticeSummaryModal";

const WORDS_TO_PRACTICE_INITIAL_LIMIT = 5;
const WEAKEST_SENTENCE_INITIAL_LIMIT = 2;
const IMPROVEMENTS_SHOWN_IN_SESSION = 2;

const IMPROVEMENT_LEVEL_LABEL: Record<ImprovementEvent["level"], string> = {
  great: "Great improvement",
  nice: "Nice improvement",
  improving: "Improving",
};

function ImprovementCard({ event, onJumpToSegment }: { event: ImprovementEvent; onJumpToSegment: (segmentIndex: number) => void }) {
  return (
    <button
      type="button"
      onClick={() => onJumpToSegment(event.segmentIndex)}
      className="flex min-h-[36px] flex-col gap-0.5 rounded-lg border border-[var(--green)]/25 bg-[var(--green)]/[0.08] px-2 py-1.5 text-left text-xs transition-colors hover:bg-[var(--green)]/[0.14] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
    >
      <span className="flex items-center gap-1 font-semibold text-[var(--green)]">
        <TrendingUp size={12} /> {IMPROVEMENT_LEVEL_LABEL[event.level]}
      </span>
      <span className="truncate text-[var(--text)]">
        {event.label} <span className="text-[var(--text-muted)]">{Math.round(event.fromScore)} → {Math.round(event.toScore)}</span>
      </span>
      {event.mastered && <span className="text-[var(--text-faint)]">Mastered after practice</span>}
    </button>
  );
}

/**
 * Session-scoped summary over every SentenceEvaluation recorded so far this
 * video — updates live as more sentences are evaluated, not a separate
 * "end of session" event. No blended "Overall Score" — each category that
 * has data shows its own grid cell; a category no evaluation produced is
 * simply omitted, never shown as 0. Collapsed by default (both desktop and
 * mobile — see useEvaluationSummaryCollapsedPreference) so the current
 * sentence stays the primary content; the coverage fraction is shown
 * exactly once, in this header, whether collapsed or expanded.
 *
 * Words to practice / Sounds to practice / Improvement all come from
 * ShadowingEvaluationSummary (see videoPracticeSummary.ts) — this panel
 * only ever shows a compact slice; the full picture lives in the Video
 * summary modal opened from here.
 */
export function EvaluationSessionSummary({
  summary,
  onJumpToSegment,
}: {
  summary: ShadowingEvaluationSummary;
  onJumpToSegment: (segmentIndex: number) => void;
}) {
  const { collapsed, setCollapsed } = useEvaluationSummaryCollapsedPreference();
  const [showAllWordsToPractice, setShowAllWordsToPractice] = useState(false);
  const [showAllWeakestSentences, setShowAllWeakestSentences] = useState(false);
  const [showVideoSummary, setShowVideoSummary] = useState(false);

  const {
    evaluatedCount,
    totalCount,
    weightedAccuracy,
    weightedFluency,
    weightedCompleteness,
    weightedProsody,
    wordsToPractice,
    weakestSentences,
    improvements,
  } = summary;

  const coveragePct = totalCount > 0 ? Math.round((evaluatedCount / totalCount) * 100) : 0;
  const visibleWordsToPractice = showAllWordsToPractice
    ? wordsToPractice
    : wordsToPractice.slice(0, WORDS_TO_PRACTICE_INITIAL_LIMIT);
  const visibleWeakestSentences = showAllWeakestSentences
    ? weakestSentences
    : weakestSentences.slice(0, WEAKEST_SENTENCE_INITIAL_LIMIT);
  const visibleImprovements = improvements.slice(0, IMPROVEMENTS_SHOWN_IN_SESSION);
  const usedFallbackScore = weakestSentences.some((s) => s.usedFallbackScore);

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
          <Sparkles size={12} /> Session
        </span>
        <span className="text-xs font-medium text-[var(--text-muted)] tabular-nums" aria-live="polite">
          {evaluatedCount}/{totalCount} evaluated · {coveragePct}%
        </span>
      </button>

      {!collapsed && (
        <div id="evaluation-session-summary-body" className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            {/* Distinguishes these from the current-sentence Pronunciation
                card's scores directly above this panel — same metric names,
                but averaged across every evaluated sentence this session. */}
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold text-[var(--text-faint)]">Session averages</p>
              <button
                type="button"
                onClick={() => setShowVideoSummary(true)}
                className="flex min-h-[28px] items-center gap-1 rounded-lg px-1.5 text-xs font-semibold text-[var(--accent)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              >
                <BarChart3 size={12} /> Video summary
              </button>
            </div>
            <MetricGrid
              metrics={[
                { label: "Accuracy", value: weightedAccuracy },
                { label: "Fluency", value: weightedFluency },
                { label: "Completeness", value: weightedCompleteness },
                { label: "Prosody", value: weightedProsody },
              ]}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <p className="text-xs font-semibold text-[var(--text-faint)]">Words to practice</p>
            {wordsToPractice.length === 0 ? (
              <p className="text-xs text-[var(--text-faint)]">No major pronunciation issues detected.</p>
            ) : (
              <>
                <div className="flex flex-col gap-1">
                  {visibleWordsToPractice.map((p) => (
                    <button
                      key={p.word}
                      type="button"
                      onClick={() => onJumpToSegment(p.segmentIndexes[0])}
                      aria-label={`${p.word}, average score ${Math.round(p.averageLatestScore)}, jump to sentence ${p.segmentIndexes[0] + 1}`}
                      className="flex min-h-[36px] items-center justify-between gap-2 rounded-lg border border-[var(--red)]/25 bg-[var(--red)]/[0.06] px-2 py-1.5 text-left text-xs transition-colors hover:bg-[var(--red)]/[0.12] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                    >
                      <span className="min-w-0 flex-1 truncate font-medium text-[var(--red)]">{p.word}</span>
                      <span className="shrink-0 text-[var(--text-muted)]">
                        Avg. {Math.round(p.averageLatestScore)}/100 · {p.mispronunciationCount}/{p.evaluatedOccurrences} issues
                        {p.focusPhoneme ? ` · /${p.focusPhoneme}/` : ""}
                      </span>
                      <ChevronRight size={12} className="shrink-0 text-[var(--text-faint)]" />
                    </button>
                  ))}
                </div>
                {!showAllWordsToPractice && wordsToPractice.length > WORDS_TO_PRACTICE_INITIAL_LIMIT && (
                  <button
                    type="button"
                    onClick={() => setShowAllWordsToPractice(true)}
                    className="min-h-[36px] self-start rounded-lg px-1.5 text-xs font-semibold text-[var(--accent)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                  >
                    Show more
                  </button>
                )}
              </>
            )}
          </div>

          {visibleImprovements.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <p className="text-xs font-semibold text-[var(--text-faint)]">Improvement</p>
              <div className="flex flex-col gap-1">
                {visibleImprovements.map((event) => (
                  <ImprovementCard key={`${event.type}-${event.label}`} event={event} onJumpToSegment={onJumpToSegment} />
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
              <p className="text-xs text-[var(--text-faint)]">No sentences evaluated yet.</p>
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
              <p className="text-xs text-[var(--text-faint)]">
                * Word Match accuracy shown where an Azure pronunciation score isn&apos;t available.
              </p>
            )}
          </div>
        </div>
      )}

      <VideoPracticeSummaryModal
        open={showVideoSummary}
        onClose={() => setShowVideoSummary(false)}
        summary={summary}
        onJumpToSegment={(segmentIndex) => {
          setShowVideoSummary(false);
          onJumpToSegment(segmentIndex);
        }}
      />
    </div>
  );
}
