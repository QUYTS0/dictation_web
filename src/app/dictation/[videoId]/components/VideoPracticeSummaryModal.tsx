"use client";

import { ChevronDown, ChevronRight, TrendingUp } from "lucide-react";
import type { ImprovementEvent, ShadowingEvaluationSummary, WordPracticeStat } from "../useShadowingEvaluations";
import type { MetricKey } from "../evaluationFeedback";
import { MetricGrid } from "./MetricGrid";
import { ReportDialogShell } from "./ReportDialogShell";

const METRIC_LABELS: Record<MetricKey, string> = {
  accuracy: "Accuracy",
  fluency: "Fluency",
  completeness: "Completeness",
  prosody: "Prosody",
};

const IMPROVEMENT_LEVEL_LABEL: Record<ImprovementEvent["level"], string> = {
  great: "Great improvement",
  nice: "Nice improvement",
  improving: "Improving",
};

const WORDS_TO_PRACTICE_PREVIEW_LIMIT = 5;
const SOUNDS_TO_PRACTICE_LIMIT = 5;
const SENTENCES_TO_RETRY_LIMIT = 5;
const IMPROVEMENTS_LIMIT = 5;

function ImprovementRow({ event, onJumpToSegment }: { event: ImprovementEvent; onJumpToSegment: (segmentIndex: number) => void }) {
  return (
    <button
      type="button"
      onClick={() => onJumpToSegment(event.segmentIndex)}
      className="flex min-h-[36px] flex-col gap-0.5 rounded-lg border border-[var(--green)]/25 bg-[var(--green)]/[0.08] px-3 py-2 text-left text-sm transition-colors hover:bg-[var(--green)]/[0.14] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
    >
      <span className="flex items-center gap-1.5 text-xs font-semibold text-[var(--green)]">
        <TrendingUp size={13} /> {IMPROVEMENT_LEVEL_LABEL[event.level]}
      </span>
      <span className="truncate text-[var(--text)]">
        {event.label}{" "}
        <span className="text-[var(--text-muted)]">
          {Math.round(event.fromScore)} → {Math.round(event.toScore)}
        </span>
        <span className="ml-1 text-xs text-[var(--text-faint)]">
          · {event.attemptCount} attempt{event.attemptCount !== 1 ? "s" : ""}
        </span>
      </span>
      {event.mastered && <span className="text-xs text-[var(--text-faint)]">Mastered after practice</span>}
    </button>
  );
}

function WordToPracticeRow({ word }: { word: WordPracticeStat }) {
  const hasTimeline = word.timeline.length > 1;
  const summaryLine = (
    <div className="flex flex-1 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <span className="font-medium text-[var(--red)]">{word.word}</span>
      <span className="text-xs text-[var(--text-muted)]">
        Avg. {Math.round(word.averageLatestScore)}/100 · {word.mispronunciationCount}/{word.evaluatedOccurrences} issues
        {word.focusPhoneme ? ` · /${word.focusPhoneme}/` : ""}
      </span>
    </div>
  );

  if (!hasTimeline) {
    return <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm">{summaryLine}</div>;
  }

  return (
    <details className="group rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm">
      <summary className="flex cursor-pointer list-none items-start gap-2 [&::-webkit-details-marker]:hidden">
        {summaryLine}
        <ChevronDown size={14} className="mt-1 shrink-0 text-[var(--text-faint)] transition-transform group-open:rotate-180" />
      </summary>
      <p className="mt-2 border-t border-[var(--border)] pt-2 text-xs text-[var(--text-muted)]">
        Attempts: {word.timeline.map((t) => Math.round(t.score)).join(" → ")}
      </p>
    </details>
  );
}

/**
 * Learner-oriented "how am I doing across this whole video" surface —
 * distinct from the per-sentence Detailed report and the compact Session
 * panel. Opened from EvaluationSessionSummary, which already owns the
 * ShadowingEvaluationSummary and jump-to-segment callback. Section order
 * deliberately leads with performance and improvement before any list of
 * problems (Overall -> Your improvement -> Strengths -> Words to practice
 * -> Sounds to practice -> Sentences to retry) — see "Video-wide learning
 * history" plan §7/§28.
 */
