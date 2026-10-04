"use client";

import { FormEvent, Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import clsx from "clsx";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, BookOpen, CheckCircle2, Clock, Flame, Headphones, Mic, PlayCircle, Target, Video } from "lucide-react";
import AppHeader from "@/components/AppHeader";
import ErrorPatternsPanel from "@/components/ErrorPatternsPanel";
import MetricCard from "@/components/MetricCard";
import VocabRow from "@/components/VocabRow";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { LibraryCard } from "@/components/library/LibraryCard";
import { useAuth } from "@/context/auth";
import { usePersistedViewState } from "@/hooks/usePersistedViewState";
import { useScrollRestoration } from "@/hooks/useScrollRestoration";
import { useDashboardSummaryQuery, useDashboardErrorPatternsQuery } from "@/lib/queries/dashboard";
import { invalidateLearningViews } from "@/lib/queries/learningInvalidation";
import { removeFromLibrary, useContinueLearningQuery, useVideoLibraryQuery } from "@/lib/queries/videoLibrary";
import { isValidYouTubeUrl } from "@/lib/utils/url";
import { formatDurationSeconds } from "@/lib/utils/time";
import { formatAggregateScore } from "@/lib/practice/scoreFormat";
import { LIBRARY_FILTERS, type LibraryFilter, type LibraryItem } from "@/lib/types/learning";

const FILTER_LABEL: Record<LibraryFilter, string> = {
  all: "All",
  continue: "Unfinished",
  in_progress: "In progress",
  completed: "Completed",
  not_started: "Not started",
  listening: "Listening",
};
const LIBRARY_FILTER_TABS = LIBRARY_FILTERS.filter((f) => f !== "continue");

function pct(correct: number, practiced: number): string {
  return practiced > 0 ? `${Math.round((100 * correct) / practiced)}%` : "—";
}

