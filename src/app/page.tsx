"use client";

import { FormEvent, ReactNode, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  BookOpen,
  BrainCircuit,
  CheckCircle2,
  Clock,
  Flame,
  Headphones,
  Play,
  PlayCircle,
  ShieldCheck,
  Sparkles,
  Trophy,
  Video,
  Zap,
} from "lucide-react";
import { motion } from "motion/react";
import { isValidYouTubeUrl } from "@/lib/utils/url";
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

const LANDING_FEATURES = [
  {
    icon: <Play size={24} />,
    title: "Auto-pause Engine",
    description:
      "The video automatically pauses after each sentence, giving you time to process and type without frantic clicking.",
    delay: 0.2,
  },
  {
    icon: <BrainCircuit size={24} />,
    title: "AI Grammar Insights",
    description:
      "Get personalized explanations for your mistakes. Understand why you misheard something, not just that you did.",
    delay: 0.3,
  },
  {
    icon: <ShieldCheck size={24} />,
    title: "Relaxed Matching",
    description:
      "Focus on meaning, not mechanics. Our system ignores minor punctuation and capitalization so you can flow.",
    delay: 0.4,
  },
] as const;

export default function HomePage() {
  const router = useRouter();
  const { user, loading: authLoading, openAuthModal } = useAuth();
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [dashboardData, setDashboardData] = useState<DashboardData | null>(null);
  const [dashboardError, setDashboardError] = useState<string | null>(null);
  const [dashboardLoading, setDashboardLoading] = useState(false);

  const handleStart = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!url.trim()) {
      setError("Please paste a YouTube URL.");
      return;
    }

    if (!isValidYouTubeUrl(url.trim())) {
      setError("That doesn't look like a valid YouTube URL.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/video/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });

      const data = await res.json();

      if (!res.ok || data.status !== "ok") {
        setError(data.message ?? "Failed to resolve the video. Please try again.");
        return;
      }

      router.push(`/dictation/${data.videoId}`);
    } catch {
      setError("Network error. Please check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  };

  useEffect(() => {
    if (!user) {
      setDashboardData(null);
      setDashboardError(null);
      setDashboardLoading(false);
      return;
    }

    setDashboardLoading(true);
    setDashboardError(null);
    fetch("/api/dashboard/summary")
      .then(async (res) => {
        if (!res.ok) throw new Error("Failed to fetch dashboard summary");
        return res.json();
      })
      .then((data: DashboardData) => setDashboardData(data))
      .catch(() => {
        setDashboardError("Failed to load workspace data. Please refresh and try again.");
      })
      .finally(() => setDashboardLoading(false));
  }, [user]);

  const firstSession = dashboardData?.resumableSessions[0] ?? null;
  const latestMistakeSession = useMemo(
    () => dashboardData?.resumableSessions.find((session) => session.mistakesCount > 0) ?? null,
    [dashboardData]
  );

  if (authLoading) {
    return (
      <main className="mx-auto w-full max-w-6xl p-4 md:p-6">
        <p className="text-sm text-slate-500">Loading…</p>
      </main>
    );
  }

  if (!user) {
    return (
      <div className="relative flex min-h-screen w-full flex-col overflow-hidden bg-[#f4f7ff] font-sans text-slate-900 antialiased">
        <div className="pointer-events-none absolute -left-[10%] -top-[10%] z-0 h-[40%] w-[40%] rounded-full bg-purple-200 opacity-60 blur-[120px]" />
        <div className="pointer-events-none absolute bottom-[10%] right-[0%] z-0 h-[40%] w-[40%] rounded-full bg-blue-200 opacity-60 blur-[120px]" />

        <div className="relative z-10 flex flex-1 flex-col">
          <header className="sticky top-0 z-10 w-full border-b border-white/40 bg-white/30 px-6 py-4 backdrop-blur-md">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-600 text-white">
                  <Headphones size={18} />
                </div>
                <span className="text-lg font-semibold tracking-tight text-slate-900">DictaLearn</span>
              </div>
              <div className="flex items-center gap-4">
                <button
                  onClick={openAuthModal}
                  className="text-sm font-medium text-slate-600 transition-colors hover:text-slate-900"
                >
                  Sign In
                </button>
                <button
                  onClick={() => document.getElementById("landing-youtube-url")?.focus()}
                  className="rounded-full bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-slate-800"
                >
                  Get Started
                </button>
              </div>
            </div>
          </header>

          <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col items-center justify-center px-4 py-16">
            <section className="mx-auto mb-16 max-w-3xl pt-8 text-center">
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5 }}
              >
                <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-primary-100 bg-primary-50 px-3 py-1 text-xs font-semibold text-primary-700">
                  <Zap size={14} className="text-primary-500" />
                  <span>Master English through listening</span>
                </div>
                <h1 className="mb-6 text-4xl leading-tight font-semibold text-balance text-slate-900 tracking-tight md:text-6xl">
                  Turn any YouTube video into an <span className="text-primary-600">interactive language lesson</span>
                </h1>
                <p className="mx-auto mb-8 max-w-2xl text-lg leading-relaxed text-slate-600 md:text-xl">
                  Paste a link, listen sentence by sentence, and type what you hear. Our AI provides instant
                  feedback to perfect your comprehension and grammar.
                </p>
              </motion.div>

              <motion.form
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: 0.1 }}
                onSubmit={handleStart}
                className="mx-auto flex max-w-2xl flex-col gap-3 rounded-3xl border border-white/60 bg-white/40 p-3 shadow-xl transition-all focus-within:ring-2 focus-within:ring-primary-500/30 backdrop-blur-xl md:p-4 sm:flex-row"
              >
                <div className="relative flex flex-1 items-center">
                  <Video className="absolute left-4 text-slate-400" size={20} />
                  <input
                    id="landing-youtube-url"
                    type="text"
                    value={url}
                    onChange={(e) => {
                      setUrl(e.target.value);
                      setError(null);
                    }}
                    placeholder="Paste YouTube URL here (e.g. https://www.youtube.com/...)"
                    className="w-full border-none bg-transparent py-3 pr-4 pl-12 text-base text-slate-900 placeholder:text-slate-400 outline-none focus:ring-0"
                    autoFocus
                  />
                </div>
                <button
                  type="submit"
                  disabled={submitting}
                  className="flex items-center justify-center gap-2 whitespace-nowrap rounded-xl bg-primary-600 px-8 py-3 font-medium text-white shadow-sm transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {submitting ? "Loading…" : "Start Dictation"} {!submitting && <ArrowRight size={18} />}
                </button>
              </motion.form>
              {error && <p className="mt-3 text-sm text-red-600">⚠ {error}</p>}
              <p className="mt-4 text-sm text-slate-500">Start without signing in. Sign in later to save progress.</p>
            </section>

            <section className="mt-12 grid w-full gap-6 md:grid-cols-3">
              {LANDING_FEATURES.map((feature) => (
                <LandingFeatureCard
                  key={feature.title}
                  icon={feature.icon}
                  title={feature.title}
                  description={feature.description}
                  delay={feature.delay}
                />
              ))}
            </section>
          </main>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-screen w-full flex-col overflow-hidden bg-[#f4f7ff] font-sans text-slate-900 antialiased">
      <div className="pointer-events-none absolute -left-[10%] -top-[10%] z-0 h-[40%] w-[40%] rounded-full bg-purple-200 opacity-60 blur-[120px]" />
      <div className="pointer-events-none absolute bottom-[10%] right-[0%] z-0 h-[40%] w-[40%] rounded-full bg-blue-200 opacity-60 blur-[120px]" />

      <div className="relative z-10 flex flex-1 flex-col">
        <header className="sticky top-0 z-10 w-full border-b border-white/40 bg-white/30 px-6 py-4 backdrop-blur-md">
          <div className="mx-auto flex w-full max-w-6xl items-center justify-between">
            <Link href="/" className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-600 text-white">
                <Headphones size={18} />
              </div>
              <span className="text-lg font-semibold tracking-tight text-slate-900">DictaLearn</span>
            </Link>
            <div className="flex items-center gap-6">
              <nav className="hidden gap-6 md:flex">
                <span className="text-sm font-bold text-indigo-600">Dashboard</span>
                <Link href="/vocabulary" className="text-sm font-medium text-slate-500 transition-colors hover:text-indigo-600">
                  Vocabulary
                </Link>
                <a href="#history" className="text-sm font-medium text-slate-500 transition-colors hover:text-indigo-600">
                  History
                </a>
              </nav>
              <UserButton />
            </div>
          </div>
        </header>

        <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-4 py-8">
          <section className="rounded-3xl border border-white/60 bg-white/40 p-4 shadow-xl backdrop-blur-xl md:p-5">
            <form onSubmit={handleStart} className="flex flex-col gap-3 sm:flex-row">
              <div className="relative flex flex-1 items-center">
                <Video className="absolute left-4 text-slate-400" size={20} />
                <input
                  id="workspace-youtube-url"
                  type="text"
                  value={url}
                  onChange={(e) => {
                    setUrl(e.target.value);
                    setError(null);
                  }}
                  placeholder="Paste YouTube URL here (e.g. https://www.youtube.com/...)"
                  className="w-full border-none bg-transparent py-3 pr-4 pl-12 text-base text-slate-900 placeholder:text-slate-400 outline-none focus:ring-0"
                />
              </div>
              <button
                type="submit"
                disabled={submitting}
                className="flex items-center justify-center gap-2 whitespace-nowrap rounded-xl bg-primary-600 px-8 py-3 font-medium text-white shadow-sm transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting ? "Loading…" : "Start Dictation"} {!submitting && <ArrowRight size={18} />}
              </button>
            </form>
            {error && <p className="mt-3 text-sm text-red-600">⚠ {error}</p>}
          </section>

          {dashboardError && <p className="text-sm text-red-600">{dashboardError}</p>}

          {dashboardLoading ? (
            <p className="text-sm text-slate-500">Loading workspace…</p>
          ) : !dashboardData ? (
            <p className="rounded-3xl border border-white/60 bg-white/50 p-4 text-sm text-slate-500 shadow-xl backdrop-blur-md">
              No workspace data yet. Start a new dictation to begin.
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
                    <span className="text-sm font-semibold">{dashboardData.completedVideos} Videos</span>
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
                      <Link href="/vocabulary" className="flex items-center gap-1 text-sm font-medium text-primary-600 hover:text-primary-700">
                        View all <ArrowRight size={16} />
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

                  <section id="history" className="rounded-3xl border border-white/60 bg-white/50 p-4 shadow-xl backdrop-blur-md">
                    <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-900">History</h2>
                    {dashboardData.resumableSessions.length === 0 ? (
                      <p className="text-sm text-slate-500">No recent sessions yet.</p>
                    ) : (
                      <ul className="space-y-2">
                        {dashboardData.resumableSessions.slice(0, 5).map((session) => (
                          <li key={session.sessionId} className="rounded-xl border border-slate-200 bg-white p-3 text-sm">
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
        </main>
      </div>
    </div>
  );
}

function LandingFeatureCard({
  icon,
  title,
  description,
  delay,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  delay: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay }}
      className="rounded-3xl border border-white/60 bg-white/40 p-6 shadow-xl transition-all hover:-translate-y-1 backdrop-blur-xl"
    >
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-white/80 bg-white/60 text-indigo-600 shadow-sm">
        {icon}
      </div>
      <h3 className="mb-2 text-lg font-semibold text-slate-900">{title}</h3>
      <p className="text-sm leading-relaxed text-slate-500">{description}</p>
    </motion.div>
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
  icon: ReactNode;
  trend?: string;
  positive?: boolean;
}) {
  return (
    <div className="flex flex-col rounded-3xl border border-white/60 bg-white/50 p-5 shadow-xl transition-all hover:-translate-y-1 backdrop-blur-md">
      <div className="mb-2 flex items-start justify-between">
        <div className="text-slate-500">{icon}</div>
        {trend && (
          <div className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${positive ? "bg-emerald-50 text-emerald-600" : "bg-slate-100 text-slate-600"}`}>
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

function VocabRow({ word, context }: { word: string; context: string }) {
  return (
    <tr className="group cursor-pointer transition-colors hover:bg-white/40">
      <td className="w-1/3 px-4 py-3 align-top">
        <div className="font-semibold text-slate-900">{word}</div>
      </td>
      <td className="px-4 py-3 align-top">
        <div className="line-clamp-2 text-xs italic text-slate-500 transition-colors group-hover:text-slate-700">&quot;{context}&quot;</div>
      </td>
    </tr>
  );
}
