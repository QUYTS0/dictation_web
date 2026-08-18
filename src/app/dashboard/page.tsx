"use client";

import { FormEvent, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import {
  ArrowRight,
  BookOpen,
  CheckCircle2,
  Clock,
  Flame,
  Headphones,
  Keyboard,
  PlayCircle,
  Sparkles,
  Trophy,
  Video,
} from "lucide-react";
import AppHeader from "@/components/AppHeader";
import MetricCard from "@/components/MetricCard";
import VocabRow from "@/components/VocabRow";
import { useAuth } from "@/context/auth";
import { isValidYouTubeUrl } from "@/lib/utils/url";

type StudyMode = "dictation" | "listening";

const STUDY_MODES: Array<{
  mode: StudyMode;
  title: string;
  description: string;
  icon: typeof Keyboard;
}> = [
  {
    mode: "dictation",
    title: "Dictation Practice",
    description: "Type what you hear, sentence by sentence.",
    icon: Keyboard,
  },
  {
    mode: "listening",
    title: "Listening Practice",
    description: "Follow along with script + translation.",
    icon: Headphones,
  },
];

function ModeCard({
  active,
  title,
  description,
  icon: Icon,
  onSelect,
}: {
  active: boolean;
  title: string;
  description: string;
  icon: typeof Keyboard;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={clsx(
        "flex flex-1 items-start gap-3 rounded-2xl border p-4 text-left transition-all",
        active
          ? "border-primary-500 bg-primary-50/80 shadow-md ring-1 ring-primary-500/30"
          : "border-white/60 bg-white/50 hover:border-primary-200 hover:bg-white/70"
      )}
    >
      <div
        className={clsx(
          "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
          active ? "bg-primary-600 text-white" : "bg-white/80 text-slate-500"
        )}
      >
        <Icon size={20} />
      </div>
      <div className="flex-1">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold text-slate-900">{title}</h3>
          {active && <CheckCircle2 size={16} className="text-primary-600" />}
        </div>
        <p className="mt-0.5 text-xs text-slate-500">{description}</p>
      </div>
    </button>
  );
}

interface DashboardData {
  completedVideos: number;
  avgAccuracy: number;
  totalPracticeMinutes: number;
  vocabularyCount: number;
  streakDays: number;
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
const MAX_DASHBOARD_HISTORY_SESSIONS = 8;

export default function DashboardPage() {
  const router = useRouter();
  const { user, loading, openAuthModal } = useAuth();
  const [studyMode, setStudyMode] = useState<StudyMode>("dictation");
  const [url, setUrl] = useState("");
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const userId = user?.id;

  const handleStart = async (e: FormEvent) => {
    e.preventDefault();
    setStartError(null);

    if (!url.trim()) {
      setStartError("Please paste a YouTube URL.");
      return;
    }

    if (!isValidYouTubeUrl(url.trim())) {
      setStartError("That doesn't look like a valid YouTube URL.");
      return;
    }

    setStarting(true);
    try {
      const res = await fetch("/api/video/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });

      const data = await res.json();

      if (!res.ok || data.status !== "ok") {
        setStartError(data.message ?? "Failed to resolve the video. Please try again.");
        return;
      }

      router.push(`/${studyMode}/${data.videoId}`);
    } catch {
      setStartError("Network error. Please check your connection and try again.");
    } finally {
      setStarting(false);
    }
  };

  // useQuery caches by key across navigations, so leaving /dashboard and
  // coming back shows the last-fetched data instantly instead of refetching
  // from a blank state every time.
  const { data: dashboardData, isError: hasDashboardError } = useQuery({
    queryKey: ["dashboard-summary", userId],
    queryFn: async (): Promise<DashboardData> => {
      const res = await fetch("/api/dashboard/summary");
      if (!res.ok) throw new Error("Failed to fetch dashboard summary");
      return res.json();
    },
    enabled: !!userId,
  });
  const dashboardError = hasDashboardError
    ? "Failed to load dashboard data. Please refresh and try again."
    : null;

  const firstSession = dashboardData?.resumableSessions[0] ?? null;
  const latestMistakeSession = useMemo(
    () => dashboardData?.resumableSessions.find((session) => session.mistakesCount > 0) ?? null,
    [dashboardData]
  );

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
              <p className="mt-2 text-sm text-slate-500">Sign in to view your practice summary and continue sessions.</p>
              <button
                onClick={openAuthModal}
                className="mt-4 rounded-xl bg-primary-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary-700"
              >
                Sign in
              </button>
            </section>
          ) : (
            <>
              <section className="rounded-3xl border border-white/60 bg-white/40 p-5 shadow-xl backdrop-blur-xl">
                <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-slate-900">
                  Start a new session
                </h2>
                <div className="mb-4 flex flex-col gap-3 sm:flex-row">
                  {STUDY_MODES.map((m) => (
                    <ModeCard
                      key={m.mode}
                      active={studyMode === m.mode}
                      title={m.title}
                      description={m.description}
                      icon={m.icon}
                      onSelect={() => setStudyMode(m.mode)}
                    />
                  ))}
                </div>
                <form onSubmit={handleStart} className="flex flex-col gap-3 sm:flex-row">
                  <div className="relative flex flex-1 items-center">
                    <Video className="absolute left-4 text-slate-400" size={20} />
                    <input
                      type="text"
                      value={url}
                      onChange={(e) => {
                        setUrl(e.target.value);
                        setStartError(null);
                      }}
                      placeholder="Paste YouTube URL here (e.g. https://www.youtube.com/...)"
                      className="w-full rounded-xl border border-white/60 bg-white/60 py-3 pr-4 pl-12 text-base text-slate-900 placeholder:text-slate-400 outline-none focus:ring-2 focus:ring-primary-500/30"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={starting}
                    className="flex items-center justify-center gap-2 whitespace-nowrap rounded-xl bg-primary-600 px-8 py-3 font-medium text-white shadow-sm transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {starting ? "Loading…" : studyMode === "dictation" ? "Start Dictation" : "Start Listening"}{" "}
                    {!starting && <ArrowRight size={18} />}
                  </button>
                </form>
                {startError && <p className="mt-3 text-sm text-red-600">⚠ {startError}</p>}
              </section>

              {!dashboardData && !dashboardError ? (
                <p className="text-sm text-slate-500">Loading dashboard…</p>
              ) : dashboardError ? (
                <p className="text-sm text-red-600">{dashboardError}</p>
              ) : !dashboardData ? (
                <p className="rounded-3xl border border-white/60 bg-white/50 p-4 text-sm text-slate-500 shadow-xl backdrop-blur-md">
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
                    You have {dashboardData.resumableSessions.length} active session
                    {dashboardData.resumableSessions.length === 1 ? "" : "s"}.
                  </p>
                </div>
                <div className="flex gap-2 rounded-2xl border border-white/80 bg-white/60 p-2 shadow-md backdrop-blur-md">
                  <div className="flex shrink-0 items-center gap-2 rounded-lg bg-orange-50 px-3 py-1.5 text-orange-600">
                    <Flame size={18} className="fill-orange-500/20" />
                    <span className="text-sm font-semibold">
                      {dashboardData.streakDays > 0
                        ? `${dashboardData.streakDays} day streak`
                        : "Start a streak"}
                    </span>
                  </div>
                  <div className="mx-1 my-1 w-px bg-slate-200" />
                  <div className="flex shrink-0 items-center gap-2 rounded-lg bg-yellow-50 px-3 py-1.5 text-yellow-600">
                    <Trophy size={18} className="fill-yellow-500/20" />
                    <span className="text-sm font-semibold">Active Learner</span>
                  </div>
                </div>
              </section>

              <section className="grid grid-cols-2 gap-4 md:grid-cols-4">
                <MetricCard title="Completed Videos" value={String(dashboardData.completedVideos)} icon={<PlayCircle size={20} />} />
                <MetricCard title="Avg. Accuracy" value={`${dashboardData.avgAccuracy}%`} icon={<CheckCircle2 size={20} />} positive />
                <MetricCard title="Practice Time" value={`${dashboardData.totalPracticeMinutes}m`} icon={<Clock size={20} />} />
                <MetricCard title="Vocab Saved" value={String(dashboardData.vocabularyCount)} icon={<BookOpen size={20} />} trend={dashboardData.vocabularyCount > 0 ? `+${dashboardData.vocabularyCount} words` : undefined} />
              </section>

              <div className="grid items-start gap-8 md:grid-cols-3">
                <div className="flex flex-col gap-8 md:col-span-2">
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
                          <h3 className="mb-1 font-semibold text-slate-900 transition-colors group-hover:text-primary-600">
                            {firstSession.videoTitle ?? `Video ${firstSession.videoId}`}
                          </h3>
                          <p className="mb-3 text-sm text-slate-500">
                            Last practiced {new Date(firstSession.updatedAt).toLocaleDateString()}
                          </p>

                          <div className="mt-auto">
                            <div className="mb-1 flex justify-between text-xs text-slate-600">
                              <span>
                                {firstSession.currentSegmentIndex + 1} segments · {firstSession.totalAttempts} attempts
                              </span>
                              <span className="font-medium">{firstSession.accuracy}%</span>
                            </div>
                            <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                              <div className="h-full rounded-full bg-primary-500" style={{ width: `${Math.min(100, Math.max(0, firstSession.accuracy))}%` }} />
                            </div>
                          </div>
                        </div>
                      </Link>
                    )}
                  </section>

                  <section>
                    <div className="mb-4 flex items-center justify-between">
                      <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-900">Recent Vocabulary</h2>
                      <Link href="/vocabulary" className="text-sm font-medium text-primary-600 transition-colors hover:text-primary-700">
                        View all
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
                              <th className="px-4 py-3 font-medium">Sentence context</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {dashboardData.recentVocabulary.map((item) => (
                              <VocabRow key={item.id} word={item.term} context={item.sentence_context} />
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  </section>

                  <section id="history" tabIndex={0} className="rounded-3xl border border-white/60 bg-white/50 p-4 shadow-xl backdrop-blur-md">
                    <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-900">History</h2>
                    {dashboardData.resumableSessions.length === 0 ? (
                      <p className="text-sm text-slate-500">No recent sessions yet.</p>
                    ) : (
                      <ul className="space-y-2">
                        {dashboardData.resumableSessions.slice(0, MAX_DASHBOARD_HISTORY_SESSIONS).map((session) => (
                          <li key={session.sessionId} className="rounded-xl border border-white/60 bg-white/50 p-3 text-sm backdrop-blur-md">
                            <p className="font-medium text-slate-800">{session.videoTitle ?? `Video ${session.videoId}`}</p>
                            <p className="text-xs text-slate-500">Last practiced {new Date(session.updatedAt).toLocaleString()}</p>
                          </li>
                        ))}
                      </ul>
                    )}
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
                        {!latestMistakeSession ? (
                          <p className="leading-relaxed text-indigo-100">
                            No mistakes logged yet. Keep practicing to unlock personalized insights.
                          </p>
                        ) : (
                          <>
                            <p className="mb-3 leading-relaxed text-indigo-100">
                              You made {latestMistakeSession.mistakesCount} mistakes in your most recent challenge.
                            </p>
                            <Link
                              href={`/dictation/${latestMistakeSession.videoId}`}
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
            </>
          )}
        </main>
      </div>
    </div>
  );
}

