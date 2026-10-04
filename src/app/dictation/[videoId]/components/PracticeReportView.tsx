"use client";

import Link from "next/link";
import { FileText, Headphones, Keyboard, Library, PanelRightOpen, Undo2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { RoundReportPanel, type ReportSection } from "@/components/report/RoundReportPanel";
import { RoundActions } from "@/components/report/RoundActions";
import type { ContinuationStart } from "@/lib/practice/roundActions";
import { useRoundReportQuery } from "@/lib/queries/roundReport";
import type { InputMode } from "../types";

// Shadowing's next step comes from the shared round-action table (same
// round, first sentence still to record or score) — not a plain mode switch.
const MODE_ACTIONS: Array<{ mode: InputMode; label: string; icon: typeof Keyboard }> = [
  { mode: "dictation", label: "Dictation", icon: Keyboard },
  { mode: "listening", label: "Listening", icon: Headphones },
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
  /** Same-round Shadowing continuation (Learning Reports P2). */
  onContinueShadowing: (start: ContinuationStart) => void;
  restartError?: string | null;
  /** Guest / no round: the local summary shown instead of a server report. */
  guestFallback?: React.ReactNode;
  /** Move focus to the report when it opens (opened from the Round menu). */
  autoFocus?: boolean;
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
  onContinueShadowing,
  restartError,
  guestFallback,
  autoFocus = false,
}: PracticeReportViewProps) {
  const reportQuery = useRoundReportQuery(userId, roundId);
  const report = reportQuery.data?.round;
  // The section of the mode the learner was practising when the report
  // opened (e.g. Dictation after finishing in Dictation) — an explicit tab
  // choice then wins. Never the stored "last mode".
  const [section, setSection] = useState<ReportSection>(() => inputMode);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (autoFocus) headingRef.current?.focus({ preventScroll: true });
    // Once, when the view opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-col gap-4" data-testid="practice-report-view">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-widest text-[var(--text-faint)]">
            {report?.round.status === "active" ? "Round report" : "Round results"}
          </p>
          <h2 ref={headingRef} tabIndex={-1} className="truncate text-base font-semibold text-[var(--text)] focus:outline-none">
            {videoTitle}
          </h2>
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
          dictationEvidence={reportQuery.data?.dictationEvidence}
          transcriptVersion={reportQuery.data?.transcriptVersion ?? null}
          listening={reportQuery.data?.listening ?? null}
          section={section}
          onSectionChange={setSection}
          userId={userId}
          shadowingFeedback="open"
          onReviewSentence={onReviewSentence}
          actions={
            <>
              <RoundActions
                report={report}
                newerActiveRound={reportQuery.data?.newerActiveRound ?? null}
                onContinue={onContinueShadowing}
                onContinuePractice={onBackToPractice}
                onShowShadowingSummary={() => setSection("shadowing")}
                onPracticeAgain={onPracticeAgain}
                hideViewReport
              />
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