/**
 * Video-first Dashboard (plan §10.1): Continue Learning, a compact Add Video,
 * and the paginated Library — one card per video; Dictation, Listening and
 * Shadowing are modes inside the video's practice page, never separate
 * entries here. Every metric is its own number (§6.8), never blended.
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
  const [pendingRemoval, setPendingRemoval] = useState<LibraryItem | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const [view, updateView, viewHydrated] = usePersistedViewState("video-library-viewstate", userId, { filter: "all" });
  const filter: LibraryFilter = (LIBRARY_FILTER_TABS as readonly string[]).includes(view.filter) ? (view.filter as LibraryFilter) : "all";

  const summaryQuery = useDashboardSummaryQuery(userId);
  const summary = summaryQuery.data;
  const continueQuery = useContinueLearningQuery(userId);
  const libraryQuery = useVideoLibraryQuery(userId, filter);
  const libraryItems = useMemo(() => libraryQuery.data?.pages.flatMap((p) => p.items) ?? [], [libraryQuery.data]);
  const libraryTotal = libraryQuery.data?.pages[0]?.total ?? 0;
  const { data: errorPatternsData, isLoading: errorPatternsLoading } = useDashboardErrorPatternsQuery(userId);

  useScrollRestoration(pathname, userId, viewHydrated && !libraryQuery.isPlaceholderData && !libraryQuery.isLoading && !summaryQuery.isLoading);

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

  const confirmRemoval = async () => {
    if (!pendingRemoval || !userId) return;
    setRemoving(true);
    setRemoveError(null);
    try {
      await removeFromLibrary(pendingRemoval.videoId);
      invalidateLearningViews(queryClient, userId);
      setPendingRemoval(null);
    } catch {
      setRemoveError("Couldn't remove the video. Please try again.");
    } finally {
      setRemoving(false);
    }
  };

  const continueItems = continueQuery.data?.items ?? [];
  const accuracy = summary?.sentenceAccuracy;
  const azure = summary?.shadowing.azure;

  return (
    <div className="relative flex min-h-screen w-full flex-1 flex-col overflow-hidden bg-[#f4f7ff] font-sans text-slate-900 antialiased">
      <div className="pointer-events-none absolute -left-[10%] -top-[10%] z-0 h-[40%] w-[40%] rounded-full bg-purple-200 opacity-60 blur-[120px]" />
      <div className="pointer-events-none absolute bottom-[10%] right-[0%] z-0 h-[40%] w-[40%] rounded-full bg-blue-200 opacity-60 blur-[120px]" />

      <div className="relative z-10 flex flex-1 flex-col">
        <AppHeader active="dashboard" />

        <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-4 py-8">
          {loading ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : !user ? (
            <section className="rounded-3xl border border-white/60 bg-white/40 p-8 shadow-xl backdrop-blur-xl">
              <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Dashboard</h1>
              <p className="mt-2 text-sm text-slate-500">Sign in to see your library and continue where you left off.</p>
              <button
                onClick={openAuthModal}
                className="mt-4 rounded-xl bg-primary-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary-700"
              >
                Sign in
              </button>
            </section>
          ) : (
            <>
              <section className="flex flex-col items-start justify-between gap-4 md:flex-row md:items-end">
                <div>
                  <h1 className="mb-1 text-2xl font-semibold tracking-tight text-slate-900">
                    Welcome back, {user.email?.split("@")[0] ?? "Learner"}
                  </h1>
                  <p className="text-sm text-slate-500">
                    {summary ? `${summary.libraryVideos} video${summary.libraryVideos === 1 ? "" : "s"} in your library.` : " "}
                  </p>
                </div>
                <div className="flex items-center gap-2 rounded-2xl border border-white/80 bg-white/60 px-3 py-2 text-orange-600 shadow-md backdrop-blur-md">
                  <Flame size={18} className="fill-orange-500/20" />
                  <span className="text-sm font-semibold">
                    {summary && summary.streakDays > 0 ? `${summary.streakDays} day learning streak` : "Start a learning streak"}
                  </span>
                </div>
              </section>

              {/* 1. Continue Learning — real unfinished work, any mode. */}
              <section aria-labelledby="continue-learning">
                <h2 id="continue-learning" className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-900">
                  Continue Learning
                </h2>
                {continueQuery.isError && !continueQuery.data ? (
                  <p className="text-sm text-red-600">Couldn&apos;t load your unfinished videos.</p>
                ) : !continueQuery.data ? (
                  <p className="text-sm text-slate-500">Loading…</p>
                ) : continueItems.length === 0 ? (
                  <div className="rounded-3xl border border-white/60 bg-white/50 p-4 text-sm text-slate-500 shadow-xl backdrop-blur-md">
                    Nothing unfinished right now — add a video below or open one from your library.
                  </div>
                ) : (
                  <div className="flex flex-col gap-3" data-testid="continue-learning">
                    {continueItems.map((item) => (
                      <LibraryCard key={item.videoId} item={item} compact />
                    ))}
                  </div>
                )}
              </section>

              {/* 2. Add Video — one URL field, no mode selection. */}
              <section className="rounded-3xl border border-white/60 bg-white/40 p-4 shadow-xl backdrop-blur-xl" aria-labelledby="add-video">
                <h2 id="add-video" className="sr-only">
                  Add a video
                </h2>
                <form onSubmit={handleAdd} className="flex flex-col gap-3 sm:flex-row">
                  <div className="relative flex flex-1 items-center">
                    <Video className="absolute left-4 text-slate-400" size={20} />
                    <input
                      type="text"
                      value={url}
                      onChange={(e) => {
                        setUrl(e.target.value);
                        setAddError(null);
                      }}
                      placeholder="Paste a YouTube URL to add it to your library"
                      aria-label="YouTube URL"
                      className="w-full rounded-xl border border-white/60 bg-white/60 py-3 pr-4 pl-12 text-base text-slate-900 placeholder:text-slate-400 outline-none focus:ring-2 focus:ring-primary-500/30"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={adding}
                    className="flex items-center justify-center gap-2 whitespace-nowrap rounded-xl bg-primary-600 px-6 py-3 font-medium text-white shadow-sm transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {adding ? "Adding…" : "Add video"} {!adding && <ArrowRight size={18} />}
                  </button>
                </form>
                {addError && <p className="mt-3 text-sm text-red-600">⚠ {addError}</p>}
              </section>

              {summaryQuery.isError && !summary ? (
                <p className="text-sm text-red-600">Failed to load your progress. Please refresh and try again.</p>
              ) : summary ? (
                <section className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6" aria-label="Progress summary">
                  <MetricCard
                    title="Completed videos"
                    value={String(summary.completedVideos)}
                    icon={<PlayCircle size={20} />}
                    trend={summary.legacyCompletedVideos > 0 ? `+${summary.legacyCompletedVideos} earlier (unverified)` : undefined}
                  />
                  <MetricCard title="In progress" value={String(summary.inProgressVideos)} icon={<Target size={20} />} />
                  <MetricCard title="Listened through" value={String(summary.listenedThroughVideos)} icon={<Headphones size={20} />} />
                  <MetricCard
                    title="Est. active practice"
                    value={summary.activeTime.activeSec > 0 ? formatDurationSeconds(summary.activeTime.activeSec) : "—"}
                    icon={<Clock size={20} />}
                    trend={summary.activeTime.trackedSince ? `since ${new Date(summary.activeTime.trackedSince).toLocaleDateString()}` : undefined}
                  />
                  <MetricCard
                    title="Sentence accuracy"
                    value={accuracy ? pct(accuracy.correct, accuracy.practiced) : "—"}
                    icon={<CheckCircle2 size={20} />}
                    trend={accuracy && accuracy.practiced > 0 ? `${accuracy.correct}/${accuracy.practiced} latest answers` : undefined}
                  />
                  <MetricCard
                    title="Pronunciation"
                    value={azure ? formatAggregateScore(azure.pronunciation) : "—"}
                    icon={<Mic size={20} />}
                    trend={azure && azure.evaluatedSentences > 0 ? `${azure.evaluatedSentences} scored sentences` : undefined}
                  />
                </section>
              ) : (
                <p className="text-sm text-slate-500">Loading your progress…</p>
              )}

              <div className="grid items-start gap-8 md:grid-cols-3">
                {/* 3. Library — one card per video. */}
                <section className="flex flex-col gap-4 md:col-span-2" aria-labelledby="library-heading">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h2 id="library-heading" className="text-sm font-semibold uppercase tracking-wider text-slate-900">
                      Library {libraryTotal > 0 && <span className="text-slate-400">({libraryTotal})</span>}
                    </h2>
                    <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Filter library">
                      {LIBRARY_FILTER_TABS.map((f) => (
                        <button
                          key={f}
                          type="button"
                          role="tab"
                          aria-selected={filter === f}
                          onClick={() => updateView({ filter: f })}
                          className={clsx(
                            "rounded-full px-3 py-1 text-xs font-semibold transition-colors",
                            filter === f ? "bg-primary-600 text-white" : "bg-white/60 text-slate-600 hover:bg-white"
                          )}
                        >
                          {FILTER_LABEL[f]}
                        </button>
                      ))}
                    </div>
                  </div>
                  {removeError && <p className="text-sm text-red-600">{removeError}</p>}
                  {libraryQuery.isError && !libraryQuery.data ? (
                    <p className="text-sm text-red-600">
                      Couldn&apos;t load your library.{" "}
                      <button type="button" onClick={() => libraryQuery.refetch()} className="font-semibold underline">
                        Retry
                      </button>
                    </p>
                  ) : !libraryQuery.data ? (
                    <p className="text-sm text-slate-500">Loading your library…</p>
                  ) : libraryItems.length === 0 ? (
                    <div className="rounded-3xl border border-white/60 bg-white/50 p-4 text-sm text-slate-500 shadow-xl backdrop-blur-md">
                      {filter === "all" ? "Your library is empty — add a YouTube video above." : "No videos match this filter."}
                    </div>
                  ) : (
                    <div className="grid gap-4 sm:grid-cols-2" data-testid="library-grid">
                      {libraryItems.map((item) => (
                        <LibraryCard key={item.videoId} item={item} onRemove={(it) => setPendingRemoval(it)} />
                      ))}
                    </div>
                  )}
                  {libraryQuery.hasNextPage && (
                    <button
                      onClick={() => libraryQuery.fetchNextPage()}
                      disabled={libraryQuery.isFetchingNextPage}
                      className="self-center rounded-xl border border-white/60 bg-white/50 px-4 py-2 text-sm font-semibold text-slate-600 shadow-sm backdrop-blur-md transition-colors hover:bg-white/80 disabled:opacity-50"
                    >
                      {libraryQuery.isFetchingNextPage ? "Loading…" : "Load more"}
                    </button>
                  )}
                </section>

                <div className="flex flex-col gap-8">
                  <section>
                    <div className="mb-4 flex items-center justify-between">
                      <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-900">Recent Vocabulary</h2>
                      <Link href="/vocabulary" className="flex items-center gap-1 text-sm font-medium text-primary-600 hover:text-primary-700">
                        <BookOpen size={14} /> {summary?.vocabularyCount ?? 0}
                      </Link>
                    </div>
                    <div className="overflow-hidden rounded-3xl border border-white/60 bg-white/50 shadow-xl backdrop-blur-md">
                      {!summary || summary.recentVocabulary.length === 0 ? (
                        <p className="p-4 text-sm text-slate-500">No saved vocabulary yet.</p>
                      ) : (
                        <table className="w-full text-left text-sm">
                          <tbody className="divide-y divide-slate-100">
                            {summary.recentVocabulary.map((item) => (
                              <VocabRow key={item.id} word={item.term} context={item.sentence_context} />
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  </section>
                  <ErrorPatternsPanel patterns={errorPatternsData?.patterns ?? []} loading={errorPatternsLoading} />
                </div>
              </div>
            </>
          )}
        </main>
      </div>

      {pendingRemoval && (
        <ConfirmDialog
          title="Remove from your library?"
          body={`“${pendingRemoval.title ?? pendingRemoval.videoId}” will disappear from your library. Your rounds, answers, recordings, reports and listening progress are kept — adding the video again brings them back.`}
          confirmLabel="Remove"
          busyLabel="Removing…"
          isConfirming={removing}
          onConfirm={confirmRemoval}
          onCancel={() => setPendingRemoval(null)}
        />
      )}
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
