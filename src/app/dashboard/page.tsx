"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import { ArrowRight } from "lucide-react";
import AppHeader from "@/components/AppHeader";
import AppFooter from "@/components/AppFooter";
import { useNewVideoDialog } from "@/components/NewVideoDialog";
import { useAuth } from "@/context/auth";
import { PAGE_PADDING_CLASS, PAGE_WIDTH_CLASS } from "@/lib/layout/pageWidth";
import { goalToday, todayPlan, toSource } from "@/lib/dashboard/today";
import { prefersReducedMotion } from "@/lib/motion";
import { AchievementsCase } from "./components/AchievementsCase";
import { ContinueLearningCard } from "./components/ContinueLearningCard";
import { DashboardHero } from "./components/DashboardHero";
import { FirstRunHero } from "./components/FirstRunHero";
import { LeagueCard } from "./components/LeagueCard";
import { LearningPerformance } from "./components/LearningPerformance";
import { NeedsAttentionCard } from "./components/NeedsAttentionCard";
import { VocabularyDeck } from "./components/VocabularyDeck";
import { WeeklyRecapBanner } from "./components/WeeklyRecapBanner";
import { useDashboardCelebrations } from "./components/useDashboardCelebrations";
import { useScrollRestoration } from "@/hooks/useScrollRestoration";
import { useDashboardSummaryQuery, useDashboardErrorPatternsQuery, useDashboardWeekQuery } from "@/lib/queries/dashboard";
import { useContinueLearningQuery } from "@/lib/queries/videoLibrary";
import { useXpQuery } from "@/lib/queries/xp";
import { useAchievementsQuery } from "@/lib/queries/achievements";
import { useLeaderboardQuery } from "@/lib/queries/leaderboard";
import { useProfileQuery } from "@/lib/queries/profile";
import { useVocabularyStatsQuery } from "@/lib/queries/vocabulary";

/** Where each Today row goes: the card (or section) that owns the task. */
const JUMP_TARGET_ID = { practice: "continue-card", sentences: "continue-sentences", words: "review-deck" } as const;

/**
 * The Today list's jumps: scroll the card that owns the task into view
 * (honoring reduced motion), then focus it without a second jump, so its
 * keys work at once (e.g. the deck's Space / 1–4).
 */
function jumpToCard(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
  el.focus({ preventScroll: true });
}

/**
 * The learner's home (.claude/dashboard-redesign-plan.md). It answers, in
 * this order:
 *   0. What's left today?        — the hero: welcome, streak status, this
 *                                  week's track and level; the Today list
 *                                  (practice time, then minutes / sentences /
 *                                  words left, each going to its card, the
 *                                  first one amber) and "Start a new video"
 *                                  (amber only once nothing is left); last
 *                                  week's recap above it
 *   1. What should I continue?   — "Pick up where you left off" (ONE item,
 *                                  with its sentences to look at again)
 *   2. Words to review           — the review deck (graded in place)
 *      This week's league runs beside both on large screens (D14).
 *   3. Am I making progress?     — Learning performance, then error diagnostics
 *                                  beside the achievements
 * Each task has ONE home: no card repeats another (the old Next up card did).
 * A learner with nothing yet sees only the first-run hero. Browsing saved
 * videos is My Learning (/library); past activity is History. Every metric
 * is its own canonical number (§6.8), never recomputed or blended here.
 */
