"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Headphones } from "lucide-react";
import UserButton from "@/components/UserButton";
import { ReviewCard, ReviewGradeButtons, ReviewModeToggle } from "@/components/vocabulary/ReviewCard";
import { reviewShortcut, useReviewMode } from "@/components/vocabulary/reviewControls";
import { useAuth } from "@/context/auth";
import { invalidateAfterVocabularyReview, submitVocabularyReview } from "@/lib/queries/vocabulary";
import type { ReviewGrade, VocabularyItem } from "@/lib/types";

export default function VocabularyReviewPage() {
  const { user, loading, openAuthModal } = useAuth();
  const queryClient = useQueryClient();
  const [queue, setQueue] = useState<VocabularyItem[]>([]);
  const [loadingQueue, setLoadingQueue] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [submittingGrade, setSubmittingGrade] = useState<ReviewGrade | null>(null);
  const [reviewedCount, setReviewedCount] = useState(0);
  const [mode, setMode] = useReviewMode();

  useEffect(() => {
    if (!user) return;
    fetch("/api/vocabulary/review")
      .then(async (res) => {
        if (!res.ok) throw new Error();
        return res.json();
      })
      .then((data) => setQueue(data.items ?? []))
      .catch(() => setError("Failed to load items due for review."))
      .finally(() => setLoadingQueue(false));
  }, [user]);

  const current = queue[0];

  const handleGrade = async (grade: ReviewGrade) => {
    if (!current || submittingGrade) return;
    setSubmittingGrade(grade);
    setError(null);
    try {
      await submitVocabularyReview(current.id, grade);
      setQueue((prev) => prev.slice(1));
      setReviewedCount((n) => n + 1);
      setRevealed(false);
      // The Vocabulary Bank, its counts and — a review being a practice day
      // (migration 046) — the streak and Dashboard catch up on next view.
      invalidateAfterVocabularyReview(queryClient, user?.id);
    } catch (err: unknown) {
      const message = err instanceof Error && err.message ? err.message : "Failed to save review.";
      setError(message);
    } finally {
      setSubmittingGrade(null);
    }
  };

  // Page-wide review keys: Space/Enter flip, 1–4 grade (never while typing).
  useEffect(() => {
    if (!current) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const action = reviewShortcut(e, revealed);
      if (!action) return;
      e.preventDefault();
      if (action.type === "flip") setRevealed((r) => !r);
      else void handleGrade(action.grade);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  return (
    <div className="relative z-10 flex min-h-screen w-full flex-1 flex-col bg-page">
      <header className="sticky top-0 z-20 w-full shrink-0 border-b border-line bg-white/95 px-6 py-4 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/vocabulary" aria-label="Back to Vocabulary" className="flex items-center gap-2 text-muted hover:text-primary-600">
              <ArrowLeft size={18} />
            </Link>
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-600 text-white shadow-sm">
                <Headphones size={18} />
              </div>
              <span className="text-lg font-bold tracking-tight text-ink">Vocabulary Review</span>
            </div>
          </div>
          <UserButton />
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center gap-6 px-4 py-10">
        {loading ? null : !user ? (
          <section className="w-full rounded-2xl border border-line bg-white p-8 shadow-xs">
            <h1 className="text-2xl font-bold tracking-tight text-ink">Vocabulary Review</h1>
            <p className="mt-2 text-sm text-muted">Sign in to review your saved vocabulary.</p>
            <button
              onClick={openAuthModal}
              className="mt-4 rounded-xl bg-primary-600 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-700"
            >
              Sign in
            </button>
          </section>
        ) : loadingQueue ? (
          <p className="text-sm text-muted">Loading items due for review…</p>
        ) : error && !current ? (
          <p className="text-sm text-red-600">{error}</p>
        ) : !current ? (
          <section className="w-full rounded-2xl border border-line bg-white p-8 text-center shadow-xs">
            <p className="text-3xl">🎉</p>
            {/* This session's queue is a capped batch (REVIEW_BATCH_SIZE in
                GET /api/vocabulary/review), not the full due backlog —
                finishing it doesn't guarantee nothing else is due, so once
                the user has actually reviewed something this deliberately
                avoids claiming "nothing due". That claim is only accurate
                when the queue was empty from the very first fetch. */}
            <h1 className="mt-2 text-xl font-bold text-ink">{reviewedCount > 0 ? "Session complete" : "Nothing due for review"}</h1>
            <p className="mt-2 text-sm text-muted">
              {reviewedCount > 0
                ? `You reviewed ${reviewedCount} item${reviewedCount === 1 ? "" : "s"}. Check the Vocabulary Bank to keep going.`
                : "You're all caught up. Saved vocabulary reappears here as it becomes due."}
            </p>
            <Link
              href="/vocabulary"
              className="mt-4 inline-block rounded-xl bg-primary-600 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-700"
            >
              Back to Vocabulary Bank
            </Link>
          </section>
        ) : (
          <>
            <div className="flex w-full flex-wrap items-center justify-between gap-3">
              {/* Remaining items in this loaded (capped) queue — a session
                  progress count, not the user's full review backlog. */}
              <p className="text-sm font-medium text-muted">{queue.length} left in this session</p>
              <ReviewModeToggle mode={mode} onChange={setMode} />
            </div>
            {error ? <p className="text-sm text-red-600">{error}</p> : null}
            <div className="w-full">
              <ReviewCard key={current.id} item={current} mode={mode} revealed={revealed} onFlip={() => setRevealed((r) => !r)} size="large" />
            </div>
            {revealed && (
              <div className="w-full">
                <ReviewGradeButtons item={current} onGrade={(g) => void handleGrade(g)} busyGrade={submittingGrade} size="large" />
              </div>
            )}
            <p className="text-xs text-muted">
              Keys: <kbd className="font-mono">Space</kbd> flip · <kbd className="font-mono">1</kbd>–<kbd className="font-mono">4</kbd> rate
            </p>
          </>
        )}
      </main>
    </div>
  );
}
