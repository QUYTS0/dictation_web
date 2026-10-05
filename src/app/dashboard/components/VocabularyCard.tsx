import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { FocusSource } from "@/lib/dashboard/selectFocus";
import type { VocabularyStatsResponse } from "@/lib/types";
import type { DashboardSummary } from "@/lib/types/learning";
import { vocabularyHeadline } from "./FocusCard";

const MAX_TERMS = 6;

/**
 * Vocabulary momentum: how many words are saved, whether any are ready for
 * review (the Vocabulary page's own due/new semantics — no ordering or
 * batch-size claims), and the most recent terms as light chips.
 *
 * `showReviewButton` is decided by the Dashboard's dedup rule: never when
 * Next Up already offers "Start review", never while Next Up is deciding.
 */
export function VocabularyCard({
  summary,
  vocab,
  showReviewButton,
}: {
  summary: DashboardSummary | undefined;
  vocab: FocusSource<VocabularyStatsResponse>;
  showReviewButton: boolean;
}) {
  const saved = summary?.vocabularyCount ?? 0;
  const stats = vocab.status === "ready" ? vocab.data : null;
  const terms = summary?.recentVocabulary.slice(0, MAX_TERMS) ?? [];
  const reviewLine = stats && stats.reviewable > 0 ? vocabularyHeadline(stats.due > 0 ? "due" : "new", stats.due) : stats && stats.total > 0 ? "Nothing to review right now" : null;

  return (
    <section aria-labelledby="vocabulary-heading" data-testid="vocabulary-card" className="flex h-full flex-col rounded-3xl border border-slate-200/70 bg-white/60 p-5 sm:p-6">
      <h2 id="vocabulary-heading" className="text-base font-semibold text-slate-900">
        Vocabulary
      </h2>
      <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-2xl font-semibold tracking-tight text-slate-900">
            {saved} {saved === 1 ? "word" : "words"} saved
          </p>
          {reviewLine && (
            <p data-testid="vocab-nudge" className="mt-0.5 text-sm font-medium text-primary-700">
              {reviewLine}
            </p>
          )}
        </div>
        {showReviewButton && (
          <Link
            href="/vocabulary/review"
            className="rounded-xl bg-white px-3.5 py-2 text-sm font-semibold text-primary-700 shadow-sm ring-1 ring-primary-500/30 transition-colors hover:bg-primary-50"
          >
            Start review
          </Link>
        )}
      </div>
      {terms.length > 0 ? (
        <ul aria-label="Recently saved words" className="mt-4 flex flex-wrap gap-2">
          {terms.map((t) => (
            <li key={t.id} title={t.sentence_context} className="max-w-full truncate rounded-full bg-primary-50 px-3 py-1 text-sm text-primary-700">
              {t.term}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-sm text-slate-500">Words you save while practicing will appear here.</p>
      )}
      <Link href="/vocabulary" className="mt-auto inline-flex items-center gap-1 self-start pt-5 text-sm font-semibold text-primary-600 hover:text-primary-700">
        View vocabulary <ArrowRight size={15} aria-hidden="true" />
      </Link>
    </section>
  );
}