function DashboardContent() {
  const pathname = usePathname();
  const { user, loading, openAuthModal } = useAuth();
  const userId = user?.id;
  // The first-run hero's link field.
  const [url, setUrl] = useState("");
  // "Start a new video" opens the app's one New video dialog, the header's.
  const newVideo = useNewVideoDialog();

  const summaryQuery = useDashboardSummaryQuery(userId);
  const summary = summaryQuery.data;
  const weekQuery = useDashboardWeekQuery(userId);
  const xp = useXpQuery(userId).data;
  const achievementsQuery = useAchievementsQuery(userId);
  const leagueQuery = useLeaderboardQuery(userId, "week");
  const profile = useProfileQuery(userId).data;
  const continueQuery = useContinueLearningQuery(userId);
  const vocab = toSource(useVocabularyStatsQuery(userId));
  const { data: errorPatternsData, isLoading: errorPatternsLoading } = useDashboardErrorPatternsQuery(userId);

  useScrollRestoration(pathname, userId, !summaryQuery.isLoading && !continueQuery.isLoading);

  // The ONE resume item; its round's sentences to look at again live in its card.
  const continueTop = continueQuery.data?.items[0] ?? null;
  // The deck owns "Start review" (the Today list only jumps to it).
  const showVocabReviewButton = vocab.status === "ready" && vocab.data.reviewable > 0;
  // What's left today and the hero's one amber action (plan §4.5.9, §4.5.11).
  // Unknown sources stay unknown, never "nothing left".
  const today = todayPlan({
    resume: toSource({ data: continueQuery.data ? continueTop : undefined, isError: continueQuery.isError }),
    words: vocab,
    wordsReviewedToday: xp ? (xp.days.find((d) => d.date === xp.today)?.activity.wordsReviewed ?? 0) : null,
    goal: weekQuery.data ? { status: "ready", data: goalToday(weekQuery.data) } : weekQuery.isError ? { status: "error" } : { status: "pending" },
  });

  // Primary slot: the resume card, a load/error state, a pointer to My
  // Learning when there is saved content but nothing unfinished, or nothing.
  const continueSlot =
    continueQuery.isError && !continueQuery.data ? (
      <div className="rounded-2xl border border-line bg-white p-5 text-sm text-red-600">Couldn&apos;t load your unfinished videos.</div>
    ) : !continueQuery.data ? (
      <div aria-busy="true" aria-label="Loading continue learning" className="min-h-[180px] animate-pulse rounded-2xl border border-line bg-white" />
    ) : continueTop ? (
      <ContinueLearningCard item={continueTop} userId={userId} />
    ) : summary && summary.libraryVideos > 0 ? (
      <div data-testid="continue-empty" className="rounded-2xl border border-line bg-white p-5 text-sm text-muted shadow-xs sm:p-6">
        Nothing unfinished right now.{" "}
        <Link href="/library" className="inline-flex items-center gap-1 font-semibold text-primary-600 hover:text-primary-700">
          Browse My Learning <ArrowRight size={14} aria-hidden="true" />
        </Link>
      </div>
    ) : null;
  // The public name when the learner chose one (Profile & preferences), else the email's local part.
  const name = profile?.publicName ?? user?.email?.split("@")[0] ?? "Learner";
  // Nothing yet at all — no videos, no study sessions, no saved words — gets
  // the first-run hero and nothing else (plan §4.5.3). A learner who removed
  // every video but has history still gets the normal Dashboard. Unknown
  // (summary failed) is never treated as "nothing yet".
  const firstRun = !!summary && summary.libraryVideos === 0 && summary.activeTime.sessionCount === 0 && summary.vocabularyCount === 0;
  // Goal met / level up (once per browser); a first-run learner has neither yet.
  const celebrationBurst = useDashboardCelebrations(firstRun ? undefined : userId, weekQuery.data, xp);
  const summaryPending = !summary && !summaryQuery.isError;
  // Achievements: the case, a placeholder while loading, or nothing when
  // unavailable (e.g. migration 049 not applied) — never empty tiles.
  // League: the card, a placeholder while loading, or nothing when unavailable (050 not applied).
  const leagueAvailable = (!!leagueQuery.data && !!userId) || leagueQuery.isPending;
  // Plan D14: the league runs beside the resume card AND the deck, taking
  // their height (it lists as many rows as fit). With no resume card (nothing
  // unfinished, or it failed) it sits beside the deck only, as a plain card —
  // never alone. While Continue is still loading it waits beside its placeholder.
  const leagueTall = leagueAvailable && !!continueSlot && (continueQuery.data ? !!continueTop : !continueQuery.isError);
  const leagueSlot =
    leagueQuery.data && userId ? (
      <LeagueCard userId={userId} board={leagueQuery.data} fill={leagueTall} />
    ) : leagueQuery.isPending ? (
      <div aria-busy="true" aria-label="Loading your league" className="h-full min-h-[320px] animate-pulse rounded-2xl border border-line bg-white" />
    ) : null;
  const deckSlot = <VocabularyDeck userId={userId} summary={summary} vocab={vocab} showReviewButton={showVocabReviewButton} />;
  const achievementsSlot = achievementsQuery.data ? (
    <AchievementsCase tracks={achievementsQuery.data.tracks} />
  ) : achievementsQuery.isPending ? (
    <div aria-busy="true" aria-label="Loading achievements" className="min-h-[260px] animate-pulse rounded-2xl border border-line bg-white" />
  ) : null;

  return (
    <div className="relative flex min-h-screen w-full flex-1 flex-col bg-page font-sans text-ink antialiased">
      <div className="flex flex-1 flex-col">
        <AppHeader active="dashboard" />
        {newVideo.dialog}

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
              {userId && xp && <WeeklyRecapBanner userId={userId} xp={xp} leagueLastWeek={leagueQuery.data?.lastWeek ?? null} />}

              {/* Hero: welcome, streak status and the week; the Today list, level and "Start a new video". */}
              {summaryPending ? (
                <div aria-busy="true" aria-label="Loading your dashboard" className="min-h-[148px] animate-pulse rounded-2xl bg-hero/90" />
              ) : (
                <DashboardHero
                  name={name}
                  summary={summary}
                  week={weekQuery.data}
                  weekPending={weekQuery.isPending}
                  xp={xp}
                  today={today}
                  onJump={(target) => jumpToCard(JUMP_TARGET_ID[target])}
                  celebrationBurst={celebrationBurst}
                  onStartNewVideo={newVideo.open}
                />
              )}

              {/* 1–2. The resume card (with its sentences to look at again) above the
                  review deck (≈ 2/3), and this week's league running beside both (≈ 1/3),
                  taking their height without setting it (plan D14). With no resume card
                  the pointer / error sits above at a readable width and the league sits
                  beside the deck as a plain card; with no league each card takes the
                  width alone. One grid, the three slots always in the same place, so
                  nothing is rebuilt when a layout changes (the deck keeps its card).
                  On a phone: resume, league, deck. */}
              <div data-testid="dashboard-learning" className={clsx("grid grid-cols-1 items-stretch gap-4 sm:gap-5", leagueSlot && "lg:grid-cols-12")}>
                {continueSlot && (
                  <div
                    key="continue"
                    className={clsx(
                      "min-w-0",
                      leagueTall ? "lg:col-span-8 lg:col-start-1 lg:row-start-1" : "w-full max-w-3xl",
                      leagueSlot && !leagueTall && "lg:col-span-12 lg:row-start-1"
                    )}
                  >
                    {continueSlot}
                  </div>
                )}
                {leagueSlot && (
                  <div
                    key="league"
                    className={clsx(
                      "relative min-w-0 lg:col-span-4 lg:col-start-9",
                      leagueTall ? "lg:row-span-2 lg:row-start-1 lg:min-h-[36rem]" : continueSlot ? "lg:row-start-2" : "lg:row-start-1"
                    )}
                  >
                    {leagueSlot}
                  </div>
                )}
                <div key="deck" className={clsx("min-w-0", leagueSlot && "lg:col-span-8 lg:col-start-1", leagueSlot && (continueSlot ? "lg:row-start-2" : "lg:row-start-1"))}>
                  {deckSlot}
                </div>
              </div>

              {/* 3. Learning performance — the canonical metrics, each its own card. */}
              {summaryQuery.isError && !summary ? (
                <p className="text-sm text-red-600">Failed to load your progress. Please refresh and try again.</p>
              ) : summary ? (
                <LearningPerformance summary={summary} week={weekQuery.data} />
              ) : (
                <div aria-busy="true" aria-label="Loading your progress" className="min-h-[168px] animate-pulse rounded-2xl border border-line bg-white" />
              )}

              {/* 4. Error diagnostics (≈ 2/3) and achievements (≈ 1/3); diagnostics take
                  the row alone when achievements are unavailable. */}
              <div data-testid="dashboard-diagnostics-row" className={clsx("grid grid-cols-1 items-stretch gap-4 sm:gap-5", achievementsSlot && "lg:grid-cols-12")}>
                <div className={clsx("min-w-0", achievementsSlot && "lg:col-span-8")}>
                  <NeedsAttentionCard userId={userId} patterns={errorPatternsData?.patterns ?? []} loading={errorPatternsLoading} />
                </div>
                {achievementsSlot && <div className="min-w-0 lg:col-span-4">{achievementsSlot}</div>}
              </div>
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
