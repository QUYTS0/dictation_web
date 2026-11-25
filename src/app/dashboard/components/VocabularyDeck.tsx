"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import Link from "next/link";
import clsx from "clsx";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, BookOpen } from "lucide-react";
import { ReviewCard, ReviewGradeButtons, ReviewModeToggle } from "@/components/vocabulary/ReviewCard";
import { reviewShortcut, useReviewMode } from "@/components/vocabulary/reviewControls";
import { useToast } from "@/components/ToastProvider";
import type { FocusSource } from "@/lib/dashboard/selectFocus";
import { invalidateAfterVocabularyReview, submitVocabularyReview, useVocabularyReviewQueueQuery } from "@/lib/queries/vocabulary";
import type { ReviewGrade, VocabularyStatsResponse } from "@/lib/types";
import type { DashboardSummary } from "@/lib/types/learning";
import { vocabularyHeadline } from "./FocusCard";

const MAX_CHIPS = 8;
const MAX_RECENT = 6;

/**
 * The Dashboard's review deck (plan §1, §4.5.4, D8): one flashcard at a
 * time from the current review batch, graded in place through the same API
 * as /vocabulary/review — so a grade here IS a real review (and, with 046, a
 * practice day). Graded cards leave the batch optimistically; a failed save
 * puts the card back and says so.
 *
 * Keys (only while focus is inside the deck): Space/Enter flip, 1–4 grade.
 * `showReviewButton` follows the Dashboard's dedup rule: "Start review" is
 * not repeated here when Next up already offers it. Copy never claims a
 * queue order or batch size (the review queue guarantees neither).
 */
