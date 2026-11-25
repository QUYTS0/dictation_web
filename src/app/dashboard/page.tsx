"use client";

import { KeyboardEvent, MouseEvent, Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import { ArrowRight, X } from "lucide-react";
import AppHeader from "@/components/AppHeader";
import AppFooter from "@/components/AppFooter";
import { AddVideoForm } from "@/components/AddVideoForm";
import { useAuth } from "@/context/auth";
import { PAGE_PADDING_CLASS, PAGE_WIDTH_CLASS } from "@/lib/layout/pageWidth";
import { toFocusSource } from "@/lib/dashboard/selectFocus";
import { useDashboardFocus } from "@/lib/dashboard/useDashboardFocus";
import { ContinueLearningCard } from "./components/ContinueLearningCard";
import { DashboardHero } from "./components/DashboardHero";
import { FirstRunHero } from "./components/FirstRunHero";
import { FocusCard } from "./components/FocusCard";
import { LearningPerformance } from "./components/LearningPerformance";
import { NeedsAttentionCard } from "./components/NeedsAttentionCard";
import { VocabularyDeck } from "./components/VocabularyDeck";
import { WeeklyRecapBanner } from "./components/WeeklyRecapBanner";
import { useDashboardCelebrations } from "./components/useDashboardCelebrations";
import { useScrollRestoration } from "@/hooks/useScrollRestoration";
import { useDashboardSummaryQuery, useDashboardErrorPatternsQuery, useDashboardWeekQuery } from "@/lib/queries/dashboard";
import { useContinueLearningQuery } from "@/lib/queries/videoLibrary";
import { useXpQuery } from "@/lib/queries/xp";

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
 * The learner's home (.claude/dashboard-redesign-plan.md). It answers, in
 * this order:
 *   0. How am I doing today?     — the hero: welcome, streak status, this
 *                                  week's track, Today's target, level, and
 *                                  "Start today's practice" (a NEW video);
 *                                  last week's recap above it once a week
 *   1. What should I continue?   — "Pick up where you left off" (ONE item)
 *   2. What should I do next?    — "Next up" (the Focus decision)
 *   3. Words to review           — the review deck (graded in place)
 *   4. Am I making progress?     — Learning performance, then error diagnostics
 * A learner with nothing yet sees only the first-run hero. Browsing saved
 * videos is My Learning (/library); past activity is History. Every metric
 * is its own canonical number (§6.8), never recomputed or blended here.
 */
function DashboardContent() {
  const pathname = usePathname();
  const { user, loading, openAuthModal } = useAuth();
  const userId = user?.id;
  const [url, setUrl] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  // Focus hand-offs across the disclosure's mount/unmount: what to do with
  // the input once the form mounts, and returning focus to the toggle on close.
  const pendingInputFocus = useRef<"toggle" | "scroll" | null>(null);
  const returnFocusToToggle = useRef(false);
  const addVideoInputRef = useRef<HTMLInputElement>(null);
  const addToggleRef = useRef<HTMLButtonElement>(null);

  const summaryQuery = useDashboardSummaryQuery(userId);
  const summary = summaryQuery.data;
  const weekQuery = useDashboardWeekQuery(userId);
  const xp = useXpQuery(userId).data;
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

  const openAddVideo = (how: "toggle" | "scroll") => {
    if (addOpen) return focusAddVideoInputEl(addVideoInputRef.current, how); // already open: just bring it into view
    pendingInputFocus.current = how;
    setAddOpen(true);
  };
  // Collapsing keeps whatever was typed (state lives here, not in the form).
  const closeAddVideo = () => {
    returnFocusToToggle.current = true;
    setAddOpen(false);
  };
  const onAddKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
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
      <div className="rounded-2xl border border-line bg-white p-5 text-sm text-red-600">Couldn&apos;t load your unfinished videos.</div>
    ) : !continueQuery.data ? (
      <div aria-busy="true" aria-label="Loading continue learning" className="min-h-[180px] animate-pulse rounded-2xl border border-line bg-white" />
    ) : continueTop ? (
      <ContinueLearningCard item={continueTop} />
    ) : summary && summary.libraryVideos > 0 ? (
      <div data-testid="continue-empty" className="rounded-2xl border border-line bg-white p-5 text-sm text-muted shadow-xs sm:p-6">
        Nothing unfinished right now.{" "}
        <Link href="/library" className="inline-flex items-center gap-1 font-semibold text-primary-600 hover:text-primary-700">
          Browse My Learning <ArrowRight size={14} aria-hidden="true" />
        </Link>
      </div>
    ) : null;
  const focusShown = focus.kind !== "hidden";
  const name = user?.email?.split("@")[0] ?? "Learner";
  // Nothing yet at all — no videos, no study sessions, no saved words — gets
  // the first-run hero and nothing else (plan §4.5.3). A learner who removed
  // every video but has history still gets the normal Dashboard. Unknown
  // (summary failed) is never treated as "nothing yet".
  const firstRun = !!summary && summary.libraryVideos === 0 && summary.activeTime.sessionCount === 0 && summary.vocabularyCount === 0;
  // Goal met / level up (once per browser); a first-run learner has neither yet.
  const celebrationBurst = useDashboardCelebrations(firstRun ? undefined : userId, weekQuery.data, xp);
  const summaryPending = !summary && !summaryQuery.isError;

  const addPanel = (
    <section id="add-video" className="scroll-mt-24" aria-labelledby="add-video-heading" onKeyDown={onAddKeyDown}>
      <div className="mb-2 flex items-center justify-between">
        <h2 id="add-video-heading" className="text-xs font-semibold uppercase tracking-wider text-slate-300">
          Start a new video
        </h2>
        <button
          type="button"
          onClick={closeAddVideo}
          aria-label="Close add a video"
          className="rounded-lg p-1 text-slate-400 transition-colors hover:bg-white/10 hover:text-white"
        >
          <X size={16} />
        </button>
      </div>
      <AddVideoForm url={url} onUrlChange={setUrl} variant="dark" layout="stacked" inputId="add-video-url" inputRef={addVideoInputRef} />
    </section>
  );

  return (
    <div className="relative flex min-h-screen w-full flex-1 flex-col bg-page font-sans text-ink antialiased">
      <div className="flex flex-1 flex-col">
        <AppHeader active="dashboard" />

        <main className={clsx("mx-auto flex w-full flex-1 flex-col gap-8 py-8 sm:gap-10", PAGE_WIDTH_CLASS.wide, PAGE_PADDING_CLASS.wide)}>
          {loading ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : !user ? (
            <section className="rounded-2xl border border-line bg-white p-8 shadow-xs">
              <h1 className="text-2xl font-bold tracking-tight text-ink">Dashboard</h1>
              <p className="mt-2 text-sm text-muted">Sign in to see your progress and continue where you left off.</p>
              <button
                onClick={openAuthModal}
                className="mt-4 rounded-xl bg-primary-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary-700"
              >
                Sign in
              </button>
            </section>
          ) : firstRun ? (
            <FirstRunHero url={url} onUrlChange={setUrl} />
          ) : (
            <>
              {/* Last week's recap: first visit of a new league week only. */}
              {userId && xp && <WeeklyRecapBanner userId={userId} xp={xp} />}

              {/* Hero: welcome, streak status and the week; today's panel with "Start today's practice". */}
              {summaryPending ? (
                <div aria-busy="true" aria-label="Loading your dashboard" className="min-h-[148px] animate-pulse rounded-2xl bg-hero/90" />
              ) : (
                <DashboardHero
                  name={name}
                  summary={summary}
                  week={weekQuery.data}
                  weekPending={weekQuery.isPending}
                  xp={xp}
                  celebrationBurst={celebrationBurst}
                  addOpen={addOpen}
                  onToggleAdd={() => (addOpen ? closeAddVideo() : openAddVideo("toggle"))}
                  addToggleRef={addToggleRef}
                  addPanel={addPanel}
                />
              )}

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

              {/* 3. The review deck. Full width until the league card (Phase 7)
                  takes the right third; the deck adapts to its own width. */}
              <VocabularyDeck userId={userId} summary={summary} vocab={vocab} showReviewButton={showVocabReviewButton} />

              {/* 4. Learning performance — the canonical metrics, each its own card. */}
              {summaryQuery.isError && !summary ? (
                <p className="text-sm text-red-600">Failed to load your progress. Please refresh and try again.</p>
              ) : summary ? (
                <LearningPerformance summary={summary} week={weekQuery.data} />
              ) : (
                <div aria-busy="true" aria-label="Loading your progress" className="min-h-[168px] animate-pulse rounded-2xl border border-line bg-white" />
              )}

              {/* 5. Error diagnostics. Full width until achievements (Phase 6) take the right third. */}
              <NeedsAttentionCard userId={userId} patterns={errorPatternsData?.patterns ?? []} loading={errorPatternsLoading} />
            </>
          )}
        </main>
        <AppFooter />
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
