"use client";

import { FormEvent, KeyboardEvent, MouseEvent, Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import clsx from "clsx";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Flame, Plus, Video, X } from "lucide-react";
import AppHeader from "@/components/AppHeader";
import { useAuth } from "@/context/auth";
import { PAGE_PADDING_CLASS, PAGE_WIDTH_CLASS } from "@/lib/layout/pageWidth";
import { toFocusSource } from "@/lib/dashboard/selectFocus";
import { useDashboardFocus } from "@/lib/dashboard/useDashboardFocus";
import { ContinueLearningCard } from "./components/ContinueLearningCard";
import { FocusCard } from "./components/FocusCard";
import { NeedsAttentionCard } from "./components/NeedsAttentionCard";
import { ProgressSummary } from "./components/ProgressSummary";
import { VocabularyCard } from "./components/VocabularyCard";
import { useScrollRestoration } from "@/hooks/useScrollRestoration";
import { useDashboardSummaryQuery, useDashboardErrorPatternsQuery } from "@/lib/queries/dashboard";
import { invalidateLearningViews } from "@/lib/queries/learningInvalidation";
import { useContinueLearningQuery } from "@/lib/queries/videoLibrary";
import { isValidYouTubeUrl } from "@/lib/utils/url";

const prefersReducedMotion = () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * "scroll" (Next Up's CTA, possibly far from the form): scroll the input into
 * view honoring reduced motion, then focus without a second jump. "toggle":
 * the input is right under the toggle — just focus it.
 */
function focusAddVideoInputEl(input: HTMLInputElement | null, how: "toggle" | "scroll") {
  if (!input) return;
  if (how === "scroll") input.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "center" });
  input.focus({ preventScroll: how === "scroll" });
}

/**
 * The learner's home. It answers, in this order:
 *   1. What should I continue?   — "Pick up where you left off" (ONE item)
 *   2. What should I do next?    — "Next up" (the Focus decision)
 *   3. Am I making progress?     — "Your progress", Vocabulary, Needs attention
 * Adding a video is a secondary, on-demand action. Browsing saved videos is
 * My Learning (/library); past activity is History. Every metric is its own
 * canonical number (§6.8), never recomputed or blended here.
 */
