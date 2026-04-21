"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  BookOpen,
  CheckCircle2,
  ChevronRight,
  Clock,
  Flame,
  Headphones,
  PlayCircle,
  Sparkles,
  Trophy,
} from "lucide-react";
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

export default function DashboardPage() {
  const { user, loading, openAuthModal } = useAuth();
  const [dashboardData, setDashboardData] = useState<DashboardData | null>(null);
  const [dashboardError, setDashboardError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;

    fetch("/api/dashboard/summary")
      .then(async (res) => {
        if (!res.ok) throw new Error("Failed to fetch dashboard summary");
        return res.json();
      })
      .then((data: DashboardData) => {
        setDashboardData(data);
        setDashboardError(null);
      })
      .catch(() => {
        setDashboardError("Failed to load dashboard data. Please refresh and try again.");
      });
  }, [user]);

  const firstSession = dashboardData?.resumableSessions[0] ?? null;
  const sessionsWithMistakes = useMemo(
    () => dashboardData?.resumableSessions.filter((session) => session.mistakesCount > 0) ?? [],
    [dashboardData]
  );

  return (
    <div className="flex min-h-screen w-full flex-1 flex-col font-sans">
      <header className="sticky top-0 z-10 w-full border-b border-white/40 bg-white/30 px-6 py-4 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between">
          <div className="flex items-center gap-2">
            <Link href="/" className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-white">
                <Headphones size={18} />
              </div>
              <span className="text-lg font-semibold tracking-tight text-slate-900">DictaLearn</span>
            </Link>
            {user && (
              <nav className="ml-4 hidden gap-6 md:flex">
                <span className="text-sm font-bold text-indigo-600">Dashboard</span>
                <Link
                  href="/vocabulary"
                  className="text-sm font-medium text-slate-500 transition-colors hover:text-indigo-600"
                >
                  Vocabulary
                </Link>
              </nav>
            )}
          </div>
          <UserButton />
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-4 py-8">
        {loading ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : !user ? (
          <section className="rounded-3xl border border-white/60 bg-white/40 p-8 shadow-xl backdrop-blur-xl">
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Dashboard</h1>
            <p className="mt-2 text-sm text-slate-500">Sign in to view your practice summary and continue sessions.</p>
            <button
              onClick={openAuthModal}
              className="mt-4 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
            >
              Sign in
            </button>
          </section>
        ) : !dashboardData && !dashboardError ? (
          <p className="text-sm text-slate-500">Loading dashboard…</p>
        ) : dashboardError ? (
          <p className="text-sm text-red-600">{dashboardError}</p>
        ) : !dashboardData ? (
          <p className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-500">
            No dashboard data yet.
          </p>
        ) : (
          <>
            <section className="flex flex-col items-start justify-between gap-6 md:flex-row md:items-end">
              <div>
                <h1 className="mb-1 text-2xl font-semibold tracking-tight text-slate-900">
                  Welcome back, {user.email?.split("@")[0] ?? "Learner"}
                </h1>
                <p className="text-sm text-slate-500">
                  You have {dashboardData.resumableSessions.length} active session{dashboardData.resumableSessions.length === 1 ? "" : "s"}.
                </p>
              </div>
              <div className="flex gap-2 rounded-2xl border border-white/80 bg-white/60 p-2 shadow-md backdrop-blur-md">
                <div className="flex shrink-0 items-center gap-2 rounded-lg bg-orange-50 px-3 py-1.5 text-orange-600">
                  <Flame size={18} className="fill-orange-500/20" />
                  <span className="text-sm font-semibold">{Math.max(dashboardData.completedVideos, 1)} Days</span>
                </div>
                <div className="my-1 mx-1 w-px bg-slate-200" />
                <div className="flex shrink-0 items-center gap-2 rounded-lg bg-yellow-50 px-3 py-1.5 text-yellow-600">
                  <Trophy size={18} className="fill-yellow-500/20" />
                  <span className="text-sm font-semibold">Active Learner</span>
                </div>
              </div>
            </section>

            <section className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <MetricCard
                title="Completed Videos"
                value={String(dashboardData.completedVideos)}
                icon={<PlayCircle size={20} />}
                trend={dashboardData.completedVideos > 0 ? `+${dashboardData.completedVideos} total` : undefined}
              />
              <MetricCard
                title="Avg. Accuracy"
                value={`${dashboardData.avgAccuracy}%`}
                icon={<CheckCircle2 size={20} />}
                trend={dashboardData.avgAccuracy > 0 ? `${dashboardData.avgAccuracy}%` : undefined}
                positive
              />
              <MetricCard
                title="Practice Time"
                value={`${dashboardData.totalPracticeMinutes}m`}
                icon={<Clock size={20} />}
              />
              <MetricCard
                title="Vocab Saved"
                value={String(dashboardData.vocabularyCount)}
                icon={<BookOpen size={20} />}
                trend={dashboardData.vocabularyCount > 0 ? `+${dashboardData.vocabularyCount} words` : undefined}
              />
            </section>

            <div className="grid items-start gap-8 md:grid-cols-3">
              <div className="md:col-span-2 flex flex-col gap-8">
                <section>
                  <div className="mb-4 flex items-center justify-between">
                    <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-900">Continue Learning</h2>
                  </div>

                  {!firstSession ? (
                    <div className="rounded-3xl border border-white/60 bg-white/50 p-4 text-sm text-slate-500 shadow-xl backdrop-blur-md">
                      No recent sessions yet.
                    </div>
                  ) : (
                    <Link
                      href={`/dictation/${firstSession.videoId}`}
                      className="group relative flex cursor-pointer flex-col gap-4 rounded-3xl border border-white/60 bg-white/50 p-4 shadow-xl backdrop-blur-md transition-all hover:-translate-y-1 sm:flex-row"
                    >
                      <div className="relative aspect-video w-full shrink-0 overflow-hidden rounded-xl bg-slate-800 sm:w-48">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={`https://img.youtube.com/vi/${firstSession.videoId}/hqdefault.jpg`}
                          alt={firstSession.videoTitle ?? `Thumbnail for ${firstSession.videoId}`}
                          className="h-full w-full object-cover opacity-80 transition-opacity group-hover:opacity-100"
                          loading="lazy"
                        />
                        <div className="absolute inset-0 flex items-center justify-center">
                          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white/30 shadow-lg backdrop-blur-md transition-transform group-hover:scale-110">
                            <PlayCircle className="fill-white/20 text-white" size={24} />
                          </div>
                        </div>
                      </div>

                      <div className="flex flex-1 flex-col justify-center">
                        <h3 className="mb-1 font-semibold text-slate-900 transition-colors group-hover:text-indigo-600">
                          {firstSession.videoTitle ?? `Video ${firstSession.videoId}`}
                        </h3>
                        <p className="mb-3 text-sm text-slate-500">Last practiced {new Date(firstSession.updatedAt).toLocaleString()}</p>

                        <div className="mt-auto">
                          <div className="mb-1 flex justify-between text-xs text-slate-600">
                            <span>
                              {firstSession.currentSegmentIndex + 1} segments · {firstSession.totalAttempts} attempts
                            </span>
                            <span className="font-medium">{firstSession.accuracy}%</span>
                          </div>
                          <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                            <div className="h-full rounded-full bg-indigo-500" style={{ width: `${Math.min(100, Math.max(0, firstSession.accuracy))}%` }} />
                          </div>
                        </div>
                      </div>
                    </Link>
                  )}
                </section>

                <section>
                  <div className="mb-4 flex items-center justify-between">
                    <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-900">Recent Vocabulary</h2>
                    <Link
                      href="/vocabulary"
                      className="flex items-center gap-1 text-sm font-medium text-indigo-600 hover:text-indigo-700"
                    >
                      View all <ChevronRight size={16} />
                    </Link>
                  </div>
                  <div className="overflow-hidden rounded-3xl border border-white/60 bg-white/50 shadow-xl backdrop-blur-md">
                    {dashboardData.recentVocabulary.length === 0 ? (
                      <p className="p-4 text-sm text-slate-500">No saved vocabulary yet.</p>
                    ) : (
                      <table className="w-full text-left text-sm">
                        <thead className="border-b border-white/60 bg-white/40 text-slate-500">
                          <tr>
                            <th className="px-4 py-3 font-medium">Word / Phrase</th>
                            <th className="px-4 py-3 font-medium">Context meaning</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {dashboardData.recentVocabulary.map((item) => (
                            <VocabRow
                              key={item.id}
                              word={item.term}
                              meaning={item.sentence_context}
                              context={item.sentence_context}
                            />
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </section>
              </div>

              <div className="md:col-span-1">
                <section className="relative overflow-hidden rounded-3xl bg-indigo-600 p-6 text-white shadow-xl">
                  <div className="absolute -right-4 -top-4 h-24 w-24 rounded-full bg-white/10" />
                  <div className="relative z-10 mb-4 flex items-center gap-2">
                    <Sparkles size={20} className="text-white" />
                    <h2 className="font-semibold tracking-tight text-white">AI Insights</h2>
                  </div>

                  <div className="relative z-10 flex flex-col gap-4">
                    <div className="rounded-2xl border border-white/20 bg-white/10 p-4 text-sm shadow-sm">
                      <h4 className="mb-1 font-bold text-white">Focus Area</h4>
                      {sessionsWithMistakes.length === 0 ? (
                        <p className="leading-relaxed text-indigo-100">No mistakes logged yet. Keep practicing to unlock personalized insights.</p>
                      ) : (
                        <>
                          <p className="mb-3 leading-relaxed text-indigo-100">
                            You made {sessionsWithMistakes[0].mistakesCount} mistakes in your most recent challenge.
                          </p>
                          <Link
                            href={`/dictation/${sessionsWithMistakes[0].videoId}`}
                            className="block w-full rounded-xl bg-white py-2 text-center text-sm font-bold text-indigo-600 shadow-lg shadow-indigo-900/20"
                          >
                            Review Lesson
                          </Link>
                        </>
                      )}
                    </div>
                  </div>
                </section>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function MetricCard({
  title,
  value,
  icon,
  trend,
  positive,
}: {
  title: string;
  value: string;
  icon: React.ReactNode;
  trend?: string;
  positive?: boolean;
}) {
  return (
    <div className="flex flex-col rounded-3xl border border-white/60 bg-white/50 p-5 shadow-xl transition-all hover:-translate-y-1 backdrop-blur-md">
      <div className="mb-2 flex items-start justify-between">
        <div className="text-slate-500">{icon}</div>
        {trend && (
          <div
            className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
              positive ? "bg-emerald-50 text-emerald-600" : "bg-slate-100 text-slate-600"
            }`}
          >
            {trend}
          </div>
        )}
      </div>
      <div className="mt-auto">
        <div className="text-2xl font-semibold tracking-tight text-slate-900">{value}</div>
        <div className="mt-0.5 text-xs font-medium uppercase text-slate-500">{title}</div>
      </div>
    </div>
  );
}

function VocabRow({ word, meaning, context }: { word: string; meaning: string; context: string }) {
  return (
    <tr className="group cursor-pointer transition-colors hover:bg-white/40">
      <td className="w-1/3 px-4 py-3 align-top">
        <div className="font-semibold text-slate-900">{word}</div>
      </td>
      <td className="px-4 py-3 align-top">
        <div className="mb-1 font-medium text-slate-700">{meaning}</div>
        <div className="line-clamp-1 text-xs italic text-slate-500 transition-colors group-hover:text-slate-700">
          &quot;{context}&quot;
        </div>
      </td>
    </tr>
  );
}
