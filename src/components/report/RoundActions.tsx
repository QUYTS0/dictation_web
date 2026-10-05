"use client";

import Link from "next/link";
import { clsx } from "clsx";
import type { RoundReport } from "@/lib/types/learning";
import {
  continueShadowingHref,
  roundActions,
  type ContinuationStart,
  type RoundAction,
  type RoundActionContext,
} from "@/lib/practice/roundActions";

/**
 * The round's next actions from the ONE decision table (roundActions) — the
 * completion view, the full report and History render the same buttons with
 * the same meaning. Handlers are used where the caller is the practice page
 * itself; otherwise the actions are links. "Practice again — new round" is
 * only offered where a confirmed restart can run (the practice page).
 */
export interface RoundActionsProps extends RoundActionContext {
  report: RoundReport;
  /** Same-round Shadowing continuation on this page (practice view). */
  onContinue?: (start: ContinuationStart) => void;
  onContinuePractice?: () => void;
  onShowShadowingSummary?: () => void;
  onPracticeAgain?: () => void;
  /** Hide "Review report" (the caller IS the full report). */
  hideViewReport?: boolean;
  buttonClassName?: string;
  primaryClassName?: string;
}

const base =
  "inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-semibold text-[var(--text)] hover:bg-[var(--accent-soft)]";
const primary = "border-[var(--accent-border)] bg-[var(--accent-soft)] text-[var(--accent)]";

export function RoundActions({
  report,
  newerActiveRound,
  onContinue,
  onContinuePractice,
  onShowShadowingSummary,
  onPracticeAgain,
  hideViewReport = false,
  buttonClassName = base,
  primaryClassName = primary,
}: RoundActionsProps) {
  const { roundId, videoId } = report.round;
  const actions = roundActions(report, { newerActiveRound }).filter(
    (a) => !(hideViewReport && a.kind === "view_report") && !(a.kind === "practice_again_new_round" && !onPracticeAgain)
  );
  if (actions.length === 0) return null;

  const render = (a: RoundAction) => {
    const cls = clsx(buttonClassName, a.primary && primaryClassName);
    const testId = `round-action-${a.kind}`;
    switch (a.kind) {
      case "continue_shadowing":
      case "continue_scoring":
      case "practise_shadowing_same_round":
        return onContinue ? (
          <button type="button" className={cls} data-testid={testId} onClick={() => onContinue(a.start!)}>
            {a.label}
          </button>
        ) : (
          <Link className={cls} data-testid={testId} href={continueShadowingHref(videoId, roundId, a.start!)}>
            {a.label}
          </Link>
        );
      case "view_shadowing_summary":
        return onShowShadowingSummary ? (
          <button type="button" className={cls} data-testid={testId} onClick={onShowShadowingSummary}>
            {a.label}
          </button>
        ) : (
          <Link className={cls} data-testid={testId} href={`/results/${encodeURIComponent(roundId)}?section=shadowing`}>
            {a.label}
          </Link>
        );
      case "continue_practice":
        return onContinuePractice ? (
          <button type="button" className={cls} data-testid={testId} onClick={onContinuePractice}>
            {a.label}
          </button>
        ) : (
          <Link className={cls} data-testid={testId} href={`/dictation/${encodeURIComponent(videoId)}`}>
            {a.label}
          </Link>
        );
      case "go_to_current_round":
        return (
          <Link className={cls} data-testid={testId} href={`/dictation/${encodeURIComponent(videoId)}`}>
            {a.label}
          </Link>
        );
      case "view_report":
        return (
          <Link className={cls} data-testid={testId} href={`/results/${encodeURIComponent(roundId)}`}>
            {a.label}
          </Link>
        );
      case "practice_again_new_round":
        return (
          <button type="button" className={cls} data-testid={testId} onClick={onPracticeAgain} title="Starts a new round; this round's results stay in your history">
            {a.label}
          </button>
        );
    }
  };

  return (
    <div className="flex flex-col gap-1" data-testid="round-actions">
      <div className="flex flex-wrap items-center gap-2">
        {actions.map((a) => (
          <span key={a.kind} className="contents">
            {render(a)}
          </span>
        ))}
      </div>
      {actions
        .filter((a) => a.note)
        .map((a) => (
          <p key={`${a.kind}-note`} className="text-[11px] text-[var(--text-muted)]">
            {a.note}
          </p>
        ))}
    </div>
  );
}
