"use client";

import Link from "next/link";
import { clsx } from "clsx";
import { FileText, Headphones, Keyboard, Library, Mic, PanelRightOpen, RotateCcw, Undo2 } from "lucide-react";
import { RoundReportPanel } from "@/components/report/RoundReportPanel";
import { useRoundReportQuery } from "@/lib/queries/roundReport";
import type { InputMode } from "../types";

const MODE_ACTIONS: Array<{ mode: InputMode; label: string; icon: typeof Keyboard }> = [
  { mode: "dictation", label: "Dictation", icon: Keyboard },
  { mode: "listening", label: "Listening", icon: Headphones },
  { mode: "shadowing", label: "Shadowing", icon: Mic },
];

const buttonClass =
  "inline-flex items-center gap-1.5 rounded-xl border border-[var(--border)] px-3 py-2 text-xs font-semibold text-[var(--text)] transition-colors hover:bg-white/10";

export interface PracticeReportViewProps {
  userId: string | undefined;
  roundId: string | null;
  videoTitle: string;
  inputMode: InputMode;
  onReviewSentence: (segmentIndex: number) => void;
  onSwitchMode: (mode: InputMode) => void;
  onBackToPractice: () => void;
  onOpenScript: () => void;
  onPracticeAgain: () => void;
  restartError?: string | null;
  /** Guest / no round: the local summary shown instead of a server report. */
  guestFallback?: React.ReactNode;
}

/**
 * The completed-round results as the MAIN content of the practice page
 * (plan Phase 6 §9): the whole-round report from the server — never
 * page-local counters — with the actions to review a sentence, continue in
 * another mode of the same round, go back to the Library, or explicitly
 * start a new round. The large player and the side panel are hidden by the
 * page while this is shown; "Open script" brings the panel back.
 */
export function PracticeReportView({
  userId,
  roundId,
  videoTitle,
  inputMode,
  onReviewSentence,
  onSwitchMode,
  onBackToPractice,
  onOpenScript,
  onPracticeAgain,
  restartError,
  guestFallback,
}: PracticeReportViewProps) {
  const reportQuery = useRoundReportQuery(userId, roundId);
  const report = reportQuery.data?.round;

  return (
    <div className="flex flex-col gap-4" data-testid="practice-report-view">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-widest text-[var(--text-faint)]">Round results</p>
          <h2 className="truncate text-base font-semibold text-[var(--text)]">{videoTitle}</h2>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={onBackToPractice} className={buttonClass}>
            <Undo2 size={14} /> Back to practice
          </button>
          <button type="button" onClick={onOpenScript} className={buttonClass}>
            <PanelRightOpen size={14} /> Open script
          </button>
        </div>
      </div>

      {!userId || !roundId ? (
        guestFallback ?? <p className="text-sm text-[var(--text-muted)]">Sign in to keep a full report of your rounds.</p>
      ) : reportQuery.isError && !report ? (
        <p className="text-sm text-[var(--red)]" role="alert">
          Couldn&apos;t load this round&apos;s report.{" "}
          <button type="button" onClick={() => reportQuery.refetch()} className="font-semibold underline">
            Retry
          </button>
        </p>
      ) : !report ? (
        <p className="text-sm text-[var(--text-muted)]">Loading your round report…</p>
      ) : (
        <RoundReportPanel
          report={report}
          userId={userId}
          shadowingFeedback="open"
          onReviewSentence={onReviewSentence}
          actions={
            <>
              {MODE_ACTIONS.filter((m) => m.mode !== inputMode).map(({ mode, label, icon: Icon }) => (
                <button key={mode} type="button" onClick={() => onSwitchMode(mode)} className={buttonClass}>
                  <Icon size={14} /> Continue in {label}
                </button>
              ))}
              <Link href={`/results/${report.round.roundId}`} className={buttonClass}>
                <FileText size={14} /> Full report
              </Link>
              <Link href="/dashboard" className={buttonClass}>
                <Library size={14} /> Library
              </Link>
              <button
                type="button"
                onClick={onPracticeAgain}
                className={clsx(buttonClass, "border-[var(--accent-border)] text-[var(--accent)]")}
                title="Starts a new round; this round's results stay in your history"
              >
                <RotateCcw size={14} /> Practice again (new round)
              </button>
              {restartError && (
                <p className="w-full text-xs text-[var(--red)]" role="alert">
                  {restartError}
                </p>
              )}
            </>
          }
        />
      )}
    </div>
  );
}
