"use client";

import type { ShadowingRoundSummary } from "@/lib/practice/shadowingSummary";
import { ShadowingSummaryView } from "@/components/report/ShadowingSummaryView";
import { ReportDialogShell } from "./ReportDialogShell";

/**
 * The full Shadowing summary of the round the practice page shows, in a
 * dialog — the same view (and the same builder) the round reports use, so
 * the practice page, /results and History never disagree about a round.
 * Opened from EvaluationSessionSummary; a sentence opens in the practice
 * view (this round, its pinned revision).
 */
export function VideoPracticeSummaryModal({
  open,
  onClose,
  summary,
  onJumpToSegment,
}: {
  open: boolean;
  onClose: () => void;
  summary: ShadowingRoundSummary;
  onJumpToSegment: (segmentIndex: number) => void;
}) {
  return (
    <ReportDialogShell open={open} onClose={onClose} titleId="video-summary-title" title="Shadowing summary · This round">
      <ShadowingSummaryView summary={summary} onOpenSentence={onJumpToSegment} />
    </ReportDialogShell>
  );
}
