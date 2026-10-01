"use client";

import { Suspense, useMemo } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { clsx } from "clsx";
import { Calendar, Clock, FileText, Headphones, History as ClockIcon, PlayCircle } from "lucide-react";
import AppHeader from "@/components/AppHeader";
import { useAuth } from "@/context/auth";
import { PAGE_PADDING_CLASS, PAGE_WIDTH_CLASS } from "@/lib/layout/pageWidth";
import { useScrollRestoration } from "@/hooks/useScrollRestoration";
import { usePersistedViewState } from "@/hooks/usePersistedViewState";
import { useDashboardSummaryQuery } from "@/lib/queries/dashboard";
import { useHistoryMistakesQuery } from "@/lib/queries/historyMistakes";
import { useHistorySessionsQuery } from "@/lib/queries/historySessions";
import type { HistorySession } from "@/lib/types/learning";
import { ERROR_TYPE_OPTIONS, errorTypeLabel } from "@/lib/constants/errorTypes";
import { formatDurationSeconds } from "@/lib/utils/time";
import { pluralize } from "@/lib/utils/sessionLabels";

const MODE_LABEL: Record<string, string> = { dictation: "Dictation", listening: "Listening", shadowing: "Shadowing" };

/** One study session (one sitting): what was practiced, never blended into one score. */
function SessionCard({ item }: { item: HistorySession }) {
  const practiced = item.dictationSentences + item.shadowingSentences > 0;
  return (
    <article
      data-testid={`history-session-${item.studySessionId}`}
      className="rounded-3xl border border-white/60 bg-white/40 p-4 shadow-lg backdrop-blur-xl sm:p-5"
    >
      <div className="flex flex-col gap-4 sm:flex-row">
        <Link
          href={`/dictation/${item.videoId}`}
          className="relative w-full shrink-0 overflow-hidden rounded-2xl bg-slate-800 shadow-md sm:w-44"
          aria-label={`Open ${item.title ?? item.videoId}`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`https://img.youtube.com/vi/${item.videoId}/hqdefault.jpg`}
            alt=""
            className="aspect-[16/9] h-full w-full object-cover opacity-80"
            loading="lazy"
          />
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <PlayCircle className="fill-white/20 text-white" size={22} />
          </span>
        </Link>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <h3 className="font-bold leading-tight text-slate-900">{item.title ?? `Video ${item.videoId}`}</h3>
            {item.roundId && (
              <Link href={`/results/${item.roundId}`} className="flex items-center gap-1 text-xs font-semibold text-primary-600 hover:underline">
                <FileText size={13} /> Round {item.roundNumber ?? ""} report
              </Link>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-semibold">
            {item.modesUsed.map((m) => (
              <span key={m} className="rounded-full bg-purple-50 px-2 py-0.5 text-purple-600">
                {MODE_LABEL[m] ?? m}
              </span>
            ))}
            {!item.roundId && <span className="rounded-full bg-sky-50 px-2 py-0.5 text-sky-700">No practice round</span>}
            {item.roundStatus === "completed" && <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-emerald-600">Round completed</span>}
          </div>
          <div className="flex flex-wrap gap-2 text-xs font-semibold text-slate-600">
            <span className="flex items-center gap-1.5 rounded-lg border border-white/40 bg-white/50 px-2 py-1">
              <Calendar size={13} className="text-slate-400" />
              {new Date(item.startedAt).toLocaleString()}
            </span>
            <span className="flex items-center gap-1.5 rounded-lg border border-white/40 bg-white/50 px-2 py-1" title="Engaged time, estimated from your activity">
              <Clock size={13} className="text-slate-400" />
              Est. active {item.activeSec > 0 ? formatDurationSeconds(item.activeSec) : "—"}
            </span>
            <span className="rounded-lg border border-white/40 bg-white/50 px-2 py-1 font-medium text-slate-500" title="First to last activity — not practice time">
              Session span {formatDurationSeconds(item.elapsedSpanSec)}
            </span>
          </div>
          {practiced && (
            <p className="text-xs text-slate-600" data-testid="history-sentences">
              {pluralize(item.uniqueSentences, "sentence")} practiced (Dictation {item.dictationSentences} · Shadowing{" "}
              {item.shadowingSentences}
              {item.overlapSentences > 0 ? ` · ${item.overlapSentences} in both` : ""}) · {item.newlyCoveredInRound} new to the round
              {item.dictationLatest.practiced > 0 &&
                ` · ${item.dictationLatest.correct}/${item.dictationLatest.practiced} correct on the latest answer this session`}
            </p>
          )}
          {item.listeningObservedSec > 0 && (
            <p className="flex items-center gap-1 text-xs text-sky-700">
              <Headphones size={12} />
              Listened to {formatDurationSeconds(item.listeningObservedSec)} of video (replays included) ·{" "}
              {formatDurationSeconds(item.listeningNewlyCoveredSec)} newly covered
            </p>
          )}
        </div>
      </div>
    </article>
  );
}

/** usePersistedViewState reads useSearchParams(), which opts this
 *  otherwise-static route into needing a Suspense boundary at build time —
 *  see the default export below. */
function HistoryPageContent() {
  const { user, loading, openAuthModal } = useAuth();
  const userId = user?.id;
  const pathname = usePathname();

  // Shared with the Dashboard page — same query key, same cache entry.
  const summaryQuery = useDashboardSummaryQuery(userId);
  const dashboardData = summaryQuery.data;

  const [filters, updateFilters, viewStateHydrated] = usePersistedViewState("history-viewstate", userId, {
    videoId: "",
    errorType: "",
    dateFrom: "",
    dateTo: "",
  });
  const [sessionView, updateSessionView, sessionViewHydrated] = usePersistedViewState("history-sessions-viewstate", userId, {
    sessionVideo: "",
  });

  const sessionsQuery = useHistorySessionsQuery(userId, { videoId: sessionView.sessionVideo });
  const sessions = useMemo(() => sessionsQuery.data?.pages.flatMap((page) => page.items) ?? [], [sessionsQuery.data]);
  const unattributed = sessionsQuery.data?.pages[0]?.unattributed ?? null;
  const sessionsError = sessionsQuery.isError ? "Failed to load your study sessions." : null;

  const mistakesQuery = useHistoryMistakesQuery(userId, filters);
  const mistakes = useMemo(() => mistakesQuery.data?.pages.flatMap((page) => page.items) ?? [], [mistakesQuery.data]);
  const mistakesTotal = mistakesQuery.data?.pages[0]?.total ?? 0;

  // Scroll restoration waits until both persisted views are applied and their
  // (non-placeholder) first pages are on screen.
  const viewStateApplied =
    viewStateHydrated && sessionViewHydrated && !mistakesQuery.isPlaceholderData && !sessionsQuery.isPlaceholderData;
  useScrollRestoration(pathname, userId, viewStateApplied && !sessionsQuery.isLoading && !mistakesQuery.isLoading);

  const videoOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of sessions) map.set(item.videoId, item.title ?? item.videoId);
    for (const item of mistakes) {
      if (!map.has(item.videoId)) map.set(item.videoId, item.videoTitle ?? item.videoId);
    }
    return [...map.entries()];
  }, [sessions, mistakes]);

  return (
    <div className="relative flex min-h-screen w-full flex-col overflow-hidden bg-[#f4f7ff] font-sans text-slate-900 antialiased">
      <div className="pointer-events-none absolute -left-[10%] -top-[10%] z-0 h-[40%] w-[40%] rounded-full bg-purple-200 opacity-60 blur-[120px]" />
      <div className="pointer-events-none absolute bottom-[10%] right-[0%] z-0 h-[40%] w-[40%] rounded-full bg-blue-200 opacity-60 blur-[120px]" />

      <div className="relative z-10 flex flex-1 flex-col">
        <AppHeader active="history" />

        <main
          className={clsx(
            "mx-auto flex w-full flex-1 flex-col gap-8 py-8",
            PAGE_WIDTH_CLASS.narrow,
            PAGE_PADDING_CLASS.narrow
          )}
        >
          {loading ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : !user ? (
            <section className="rounded-3xl border border-white/60 bg-white/40 p-8 shadow-xl backdrop-blur-xl">
              <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Practice History</h1>
              <p className="mt-2 text-sm text-slate-500">Sign in to track your dictation sessions and progress.</p>
              <button
                onClick={openAuthModal}
                className="mt-4 rounded-xl bg-primary-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary-700"
              >
                Sign in
              </button>
            </section>
          ) : (
            <>
              <section className="flex flex-col items-start justify-between gap-6 border-b border-white/40 pb-6 md:flex-row md:items-end">
                <div>
                  <h1 className="mb-1 text-2xl font-semibold tracking-tight text-slate-900">Practice History</h1>
                  <p className="text-sm text-slate-500">Every study session, across Dictation, Listening and Shadowing.</p>
                </div>
                <div className="flex w-full gap-4 md:w-auto">
                  <div className="flex flex-1 items-center gap-3 rounded-2xl border border-white/60 bg-white/50 p-3 px-5 shadow-sm backdrop-blur-md md:flex-initial">
                    <ClockIcon className="text-primary-500" size={20} />
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Est. active time</p>
                      <p className="text-lg font-black leading-none text-slate-800">
                        {dashboardData && dashboardData.activeTime.activeSec > 0 ? formatDurationSeconds(dashboardData.activeTime.activeSec) : "—"}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-1 items-center gap-3 rounded-2xl border border-white/60 bg-white/50 p-3 px-5 shadow-sm backdrop-blur-md md:flex-initial">
                    <PlayCircle className="text-emerald-500" size={20} />
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Completed videos</p>
                      <p className="text-lg font-black leading-none text-slate-800">{dashboardData ? dashboardData.completedVideos : "—"}</p>
                    </div>
                  </div>
                </div>
              </section>

              <section className="flex flex-col gap-4" aria-labelledby="sessions-heading">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 id="sessions-heading" className="text-xl font-semibold tracking-tight text-slate-900">
                    Study sessions
                  </h2>
                  <select
                    value={sessionView.sessionVideo}
                    onChange={(e) => updateSessionView({ sessionVideo: e.target.value })}
                    className="rounded-lg border border-white/60 bg-white/60 px-2 py-1.5 text-xs font-medium text-slate-700 outline-none"
                    aria-label="Filter sessions by video"
                  >
                    <option value="">All videos</option>
                    {videoOptions.map(([id, title]) => (
                      <option key={id} value={id}>
                        {title}
                      </option>
                    ))}
                  </select>
                </div>
                {sessionsError && !sessionsQuery.data ? (
                  <p className="text-sm text-red-600">
                    {sessionsError}{" "}
                    <button type="button" onClick={() => sessionsQuery.refetch()} className="font-semibold underline hover:text-red-700">
                      Retry
                    </button>
                  </p>
                ) : !sessionsQuery.data ? (
                  <p className="text-sm text-slate-500">Loading history…</p>
                ) : sessions.length === 0 ? (
                  <div className="rounded-3xl border border-white/60 bg-white/50 p-4 text-sm text-slate-500 shadow-lg backdrop-blur-xl">
                    No study sessions yet.
                  </div>
                ) : (
                  <div className={clsx("flex flex-col gap-4", sessionsQuery.isFetching && "opacity-90")} data-testid="history-sessions">
                    {sessions.map((item) => (
                      <SessionCard key={item.studySessionId} item={item} />
                    ))}
                  </div>
                )}
                {sessionsQuery.hasNextPage && (
                  <button
                    onClick={() => sessionsQuery.fetchNextPage()}
                    disabled={sessionsQuery.isFetchingNextPage}
                    className="self-center rounded-xl border border-white/60 bg-white/50 px-4 py-2 text-sm font-semibold text-slate-600 shadow-sm backdrop-blur-md transition-colors hover:bg-white/80 disabled:opacity-50"
                  >
                    {sessionsQuery.isFetchingNextPage ? "Loading…" : "Load more"}
                  </button>
                )}
                {unattributed && (unattributed.legacyRounds > 0 || unattributed.unattributedAnswers > 0 || unattributed.unattributedTakes > 0) && (
                  <p className="text-xs text-slate-500" data-testid="history-unattributed">
                    Earlier practice isn&apos;t grouped into sessions:{" "}
                    {[
                      unattributed.legacyRounds > 0 ? pluralize(unattributed.legacyRounds, "round") + " from before sessions were tracked" : null,
                      unattributed.unattributedAnswers > 0 ? pluralize(unattributed.unattributedAnswers, "answer") + " without a session" : null,
                      unattributed.unattributedTakes > 0 ? pluralize(unattributed.unattributedTakes, "recording") + " without a session" : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                    . Their results are in each round&apos;s report.
                  </p>
                )}
              </section>

              <section className="flex flex-col gap-4 border-t border-white/40 pt-6 pb-12">
                <div>
                  <h2 className="mb-1 text-xl font-semibold tracking-tight text-slate-900">Mistakes</h2>
                  <p className="text-sm text-slate-500">
                    Revisit past mistakes across every session, filtered by video, date, or error type.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-white/60 bg-white/40 p-3 shadow-sm backdrop-blur-md">
                  <select
                    value={filters.videoId}
                    onChange={(e) => updateFilters({ videoId: e.target.value })}
                    className="rounded-lg border border-white/60 bg-white/60 px-2 py-1.5 text-xs font-medium text-slate-700 outline-none"
                    aria-label="Filter by video"
                  >
                    <option value="">All videos</option>
                    {videoOptions.map(([id, title]) => (
                      <option key={id} value={id}>
                        {title}
                      </option>
                    ))}
                  </select>
                  <select
                    value={filters.errorType}
                    onChange={(e) => updateFilters({ errorType: e.target.value })}
                    className="rounded-lg border border-white/60 bg-white/60 px-2 py-1.5 text-xs font-medium text-slate-700 outline-none"
                    aria-label="Filter by error type"
                  >
                    <option value="">All error types</option>
                    {ERROR_TYPE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  <label className="flex items-center gap-1.5 text-xs font-medium text-slate-600">
                    From
                    <input
                      type="date"
                      value={filters.dateFrom}
                      onChange={(e) => updateFilters({ dateFrom: e.target.value })}
                      className="rounded-lg border border-white/60 bg-white/60 px-2 py-1.5 text-xs text-slate-700 outline-none"
                      aria-label="From date"
                    />
                  </label>
                  <label className="flex items-center gap-1.5 text-xs font-medium text-slate-600">
                    To
                    <input
                      type="date"
                      value={filters.dateTo}
                      onChange={(e) => updateFilters({ dateTo: e.target.value })}
                      className="rounded-lg border border-white/60 bg-white/60 px-2 py-1.5 text-xs text-slate-700 outline-none"
                      aria-label="To date"
                    />
                  </label>
                  {mistakesTotal > 0 && (
                    <span className="ml-auto text-xs text-slate-500">{mistakesTotal} mistake{mistakesTotal !== 1 ? "s" : ""}</span>
                  )}
                </div>

                {mistakesQuery.isError ? (
                  <p className="text-sm text-red-600">
                    Failed to load mistakes.{" "}
                    <button
                      type="button"
                      onClick={() => mistakesQuery.refetch()}
                      className="font-semibold underline hover:text-red-700"
                    >
                      Retry
                    </button>
                  </p>
                ) : mistakes.length === 0 && !mistakesQuery.isLoading ? (
                  <div className="rounded-2xl border border-white/60 bg-white/50 p-4 text-sm text-slate-500 shadow-sm backdrop-blur-md">
                    No mistakes match these filters.
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    {mistakes.map((item) => (
                      <div
                        key={item.id}
                        className="rounded-xl border border-white/60 bg-white/50 p-3 shadow-sm backdrop-blur-md"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <Link
                            href={`/dictation/${item.videoId}`}
                            className="text-xs font-semibold text-primary-600 hover:underline"
                          >
                            {item.videoTitle ?? item.videoId}
                          </Link>
                          <div className="flex items-center gap-2">
                            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600">
                              {errorTypeLabel(item.errorType)}
                            </span>
                            <span className="text-[11px] text-slate-400">
                              {new Date(item.createdAt).toLocaleDateString()}
                            </span>
                          </div>
                        </div>
                        <p className="mt-1 text-xs text-slate-400">Sentence {item.segmentIndex + 1}</p>
                        <p className="text-sm text-slate-800">{item.expectedText}</p>
                        <p className="text-xs text-red-500">
                          You typed: {item.userText || <span className="italic text-slate-400">nothing</span>}
                        </p>
                      </div>
                    ))}
                  </div>
                )}

                {mistakesQuery.hasNextPage && (
                  <button
                    onClick={() => mistakesQuery.fetchNextPage()}
                    disabled={mistakesQuery.isFetchingNextPage}
                    className="self-center rounded-xl border border-white/60 bg-white/50 px-4 py-2 text-sm font-semibold text-slate-600 shadow-sm backdrop-blur-md transition-colors hover:bg-white/80 disabled:opacity-50"
                  >
                    {mistakesQuery.isFetchingNextPage ? "Loading…" : "Load more"}
                  </button>
                )}
              </section>
            </>
          )}
        </main>
      </div>
    </div>
  );
}

function HistoryPageFallback() {
  return (
    <div className="relative flex min-h-screen w-full flex-col overflow-hidden bg-[#f4f7ff] font-sans text-slate-900 antialiased">
      <div className="relative z-10 flex flex-1 flex-col">
        <AppHeader active="history" />
        <main
          className={clsx(
            "mx-auto flex w-full flex-1 flex-col gap-8 py-8",
            PAGE_WIDTH_CLASS.narrow,
            PAGE_PADDING_CLASS.narrow
          )}
        >
          <p className="text-sm text-slate-500">Loading…</p>
        </main>
      </div>
    </div>
  );
}

export default function HistoryPage() {
  return (
    <Suspense fallback={<HistoryPageFallback />}>
      <HistoryPageContent />
    </Suspense>
  );
}
