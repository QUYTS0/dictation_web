"use client";

import { useMemo, useState } from "react";
import { buildShadowingRoundSummary } from "@/lib/practice/shadowingSummary";
import { fromRoundResults } from "@/lib/practice/shadowingSummaryInput";
import { useShadowingRoundResultsQuery } from "@/lib/queries/shadowingRoundResults";
import type { RoundReport } from "@/lib/types/learning";
import { ShadowingSummaryView } from "./ShadowingSummaryView";

/**
 * The detailed Shadowing summary inside a round report, loaded LAZILY from
 * the round's saved results (GET /api/practice/attempts?roundId=) only while
 * this section is open — a collapsed History card downloads no word-level
 * detail. The report's lightweight totals (SQL) stay visible regardless: a
 * failure here never hides them.
 *
 * Scope: exactly the report's round and its pinned transcript. A response
 * for another round or revision is refused rather than shown against the
 * wrong sentences. Reading changes nothing (no round, activity or Azure call).
 */
export function ShadowingFeedbackSection({
  userId,
  report,
  defaultOpen,
  onReviewSentence,
}: {
  userId: string;
  report: RoundReport;
  defaultOpen: boolean;
  /** Only when the host shows THIS round's pinned sentences (practice page, current round). */
  onReviewSentence?: (segmentIndex: number) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const roundId = report.round.roundId;
  const query = useShadowingRoundResultsQuery(userId, roundId, open);
  const data = query.data;
  const textBySegment = useMemo(() => new Map(report.sentences.map((s) => [s.segmentIndex, s.text ?? ""])), [report.sentences]);
  const mismatch = !!data && (data.roundId !== roundId || data.transcriptId !== report.round.transcriptId);
  const summary = useMemo(() => {
    if (!data || mismatch) return null;
    return buildShadowingRoundSummary(
      fromRoundResults(data, (i) => textBySegment.get(i) ?? "", {
        eligibleSentences: report.progress.requiredSentenceCount,
        recordedSentences: report.progress.coveredSentences.shadowing,
      })
    );
  }, [data, mismatch, textBySegment, report.progress]);

  return (
    <section className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3" data-testid="report-shadowing-feedback">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`shadowing-feedback-${roundId}`}
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left text-sm font-semibold"
      >
        {open ? "▾" : "▸"} Shadowing summary · Round {report.round.roundNumber}
      </button>
      <div className="mt-3" id={`shadowing-feedback-${roundId}`}>
        {!open ? null : query.isError && !data ? (
          <p className="text-xs text-[var(--red)]" role="alert">
            Couldn&apos;t load the Shadowing feedback.{" "}
            <button type="button" onClick={() => query.refetch()} className="font-semibold underline">
              Retry
            </button>
          </p>
        ) : mismatch ? (
          <p className="text-xs text-[var(--text-muted)]" role="alert">
            These saved results don&apos;t belong to this round&apos;s script version, so they aren&apos;t shown here.
          </p>
        ) : !summary ? (
          <p className="text-xs text-[var(--text-muted)]">Loading the Shadowing feedback…</p>
        ) : (
          <ShadowingSummaryView summary={summary} onOpenSentence={onReviewSentence} />
        )}
      </div>
    </section>
  );
}
