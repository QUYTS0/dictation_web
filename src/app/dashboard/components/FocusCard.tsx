"use client";

import type { MouseEvent } from "react";
import Link from "next/link";
import { ArrowRight, Target } from "lucide-react";
import type { FocusResult } from "@/lib/dashboard/selectFocus";
import { useRoundReportQuery } from "@/lib/queries/roundReport";

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** Sentences listed by name; the rest are counted ("+2 more"). */
const MAX_LISTED = 3;

/**
 * The sentences behind "N sentences need another look", from the round
 * report (the same cache entry the "Review sentences" link opens). Shown
 * only when the report agrees with the headline's count, so the list never
 * contradicts it; while loading, on error or on a mismatch, nothing.
 */
function NeedsReviewSentences({ userId, roundId, count }: { userId: string | undefined; roundId: string; count: number }) {
  const report = useRoundReportQuery(userId, roundId).data;
  const sentences = report?.round?.sentences?.filter((s) => s.category === "needs_review") ?? [];
  if (sentences.length === 0 || sentences.length !== count || report?.round?.dictation?.needsReview !== count) return null;
  const listed = sentences.slice(0, MAX_LISTED);
  return (
    <div data-testid="focus-sentences">
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

/** Factual vocabulary lines — no ordering or batch-size claims (the review queue guarantees neither). */
export function vocabularyHeadline(variant: "due" | "new", due: number): string {
  return variant === "due" ? `${due} ${plural(due, "word is", "words are")} due` : "New vocabulary is ready to practice";
}

const ctaClass =
  "inline-flex items-center gap-2 whitespace-nowrap rounded-xl border border-line bg-surface px-4 py-2.5 text-sm font-semibold text-primary-600 transition-colors hover:border-primary-500/40 hover:bg-primary-50";

/**
 * "Next up" — the Focus decision (selectFocus) presented to the learner: one
 * next action, or nothing. `hidden` renders nothing (its reason is kept for
 * tests/debugging only); `pending` holds a placeholder so a lower-priority
 * action never flashes before a higher-priority one resolves.
 */
export function FocusCard({
  focus,
  onAddVideo,
  userId,
}: {
  focus: FocusResult;
  onAddVideo: (e: MouseEvent<HTMLAnchorElement>) => void;
  /** For the sentence list (the round report); without it the list is left out. */
  userId?: string;
}) {
  if (focus.kind === "hidden") return null;

  if (focus.kind === "pending") {
    return (
      <section
        aria-busy="true"
        aria-label="Loading next up"
        data-testid="focus-pending"
        className="h-full min-h-[148px] animate-pulse rounded-2xl border border-line bg-white"
      />
    );
  }

  let headline: string;
  let detail: string;
  let cta;
  if (focus.kind === "sentences") {
    headline = `${focus.needsReview} ${plural(focus.needsReview, "sentence needs", "sentences need")} another look`;
    detail = "Review the ones that tripped you up.";
    cta = (
      <Link href={`/results/${focus.roundId}`} className={ctaClass}>
        Review sentences <ArrowRight size={16} aria-hidden="true" />
      </Link>
    );
  } else if (focus.kind === "vocabulary") {
    headline = vocabularyHeadline(focus.variant, focus.due);
    detail =
      focus.variant === "due"
        ? "Keep them fresh."
        : `${focus.newCount} ${plural(focus.newCount, "word hasn't", "words haven't")} been reviewed yet.`;
    cta = (
      <Link href="/vocabulary/review" className={ctaClass}>
        Start review <ArrowRight size={16} aria-hidden="true" />
      </Link>
    );
  } else {
    headline = "Ready for something new?";
    detail = "Add a YouTube video to start practicing.";
    cta = (
      <a href="#add-video" onClick={onAddVideo} className={ctaClass}>
        Add a video <ArrowRight size={16} aria-hidden="true" />
      </a>
    );
  }

  return (
    <section
      aria-labelledby="focus-heading"
      data-testid="dashboard-focus"
      data-focus-kind={focus.kind}
      className="flex h-full flex-col gap-4 rounded-2xl border border-line bg-white p-5 shadow-xs"
    >
      <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-ink">
        <Target size={16} className="text-primary-600" aria-hidden="true" />
        Next up
      </p>
      <div className="min-w-0">
        <h2 id="focus-heading" className="text-lg font-bold leading-snug text-ink">
          {headline}
        </h2>
        <p className="mt-1 text-sm text-muted">{detail}</p>
      </div>
      {focus.kind === "sentences" && userId && <NeedsReviewSentences userId={userId} roundId={focus.roundId} count={focus.needsReview} />}
      {/* At the bottom, level with the Continue card's button beside it. */}
      <div className="mt-auto">{cta}</div>
    </section>
  );
}
