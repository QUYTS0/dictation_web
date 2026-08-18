"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Calendar,
  CheckCircle2,
  ChevronRight,
  Clock,
  History as ClockIcon,
  PlayCircle,
} from "lucide-react";
import { motion } from "motion/react";
import AppHeader from "@/components/AppHeader";
import { useAuth } from "@/context/auth";
import type { ErrorType } from "@/lib/types";

interface DashboardData {
  completedVideos: number;
  avgAccuracy: number;
  totalPracticeMinutes: number;
  vocabularyCount: number;
  recentVocabulary: Array<{
    id: string;
    term: string;
    sentence_context: string;
    created_at: string;
  }>;
  resumableSessions: Array<{
    sessionId: string;
    videoId: string;
    videoTitle: string | null;
    updatedAt: string;
    accuracy: number;
    currentSegmentIndex: number;
    totalAttempts: number;
    mistakesCount: number;
  }>;
}

interface MistakeItem {
  id: string;
  sessionId: string;
  videoId: string;
  videoTitle: string | null;
  segmentIndex: number;
  expectedText: string;
  userText: string;
  errorType: ErrorType | null;
  createdAt: string;
}

interface MistakesResponse {
  items: MistakeItem[];
  hasMore: boolean;
  total: number;
}

const ERROR_TYPE_OPTIONS: { value: ErrorType; label: string }[] = [
  { value: "spelling", label: "Spelling" },
  { value: "missing_word", label: "Missing word" },
  { value: "extra_word", label: "Extra word" },
  { value: "wrong_form", label: "Wrong form" },
  { value: "punctuation", label: "Punctuation" },
  { value: "capitalization", label: "Capitalization" },
];

const MISTAKES_PAGE_SIZE = 10;

