"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Headphones } from "lucide-react";
import UserButton from "@/components/UserButton";
import { useAuth } from "@/context/auth";
import type { ReviewGrade, VocabularyItem } from "@/lib/types";

const GRADE_OPTIONS: { grade: ReviewGrade; label: string; className: string }[] = [
  { grade: "again", label: "Again", className: "bg-red-600 hover:bg-red-700" },
  { grade: "hard", label: "Hard", className: "bg-amber-600 hover:bg-amber-700" },
  { grade: "good", label: "Good", className: "bg-emerald-600 hover:bg-emerald-700" },
  { grade: "easy", label: "Easy", className: "bg-indigo-600 hover:bg-indigo-700" },
];

export default function VocabularyReviewPage() {
  const { user, loading, openAuthModal } = useAuth();
  const [queue, setQueue] = useState<VocabularyItem[]>([]);
  const [loadingQueue, setLoadingQueue] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [submittingGrade, setSubmittingGrade] = useState<ReviewGrade | null>(null);
  const [reviewedCount, setReviewedCount] = useState(0);

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
    if (!current) return;
    setSubmittingGrade(grade);
    setError(null);
    try {
      const res = await fetch("/api/vocabulary/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId: current.id, grade }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || "Failed to save review.");
      }
      setQueue((prev) => prev.slice(1));
      setReviewedCount((n) => n + 1);
      setRevealed(false);
    } catch (err: unknown) {
      const message = err instanceof Error && err.message ? err.message : "Failed to save review.";
      setError(message);
    } finally {
      setSubmittingGrade(null);
    }
  };

  return (
    <div className="relative z-10 flex min-h-screen w-full flex-1 flex-col bg-slate-50">
      <header className="sticky top-0 z-20 w-full shrink-0 border-b border-white/40 bg-white/30 px-6 py-4 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/vocabulary" className="flex items-center gap-2 text-slate-500 hover:text-indigo-600">
              <ArrowLeft size={18} />
            </Link>
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-white shadow-lg shadow-indigo-200">
                <Headphones size={18} />
              </div>
              <span className="text-lg font-bold tracking-tight text-slate-900">Vocabulary Review</span>
            </div>
          </div>
          <UserButton />
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center gap-6 px-4 py-10">
        {loading ? null : !user ? (
          <section className="w-full rounded-3xl border border-white/60 bg-white/40 p-8 shadow-xl backdrop-blur-xl">
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">Vocabulary Review</h1>
            <p className="mt-2 text-sm text-slate-500">Sign in to review your saved vocabulary.</p>
            <button
              onClick={openAuthModal}
              className="mt-4 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
            >
              Sign in
            </button>
          </section>
        ) : loadingQueue ? (
          <p className="text-sm text-slate-500">Loading items due for review…</p>
        ) : error && !current ? (
          <p className="text-sm text-red-600">{error}</p>
        ) : !current ? (
          <section className="w-full rounded-3xl border border-white/60 bg-white/40 p-8 text-center shadow-xl backdrop-blur-xl">
            <p className="text-3xl">🎉</p>
            <h1 className="mt-2 text-xl font-bold text-slate-900">Nothing due for review</h1>
            <p className="mt-2 text-sm text-slate-500">
              {reviewedCount > 0
                ? `You reviewed ${reviewedCount} item${reviewedCount === 1 ? "" : "s"}. Come back later for more.`
                : "You're all caught up. Saved vocabulary reappears here as it becomes due."}
            </p>
            <Link
              href="/vocabulary"
              className="mt-4 inline-block rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
            >
              Back to Vocabulary Bank
            </Link>
          </section>
        ) : (
          <>
            <p className="text-sm font-medium text-slate-500">{queue.length} due</p>
            {error ? <p className="text-sm text-red-600">{error}</p> : null}
            <div className="w-full rounded-3xl border border-white/60 bg-white/50 p-10 text-center shadow-xl backdrop-blur-xl">
              <h2 className="text-3xl font-bold text-indigo-900">{current.term}</h2>
              {revealed ? (
                <div className="mt-6 flex flex-col gap-3">
                  <div className="rounded-xl border border-white/40 bg-white/40 p-4 shadow-inner">
                    <p className="italic leading-relaxed text-slate-600">&quot;{current.sentence_context}&quot;</p>
                  </div>
                  {current.note ? (
                    <p className="whitespace-pre-wrap text-sm font-medium text-slate-700">{current.note}</p>
                  ) : null}
                </div>
              ) : (
                <button
                  onClick={() => setRevealed(true)}
                  className="mt-6 rounded-xl border border-slate-300 bg-white px-5 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                >
                  Show answer
                </button>
              )}
            </div>

            {revealed && (
              <div className="grid w-full grid-cols-2 gap-3 sm:grid-cols-4">
                {GRADE_OPTIONS.map(({ grade, label, className }) => (
                  <button
                    key={grade}
                    onClick={() => handleGrade(grade)}
                    disabled={submittingGrade !== null}
                    className={`rounded-xl px-4 py-3 text-sm font-semibold text-white transition-colors disabled:opacity-50 ${className}`}
                  >
                    {submittingGrade === grade ? "Saving…" : label}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
