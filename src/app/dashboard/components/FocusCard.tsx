"use client";

import type { MouseEvent } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { FocusResult } from "@/lib/dashboard/selectFocus";

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** Factual vocabulary lines — no ordering or batch-size claims (the review queue guarantees neither). */
export function vocabularyHeadline(variant: "due" | "new", due: number): string {
  return variant === "due" ? `${due} ${plural(due, "word is", "words are")} due` : "New vocabulary is ready to practice";
}

const ctaClass =
  "inline-flex items-center gap-2 whitespace-nowrap rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-primary-700 shadow-sm ring-1 ring-primary-500/30 transition-colors hover:bg-primary-50";

/**
 * "Next up" — the Focus decision (selectFocus) presented to the learner: one
 * next action, or nothing. `hidden` renders nothing (its reason is kept for
 * tests/debugging only); `pending` holds a placeholder so a lower-priority
 * action never flashes before a higher-priority one resolves.
 */
export function FocusCard({ focus, onAddVideo }: { focus: FocusResult; onAddVideo: (e: MouseEvent<HTMLAnchorElement>) => void }) {
  if (focus.kind === "hidden") return null;

  if (focus.kind === "pending") {
    return (
      <section
        aria-busy="true"
        aria-label="Loading next up"
        data-testid="focus-pending"
        className="min-h-[148px] animate-pulse rounded-3xl border border-slate-200/70 bg-white/60"
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
      className="flex flex-col gap-4 rounded-3xl border border-slate-200/70 bg-white/70 p-5 sm:p-6"
    >
      <p className="text-sm font-semibold text-slate-500">Next up</p>
      <div className="min-w-0">
        <h2 id="focus-heading" className="text-lg font-semibold leading-snug text-slate-900">
          {headline}
        </h2>
        <p className="mt-1 text-sm text-slate-500">{detail}</p>
      </div>
      <div>{cta}</div>
    </section>
  );
}
