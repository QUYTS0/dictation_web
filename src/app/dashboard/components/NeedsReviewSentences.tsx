"use client";

import { useRoundReportQuery } from "@/lib/queries/roundReport";

/** Sentences listed by text; the rest are counted ("+2 more"). */
const MAX_LISTED = 3;

/**
 * The sentences behind "N sentences need another look", from the round
 * report (the same cache entry the "Review sentences" link opens). Shown
 * only when the report agrees with the count beside it, so the list never
 * contradicts it. While loading, on error or on a mismatch: nothing.
 */
export function NeedsReviewSentences({ userId, roundId, count }: { userId: string; roundId: string; count: number }) {
  const report = useRoundReportQuery(userId, roundId).data;
  const sentences = report?.round?.sentences?.filter((s) => s.category === "needs_review") ?? [];
  if (sentences.length === 0 || sentences.length !== count || report?.round?.dictation?.needsReview !== count) return null;
  const listed = sentences.slice(0, MAX_LISTED);
  return (
    <div data-testid="needs-review-sentences">
      <ul className="space-y-1.5">
        {listed.map((s) => (
          <li key={s.segmentIndex} className="flex min-w-0 items-baseline gap-2 rounded-lg bg-surface px-3 py-2 text-sm text-ink">
            <span className="shrink-0 font-mono text-[11px] text-muted">#{s.segmentIndex + 1}</span>
            <span className="min-w-0 truncate">{s.text ?? `Sentence ${s.segmentIndex + 1}`}</span>
          </li>
        ))}
      </ul>
      {sentences.length > listed.length && <p className="mt-1.5 text-xs text-muted">+{sentences.length - listed.length} more</p>}
    </div>
  );
}