function DashboardContent() {
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const { user, loading, openAuthModal } = useAuth();
  const userId = user?.id;
  const [url, setUrl] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  // Focus hand-offs across the disclosure's mount/unmount: what to do with
  // the input once the form mounts, and returning focus to the toggle on close.
  const pendingInputFocus = useRef<"toggle" | "scroll" | null>(null);
  const returnFocusToToggle = useRef(false);
  const addVideoInputRef = useRef<HTMLInputElement>(null);
  const addToggleRef = useRef<HTMLButtonElement>(null);

  const summaryQuery = useDashboardSummaryQuery(userId);
  const summary = summaryQuery.data;
  const continueQuery = useContinueLearningQuery(userId);
  const { data: errorPatternsData, isLoading: errorPatternsLoading } = useDashboardErrorPatternsQuery(userId);

  useScrollRestoration(pathname, userId, !summaryQuery.isLoading && !continueQuery.isLoading);

  useEffect(() => {
    if (addOpen && pendingInputFocus.current) {
      focusAddVideoInputEl(addVideoInputRef.current, pendingInputFocus.current);
      pendingInputFocus.current = null;
    } else if (!addOpen && returnFocusToToggle.current) {
      returnFocusToToggle.current = false;
      addToggleRef.current?.focus();
    }
  }, [addOpen]);

  const handleAdd = async (e: FormEvent) => {
    e.preventDefault();
    setAddError(null);
    const trimmed = url.trim();
    if (!trimmed) return setAddError("Please paste a YouTube URL.");
    if (!isValidYouTubeUrl(trimmed)) return setAddError("That doesn't look like a valid YouTube URL.");
    setAdding(true);
    try {
      const res = await fetch("/api/video/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: trimmed }),
      });
      const data = await res.json();
      if (!res.ok || data.status !== "ok") {
        setAddError(data.message ?? "Failed to add the video. Please try again.");
        return;
      }
      if (userId) invalidateLearningViews(queryClient, userId);
      // The practice page chooses the mode (saved last mode, else Dictation).
      router.push(`/dictation/${data.videoId}`);
    } catch {
      setAddError("Network error. Please check your connection and try again.");
    } finally {
      setAdding(false);
    }
  };

  const openAddVideo = (how: "toggle" | "scroll") => {
    if (addOpen) return focusAddVideoInputEl(addVideoInputRef.current, how); // already open: just bring it into view
    pendingInputFocus.current = how;
    setAddOpen(true);
  };
  // Collapsing keeps whatever was typed (state lives here, not in the form).
  const closeAddVideo = () => {
    returnFocusToToggle.current = true;
    setAddOpen(false);
    setAddError(null);
  };
  const onAddKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !adding) {
      e.preventDefault();
      closeAddVideo();
    }
  };

  // The ONE resume item — the same top item Focus evaluates for sentences.
  const continueTop = continueQuery.data?.items[0] ?? null;
  const { result: focus, vocab } = useDashboardFocus(userId, {
    continueItems: toFocusSource({ data: continueQuery.data?.items, isError: continueQuery.isError }),
    summary: toFocusSource(summaryQuery),
  });
  // Dedup: Next Up owns "Start review" when it is about vocabulary; while it
  // is still deciding, no button either (no flash of a duplicate). Next to a
  // sentence Next Up, the review is a different action, so it may appear.
  const showVocabReviewButton = vocab.status === "ready" && vocab.data.reviewable > 0 && focus.kind === "sentences";

  // Next Up's "Add a video": open the one form and bring its input into view.
  const focusAddVideoInput = (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    openAddVideo("scroll");
  };

  // Primary slot: the resume card, a load/error state, a pointer to My
  // Learning when there is saved content but nothing unfinished, or nothing.
  const continueSlot =
    continueQuery.isError && !continueQuery.data ? (
      <div className="rounded-3xl border border-slate-200/70 bg-white/60 p-5 text-sm text-red-600">Couldn&apos;t load your unfinished videos.</div>
    ) : !continueQuery.data ? (
      <div aria-busy="true" aria-label="Loading continue learning" className="min-h-[180px] animate-pulse rounded-3xl border border-primary-100 bg-primary-50/50" />
    ) : continueTop ? (
      <ContinueLearningCard item={continueTop} />
    ) : summary && summary.libraryVideos > 0 ? (
      <div data-testid="continue-empty" className="rounded-3xl border border-slate-200/70 bg-white/60 p-5 text-sm text-slate-600 sm:p-6">
        Nothing unfinished right now.{" "}
        <Link href="/library" className="inline-flex items-center gap-1 font-semibold text-primary-600 hover:text-primary-700">
          Browse My Learning <ArrowRight size={14} aria-hidden="true" />
        </Link>
      </div>
    ) : null;
  const focusShown = focus.kind !== "hidden";
  const name = user?.email?.split("@")[0] ?? "Learner";
  const streak = summary?.streakDays ?? 0;

  return (
    <div className="relative flex min-h-screen w-full flex-1 flex-col overflow-hidden bg-[#f6f7fc] font-sans text-slate-900 antialiased">
      <div className="pointer-events-none absolute -left-[10%] -top-[10%] z-0 h-[40%] w-[40%] rounded-full bg-purple-200 opacity-40 blur-[120px]" />

      <div className="relative z-10 flex flex-1 flex-col">
        <AppHeader active="dashboard" />

        <main className={clsx("mx-auto flex w-full flex-1 flex-col gap-6 py-8 sm:gap-8", PAGE_WIDTH_CLASS.wide, PAGE_PADDING_CLASS.wide)}>
          {loading ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : !user ? (
            <section className="rounded-3xl border border-white/60 bg-white/40 p-8 shadow-xl backdrop-blur-xl">
              <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Dashboard</h1>
              <p className="mt-2 text-sm text-slate-500">Sign in to see your progress and continue where you left off.</p>
              <button
                onClick={openAuthModal}
                className="mt-4 rounded-xl bg-primary-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary-700"
              >
                Sign in
              </button>
            </section>
          ) : (
            <>
              {/* Welcome + momentum: the streak sits with the heading, not floating away from it. */}
              <section data-testid="dashboard-welcome" className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
                <div className="min-w-0">
                  <h1 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">Welcome back, {name}</h1>
                  <p className="mt-1 text-sm text-slate-500 sm:text-base">
                    {!summary ? " " : streak > 0 ? `Ready to keep your ${streak}-day streak going?` : "Ready for today's practice?"}
                  </p>
                </div>
                {streak > 0 && (
                  <p data-testid="streak" className="inline-flex items-center gap-1.5 rounded-full bg-orange-50 px-3 py-1.5 text-sm font-semibold text-orange-600 ring-1 ring-orange-100">
                    <Flame size={16} className="fill-orange-500/20" aria-hidden="true" /> {streak} {streak === 1 ? "day" : "days"}
                  </p>
                )}
              </section>

              {/* 1 + 2. The primary resume action and the next action (≈ 2/3 : 1/3 on desktop). */}
              {(continueSlot || focusShown) && (
                <div
                  data-testid="dashboard-actions"
                  className={clsx("grid items-start gap-4 sm:gap-5", continueSlot && focusShown ? "lg:grid-cols-12" : "w-full max-w-3xl")}
                >
                  {continueSlot && <div className={clsx("min-w-0", focusShown && "lg:col-span-8")}>{continueSlot}</div>}
                  {focusShown && (
                    <div className={clsx("min-w-0", continueSlot && "lg:col-span-4")}>
                      <FocusCard focus={focus} onAddVideo={focusAddVideoInput} />
                    </div>
                  )}
                </div>
              )}

              {/* Add Video — secondary, on demand: one URL field, no mode selection. */}
              <div className="-mt-2 flex flex-col items-stretch gap-3 sm:items-end">
                {!addOpen ? (
                  <button
                    ref={addToggleRef}
                    type="button"
                    onClick={() => openAddVideo("toggle")}
                    aria-expanded={false}
                    aria-controls="add-video"
                    className="inline-flex items-center justify-center gap-1.5 self-start rounded-xl px-3 py-2 text-sm font-semibold text-primary-700 transition-colors hover:bg-primary-50 sm:self-end"
                  >
                    <Plus size={16} aria-hidden="true" /> Add a video
                  </button>
                ) : (
                  <section
                    id="add-video"
                    className="w-full scroll-mt-24 rounded-3xl border border-slate-200/70 bg-white/70 p-4 sm:max-w-2xl"
                    aria-labelledby="add-video-heading"
                    onKeyDown={onAddKeyDown}
                  >
                    <div className="mb-3 flex items-center justify-between">
                      <h2 id="add-video-heading" className="text-sm font-semibold text-slate-900">
                        Add a video
                      </h2>
                      <button
                        type="button"
                        onClick={closeAddVideo}
                        aria-label="Close add a video"
                        className="rounded-lg p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
                      >
                        <X size={16} />
                      </button>
                    </div>
                    <form onSubmit={handleAdd} className="flex flex-col gap-3 sm:flex-row">
                      <div className="relative flex flex-1 items-center">
                        <Video className="absolute left-4 text-slate-400" size={20} aria-hidden="true" />
                        <input
                          id="add-video-url"
                          ref={addVideoInputRef}
                          type="text"
                          value={url}
                          onChange={(e) => {
                            setUrl(e.target.value);
                            setAddError(null);
                          }}
                          placeholder="Paste a YouTube URL"
                          aria-label="YouTube URL"
                          className="w-full rounded-xl border border-slate-200 bg-white py-3 pr-4 pl-12 text-base text-slate-900 placeholder:text-slate-400 outline-none focus:ring-2 focus:ring-primary-500/30"
                        />
                      </div>
                      <button
                        type="submit"
                        disabled={adding}
                        className="flex items-center justify-center gap-2 whitespace-nowrap rounded-xl bg-primary-600 px-6 py-3 font-medium text-white shadow-sm transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {adding ? "Adding…" : "Add video"} {!adding && <ArrowRight size={18} aria-hidden="true" />}
                      </button>
                    </form>
                    {addError && <p className="mt-3 text-sm text-red-600">⚠ {addError}</p>}
                  </section>
                )}
              </div>

              {/* 3. Your progress — one surface for the six canonical metrics. */}
              {summaryQuery.isError && !summary ? (
                <p className="text-sm text-red-600">Failed to load your progress. Please refresh and try again.</p>
              ) : summary ? (
                <ProgressSummary summary={summary} />
              ) : (
                <div aria-busy="true" aria-label="Loading your progress" className="min-h-[168px] animate-pulse rounded-3xl border border-slate-200/70 bg-white/50" />
              )}

              {/* 4. Vocabulary momentum + Needs attention. Stacked below lg. */}
              <div className="grid items-stretch gap-4 sm:gap-5 lg:grid-cols-12" data-testid="dashboard-insights">
                <div className="min-w-0 lg:col-span-7">
                  <VocabularyCard summary={summary} vocab={vocab} showReviewButton={showVocabReviewButton} />
                </div>
                <div className="min-w-0 lg:col-span-5">
                  <NeedsAttentionCard patterns={errorPatternsData?.patterns ?? []} loading={errorPatternsLoading} />
                </div>
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  return (
    <Suspense fallback={<p className="p-8 text-sm text-slate-500">Loading…</p>}>
      <DashboardContent />
    </Suspense>
  );
}