function formatPracticeMinutes(totalMinutes: number) {
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

function errorTypeLabel(errorType: ErrorType | null) {
  return ERROR_TYPE_OPTIONS.find((opt) => opt.value === errorType)?.label ?? "Other";
}

export default function HistoryPage() {
  const { user, loading, openAuthModal } = useAuth();
  const [dashboardData, setDashboardData] = useState<DashboardData | null>(null);
  const [dashboardError, setDashboardError] = useState<string | null>(null);

  const [mistakes, setMistakes] = useState<MistakeItem[]>([]);
  const [mistakesLoading, setMistakesLoading] = useState(false);
  const [mistakesError, setMistakesError] = useState<string | null>(null);
  const [mistakesHasMore, setMistakesHasMore] = useState(false);
  const [mistakesTotal, setMistakesTotal] = useState(0);
  const [videoFilter, setVideoFilter] = useState("");
  const [errorTypeFilter, setErrorTypeFilter] = useState("");
  const [dateFromFilter, setDateFromFilter] = useState("");
  const [dateToFilter, setDateToFilter] = useState("");

  useEffect(() => {
    if (!user) return;

    let isCancelled = false;
    fetch("/api/dashboard/summary")
      .then(async (res) => {
        if (!res.ok) throw new Error("Failed to fetch dashboard summary");
        return res.json();
      })
      .then((data: DashboardData) => {
        if (isCancelled) return;
        setDashboardData(data);
        setDashboardError(null);
      })
      .catch(() => {
        if (isCancelled) return;
        setDashboardError("Failed to load history data. Please refresh and try again.");
      });

    return () => {
      isCancelled = true;
    };
  }, [user]);

  const historyItems = useMemo(
    () => dashboardData?.resumableSessions ?? [],
    [dashboardData]
  );

  const videoOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of historyItems) {
      map.set(item.videoId, item.videoTitle ?? item.videoId);
    }
    for (const item of mistakes) {
      if (!map.has(item.videoId)) {
        map.set(item.videoId, item.videoTitle ?? item.videoId);
      }
    }
    return [...map.entries()];
  }, [historyItems, mistakes]);

  const loadMistakes = useCallback(
    async (offset: number, append: boolean) => {
      setMistakesLoading(true);
      setMistakesError(null);
      try {
        const searchParams = new URLSearchParams();
        if (videoFilter) searchParams.set("videoId", videoFilter);
        if (errorTypeFilter) searchParams.set("errorType", errorTypeFilter);
        if (dateFromFilter) searchParams.set("dateFrom", dateFromFilter);
        if (dateToFilter) searchParams.set("dateTo", dateToFilter);
        searchParams.set("limit", String(MISTAKES_PAGE_SIZE));
        searchParams.set("offset", String(offset));

        const res = await fetch(`/api/history/mistakes?${searchParams.toString()}`);
        if (!res.ok) throw new Error("Failed to fetch mistakes");
        const data: MistakesResponse = await res.json();
        setMistakes((prev) => (append ? [...prev, ...data.items] : data.items));
        setMistakesHasMore(data.hasMore);
        setMistakesTotal(data.total);
      } catch {
        setMistakesError("Failed to load mistakes. Please try again.");
      } finally {
        setMistakesLoading(false);
      }
    },
    [videoFilter, errorTypeFilter, dateFromFilter, dateToFilter]
  );

  useEffect(() => {
    if (!user) return;
    loadMistakes(0, false);
  }, [user, loadMistakes]);

  return (
    <div className="relative flex min-h-screen w-full flex-col overflow-hidden bg-[#f4f7ff] font-sans text-slate-900 antialiased">
      <div className="pointer-events-none absolute -left-[10%] -top-[10%] z-0 h-[40%] w-[40%] rounded-full bg-purple-200 opacity-60 blur-[120px]" />
      <div className="pointer-events-none absolute bottom-[10%] right-[0%] z-0 h-[40%] w-[40%] rounded-full bg-blue-200 opacity-60 blur-[120px]" />

      <div className="relative z-10 flex flex-1 flex-col">
        <AppHeader active="history" />

        <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-8 px-4 py-8">
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
          ) : dashboardError ? (
            <p className="text-sm text-red-600">{dashboardError}</p>
          ) : !dashboardData ? (
            <p className="text-sm text-slate-500">Loading history…</p>
          ) : (
            <>
              <section className="flex flex-col items-start justify-between gap-6 border-b border-white/40 pb-6 md:flex-row md:items-end">
                <div>
                  <h1 className="mb-1 text-2xl font-semibold tracking-tight text-slate-900">Practice History</h1>
                  <p className="text-sm text-slate-500">Track your dictation sessions and progress.</p>
                </div>
                <div className="flex w-full gap-4 md:w-auto">
                  <div className="flex flex-1 items-center gap-3 rounded-2xl border border-white/60 bg-white/50 p-3 px-5 shadow-sm backdrop-blur-md md:flex-initial">
                    <ClockIcon className="text-primary-500" size={20} />
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Total Time</p>
                      <p className="text-lg font-black leading-none text-slate-800">
                        {formatPracticeMinutes(dashboardData.totalPracticeMinutes)}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-1 items-center gap-3 rounded-2xl border border-white/60 bg-white/50 p-3 px-5 shadow-sm backdrop-blur-md md:flex-initial">
                    <PlayCircle className="text-emerald-500" size={20} />
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Videos</p>
                      <p className="text-lg font-black leading-none text-slate-800">{dashboardData.completedVideos}</p>
                    </div>
                  </div>
                </div>
              </section>

              <section className="flex flex-col gap-4">
                {historyItems.length === 0 ? (
                  <div className="rounded-3xl border border-white/60 bg-white/50 p-4 text-sm text-slate-500 shadow-lg backdrop-blur-xl">
                    No recent sessions yet.
                  </div>
                ) : (
                  historyItems.map((item, idx) => (
                    <motion.div
                      key={item.sessionId}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: idx * 0.1 }}
                      className="group relative rounded-3xl border border-white/60 bg-white/40 p-4 shadow-lg transition-all hover:-translate-y-1 backdrop-blur-xl sm:p-5"
                    >
                      <Link href={`/dictation/${item.videoId}`} className="flex cursor-pointer flex-col gap-5 sm:flex-row">
                        <div className="relative w-full shrink-0 overflow-hidden rounded-2xl bg-slate-800 shadow-md sm:w-56">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={`https://img.youtube.com/vi/${item.videoId}/hqdefault.jpg`}
                            alt={item.videoTitle ?? `Thumbnail for ${item.videoId}`}
                            className="aspect-[16/9] h-full w-full object-cover opacity-80 transition-opacity group-hover:opacity-100"
                            loading="lazy"
                          />
                          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                            <div className="flex h-10 w-10 items-center justify-center rounded-full border border-white/30 bg-white/20 shadow-lg backdrop-blur-md transition-transform group-hover:scale-110">
                              <PlayCircle className="fill-white/20 text-white" size={20} />
                            </div>
                          </div>
                        </div>

                        <div className="flex flex-1 flex-col justify-between py-1">
                          <div>
                            <div className="mb-1 flex items-start justify-between gap-4">
                              <h3 className="text-lg font-bold leading-tight text-slate-900 transition-colors group-hover:text-primary-600">
                                {item.videoTitle ?? `Video ${item.videoId}`}
                              </h3>
                              <span className="shrink-0 text-primary-600 opacity-0 transition-opacity group-hover:opacity-100">
                                <ChevronRight size={20} />
                              </span>
                            </div>
                            <p className="mb-3 text-sm font-medium text-slate-500">
                              {item.mistakesCount > 0 ? `${item.mistakesCount} mistakes to review` : "No mistakes logged"}
                            </p>
                          </div>

                          <div>
                            <div className="mb-4 flex flex-wrap gap-4">
                              <div className="flex items-center gap-1.5 rounded-lg border border-white/40 bg-white/50 px-2 py-1 text-xs font-semibold text-slate-600">
                                <Calendar size={14} className="text-slate-400" />
                                {new Date(item.updatedAt).toLocaleString()}
                              </div>
                              <div className="flex items-center gap-1.5 rounded-lg border border-white/40 bg-white/50 px-2 py-1 text-xs font-semibold text-slate-600">
                                <Clock size={14} className="text-slate-400" />
                                {item.totalAttempts} attempts
                              </div>
                              <div className="flex items-center gap-1.5 rounded-lg border border-emerald-100 bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700">
                                <CheckCircle2 size={14} className="text-emerald-500" />
                                {item.accuracy}% Accuracy
                              </div>
                            </div>

                            <div>
                              <div className="mb-1.5 flex justify-between text-xs font-bold text-slate-500">
                                <span className="text-[10px] uppercase tracking-widest">Progress</span>
                                <span>Sentence {item.currentSegmentIndex + 1}</span>
                              </div>
                              <div className="flex h-2 w-full overflow-hidden rounded-full border border-white/40 bg-white/50 shadow-inner">
                                <div
                                  className="h-full rounded-full bg-primary-500 transition-all duration-1000"
                                  style={{ width: `${Math.max(0, Math.min(100, item.accuracy))}%` }}
                                />
                              </div>
                            </div>
                          </div>
                        </div>
                      </Link>
                    </motion.div>
                  ))
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
                    value={videoFilter}
                    onChange={(e) => setVideoFilter(e.target.value)}
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
                    value={errorTypeFilter}
                    onChange={(e) => setErrorTypeFilter(e.target.value)}
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
                      value={dateFromFilter}
                      onChange={(e) => setDateFromFilter(e.target.value)}
                      className="rounded-lg border border-white/60 bg-white/60 px-2 py-1.5 text-xs text-slate-700 outline-none"
                      aria-label="From date"
                    />
                  </label>
                  <label className="flex items-center gap-1.5 text-xs font-medium text-slate-600">
                    To
                    <input
                      type="date"
                      value={dateToFilter}
                      onChange={(e) => setDateToFilter(e.target.value)}
                      className="rounded-lg border border-white/60 bg-white/60 px-2 py-1.5 text-xs text-slate-700 outline-none"
                      aria-label="To date"
                    />
                  </label>
                  {mistakesTotal > 0 && (
                    <span className="ml-auto text-xs text-slate-500">{mistakesTotal} mistake{mistakesTotal !== 1 ? "s" : ""}</span>
                  )}
                </div>

                {mistakesError ? (
                  <p className="text-sm text-red-600">{mistakesError}</p>
                ) : mistakes.length === 0 && !mistakesLoading ? (
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

                {mistakesHasMore && (
                  <button
                    onClick={() => loadMistakes(mistakes.length, true)}
                    disabled={mistakesLoading}
                    className="self-center rounded-xl border border-white/60 bg-white/50 px-4 py-2 text-sm font-semibold text-slate-600 shadow-sm backdrop-blur-md transition-colors hover:bg-white/80 disabled:opacity-50"
                  >
                    {mistakesLoading ? "Loading…" : "Load more"}
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
