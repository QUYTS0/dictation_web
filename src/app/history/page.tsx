"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Calendar,
  CheckCircle2,
  ChevronRight,
  Clock,
  Headphones,
  History as ClockIcon,
  PlayCircle,
} from "lucide-react";
import { motion } from "motion/react";
import UserButton from "@/components/UserButton";
import { useAuth } from "@/context/auth";

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

function formatPracticeMinutes(totalMinutes: number) {
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

export default function HistoryPage() {
  const { user, loading, openAuthModal } = useAuth();
  const [dashboardData, setDashboardData] = useState<DashboardData | null>(null);
  const [dashboardError, setDashboardError] = useState<string | null>(null);

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

  return (
    <div className="relative flex min-h-screen w-full flex-col overflow-hidden bg-[#f4f7ff] font-sans text-slate-900 antialiased">
      <div className="pointer-events-none absolute -left-[10%] -top-[10%] z-0 h-[40%] w-[40%] rounded-full bg-purple-200 opacity-60 blur-[120px]" />
      <div className="pointer-events-none absolute bottom-[10%] right-[0%] z-0 h-[40%] w-[40%] rounded-full bg-blue-200 opacity-60 blur-[120px]" />

      <div className="relative z-10 flex flex-1 flex-col">
        <header className="sticky top-0 z-20 w-full shrink-0 border-b border-white/40 bg-white/30 px-6 py-4 backdrop-blur-md">
          <div className="mx-auto flex w-full max-w-6xl items-center justify-between">
            <Link href="/" className="flex cursor-pointer items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-600 text-white">
                <Headphones size={18} />
              </div>
              <span className="text-lg font-semibold tracking-tight text-slate-900">DictaLearn</span>
            </Link>
            <div className="flex items-center gap-6">
              <nav className="hidden gap-6 md:flex">
                <Link href="/" className="text-sm font-medium text-slate-500 transition-colors hover:text-primary-600">
                  Dashboard
                </Link>
                <Link href="/vocabulary" className="text-sm font-medium text-slate-500 transition-colors hover:text-primary-600">
                  Vocabulary
                </Link>
                <span className="text-sm font-bold text-primary-600">History</span>
              </nav>
              <UserButton />
            </div>
          </div>
        </header>

        <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-8 overflow-y-auto px-4 py-8">
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
                  <h1 className="mb-2 text-3xl font-bold tracking-tight text-slate-900">Practice History</h1>
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

              <section className="flex flex-col gap-4 pb-12">
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
            </>
          )}
        </main>
      </div>
    </div>
  );
}