export function VideoPracticeSummaryModal({
  open,
  onClose,
  summary,
  onJumpToSegment,
}: {
  open: boolean;
  onClose: () => void;
  summary: ShadowingEvaluationSummary;
  onJumpToSegment: (segmentIndex: number) => void;
}) {
  const {
    evaluatedCount,
    totalCount,
    isComplete,
    weightedPronunciation,
    weightedAccuracy,
    weightedFluency,
    weightedCompleteness,
    weightedProsody,
    wordsToPractice,
    soundsToPractice,
    weakestSentences,
    improvements,
    strengths,
    needsMostWork,
    wellPronouncedWords,
  } = summary;

  return (
    <ReportDialogShell open={open} onClose={onClose} titleId="video-summary-title" title="Video summary">
      <p className="text-xs font-medium text-[var(--text-muted)]">
        {evaluatedCount}/{totalCount} sentences evaluated — {isComplete ? "Complete summary" : "Partial summary"}
      </p>

      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-faint)]">Overall</h3>
        <MetricGrid
          metrics={[
            { label: "Pronunciation", value: weightedPronunciation },
            { label: "Accuracy", value: weightedAccuracy },
            { label: "Fluency", value: weightedFluency },
            { label: "Completeness", value: weightedCompleteness },
            { label: "Prosody", value: weightedProsody },
          ]}
        />
      </section>

      {improvements.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-faint)]">Your improvement</h3>
          <div className="flex flex-col gap-1.5">
            {improvements.slice(0, IMPROVEMENTS_LIMIT).map((event) => (
              <ImprovementRow key={`${event.type}-${event.label}`} event={event} onJumpToSegment={onJumpToSegment} />
            ))}
          </div>
        </section>
      )}

      {(strengths || wellPronouncedWords.length > 0) && (
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-faint)]">Strengths</h3>
          {strengths && (
            <p className="text-sm text-[var(--text)]">
              Strongest skill: <span className="font-semibold">{METRIC_LABELS[strengths.metric]}</span> ·{" "}
              {Math.round(strengths.value)}
            </p>
          )}
          {needsMostWork && (
            <p className="text-xs text-[var(--text-muted)]">
              Needs most work: {METRIC_LABELS[needsMostWork.metric]} · {Math.round(needsMostWork.value)}
            </p>
          )}
          {wellPronouncedWords.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {wellPronouncedWords.map((w) => (
                <span
                  key={w.word}
                  className="rounded-full border border-[var(--green)]/25 bg-[var(--green)]/[0.08] px-2 py-0.5 text-xs text-[var(--green)]"
                >
                  {w.word} · {Math.round(w.score)}
                </span>
              ))}
            </div>
          )}
        </section>
      )}

      {wordsToPractice.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-faint)]">Words to practice</h3>
          <div className="flex flex-col gap-1.5">
            {wordsToPractice.slice(0, WORDS_TO_PRACTICE_PREVIEW_LIMIT).map((word) => (
              <WordToPracticeRow key={word.word} word={word} />
            ))}
          </div>
        </section>
      )}

      {soundsToPractice.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-faint)]">Sounds to practice</h3>
          <div className="flex flex-col gap-1.5">
            {soundsToPractice.slice(0, SOUNDS_TO_PRACTICE_LIMIT).map((sound) => (
              <div key={sound.phoneme} className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm">
                <p className="font-mono font-medium text-[var(--text)]">/{sound.phoneme}/</p>
                <p className="text-xs text-[var(--text-muted)]">Average {Math.round(sound.averageScore)}/100</p>
                <p className="text-xs text-[var(--text-faint)]">Needs work in: {sound.exampleWords.join(" · ")}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {weakestSentences.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-faint)]">Sentences to retry</h3>
          <div className="flex flex-col gap-1.5">
            {weakestSentences.slice(0, SENTENCES_TO_RETRY_LIMIT).map((s) => (
              <button
                key={s.segmentIndex}
                type="button"
                onClick={() => onJumpToSegment(s.segmentIndex)}
                className="flex min-h-[36px] items-center justify-between gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-left text-sm transition-colors hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              >
                <span className="min-w-0 flex-1 truncate text-[var(--text)]">{s.referenceText}</span>
                <span className="shrink-0 font-semibold text-[var(--text-muted)]">{Math.round(s.score)}</span>
                <ChevronRight size={12} className="shrink-0 text-[var(--text-faint)]" />
              </button>
            ))}
          </div>
        </section>
      )}
    </ReportDialogShell>
  );
}