export function VocabularyDeck({
  userId,
  summary,
  vocab,
  showReviewButton,
}: {
  userId: string | undefined;
  summary: DashboardSummary | undefined;
  vocab: FocusSource<VocabularyStatsResponse>;
  showReviewButton: boolean;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const queue = useVocabularyReviewQueueQuery(userId);
  const [mode, setMode] = useReviewMode();
  const [graded, setGraded] = useState<ReadonlySet<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState<ReviewGrade | null>(null);
  const deckRef = useRef<HTMLElement>(null);

  const remaining = (queue.data ?? []).filter((item) => !graded.has(item.id));
  const current = remaining.find((item) => item.id === selectedId) ?? remaining[0] ?? null;
  const position = current ? remaining.indexOf(current) + 1 : 0;

  const stats = vocab.status === "ready" ? vocab.data : null;
  const saved = summary?.vocabularyCount ?? stats?.total ?? 0;
  const reviewLine =
    stats && stats.reviewable > 0 ? vocabularyHeadline(stats.due > 0 ? "due" : "new", stats.due) : stats && stats.total > 0 ? "Nothing to review right now" : null;

  // The control that had focus (the flip button, a grade) unmounts on these
  // transitions; keep focus in the deck so the keys keep working.
  const keepFocusInDeck = () => {
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (!active || active === document.body || !deckRef.current?.contains(active)) deckRef.current?.focus({ preventScroll: true });
    });
  };

  const flip = () => {
    setRevealed((r) => !r);
    keepFocusInDeck();
  };

  const grade = async (g: ReviewGrade) => {
    if (!current || busy) return;
    const item = current;
    setBusy(g);
    setGraded((prev) => new Set(prev).add(item.id));
    setSelectedId(null);
    setRevealed(false);
    keepFocusInDeck();
    try {
      await submitVocabularyReview(item.id, g);
      invalidateAfterVocabularyReview(queryClient, userId);
    } catch (err) {
      setGraded((prev) => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
      setSelectedId(item.id);
      toast({ message: `Couldn't save your review of "${item.term}"`, sub: err instanceof Error ? err.message : undefined, tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (!current) return;
    const action = reviewShortcut(e, revealed);
    if (!action) return;
    e.preventDefault();
    if (action.type === "flip") flip();
    else void grade(action.grade);
  };

  const recent = summary?.recentVocabulary.slice(0, MAX_RECENT) ?? [];

  return (
    <section
      ref={deckRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      aria-labelledby="vocabulary-heading"
      data-testid="vocabulary-card"
      className="@container rounded-2xl border border-line bg-white p-5 shadow-xs outline-none sm:p-6"
    >
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-surface text-primary-600" aria-hidden="true">
            <BookOpen size={16} />
          </span>
          <div>
            <h2 id="vocabulary-heading" className="text-base font-bold leading-tight text-ink">
              Review deck
            </h2>
            <p className="text-xs text-muted">
              {reviewLine && (
                <span data-testid="vocab-nudge" className="font-semibold text-amber-700">
                  {reviewLine}
                </span>
              )}
              {reviewLine && saved > 0 && " · "}
              {saved > 0 && <span>{`${saved} ${saved === 1 ? "word" : "words"} saved`}</span>}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {current && <ReviewModeToggle mode={mode} onChange={setMode} />}
          {showReviewButton && (
            <Link
              href="/vocabulary/review"
              className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-bold text-primary-600 transition-colors hover:border-primary-500/40 hover:bg-primary-50"
            >
              Start review <ArrowRight size={14} aria-hidden="true" />
            </Link>
          )}
        </div>
      </div>

      {queue.isPending ? (
        <div aria-busy="true" aria-label="Loading review cards" className="min-h-[170px] animate-pulse rounded-xl bg-surface" />
      ) : queue.isError && !queue.data ? (
        <p className="text-sm text-red-600">Couldn&apos;t load your review cards.</p>
      ) : current ? (
        <div className="grid gap-5 @3xl:grid-cols-12">
          <div className="space-y-3 @3xl:col-span-7">
            <ReviewCard
              key={current.id}
              item={current}
              mode={mode}
              revealed={revealed}
              onFlip={flip}
              caption={`Card ${position} of ${remaining.length}`}
            />
            {revealed && <ReviewGradeButtons item={current} onGrade={(g) => void grade(g)} busyGrade={busy} />}
          </div>
          <div className="space-y-3 @3xl:col-span-5">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted">Up next</p>
            <ul aria-label="Cards up next" className="flex flex-wrap gap-2">
              {remaining.slice(0, MAX_CHIPS).map((item) => {
                const selected = item.id === current.id;
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      aria-pressed={selected}
                      onClick={() => {
                        setSelectedId(item.id);
                        setRevealed(false);
                      }}
                      className={clsx(
                        "max-w-[16rem] truncate rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors",
                        selected ? "border-primary-600 bg-primary-600 text-white" : "border-line bg-surface text-ink hover:border-primary-500/40"
                      )}
                    >
                      {item.canonical_form ?? item.term}
                    </button>
                  </li>
                );
              })}
            </ul>
            {remaining.length > MAX_CHIPS && <p className="text-xs text-muted">+{remaining.length - MAX_CHIPS} more</p>}
            <p className="text-[11px] text-muted pointer-coarse:hidden">
              Keys: <kbd className="font-mono">Space</kbd> flip · <kbd className="font-mono">1</kbd>–<kbd className="font-mono">4</kbd> rate
            </p>
            <Link href="/vocabulary" className="inline-flex items-center gap-1 text-sm font-semibold text-primary-600 hover:text-primary-700">
              View vocabulary <ArrowRight size={15} aria-hidden="true" />
            </Link>
          </div>
        </div>
      ) : (
        <div data-testid="deck-empty" className="space-y-4">
          <p className="text-sm text-muted">
            {graded.size > 0
              ? `Done for now — you reviewed ${graded.size} ${graded.size === 1 ? "word" : "words"}.`
              : saved > 0
                ? "No cards to review right now. Words come back here when they're due."
                : "Words you save while practicing will appear here."}
          </p>
          {recent.length > 0 && (
            <ul aria-label="Recently saved words" className="flex flex-wrap gap-2">
              {recent.map((t) => (
                <li key={t.id} title={t.sentence_context} className="max-w-full truncate rounded-full bg-primary-50 px-3 py-1 text-sm text-primary-700">
                  {t.term}
                </li>
              ))}
            </ul>
          )}
          <Link href="/vocabulary" className="inline-flex items-center gap-1 text-sm font-semibold text-primary-600 hover:text-primary-700">
            View vocabulary <ArrowRight size={15} aria-hidden="true" />
          </Link>
        </div>
      )}
    </section>
  );
}
