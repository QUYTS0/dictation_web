import { ComparedSentenceText } from "./ComparedSentenceText";
import { buildComparedTokens } from "../helpers";
import type { CompletedSentenceReview } from "../types";

export function ReviewPreviousSentenceCard({
  previousReview,
  reviewTextContainerRef,
  handleReviewMouseUp,
}: {
  previousReview: CompletedSentenceReview;
  reviewTextContainerRef: React.RefObject<HTMLDivElement | null>;
  handleReviewMouseUp: (event: React.MouseEvent<HTMLDivElement>) => void;
}) {
  const { expectedTokens, userTokens } = buildComparedTokens({
    diff: previousReview.diff,
    expectedText: previousReview.expectedText,
    userText: previousReview.firstUserText,
  });

  return (
    <div
      ref={reviewTextContainerRef}
      onMouseUp={handleReviewMouseUp}
      className="flex gap-2.5"
    >
      <div
        data-script-segment-index={previousReview.segmentIndex}
        data-selection-sentence-text={previousReview.expectedText}
        className="flex-1 rounded-lg border border-[var(--green)]/25 bg-[var(--green)]/[0.08] p-2 text-xs"
      >
        <p className="text-[11px] font-semibold text-[var(--green)]">Correct sentence</p>
        <ComparedSentenceText tokens={expectedTokens} tone="expected" />
      </div>
      <div
        data-script-segment-index={previousReview.segmentIndex}
        data-selection-sentence-text={previousReview.expectedText}
        className="flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-2 text-xs"
      >
        <p className="text-[11px] font-semibold text-[var(--text-faint)]">Your answer</p>
        <ComparedSentenceText tokens={userTokens} tone="user" emptyFallback="(No answer provided)" />
      </div>
    </div>
  );
}
