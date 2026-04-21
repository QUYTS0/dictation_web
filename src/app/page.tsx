"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  BookOpen,
  CheckCircle2,
  Clock3,
  Headphones,
  PlayCircle,
  Video,
} from "lucide-react";
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

const LANDING_FEATURE_CARDS = [
  {
    title: "Auto-pause engine",
    description: "The lesson pauses sentence by sentence so you can listen and type with focus.",
  },
  {
    title: "Relaxed matching",
    description: "Case and punctuation are handled for you so you can focus on comprehension.",
  },
  {
    title: "Progress tracking",
    description: "Sign in to save vocabulary, resume sessions, and track your improvement.",
  },
] as const;
const MAX_DISPLAYED_MISTAKE_SESSIONS = 4;

export default function HomePage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [dashboardData, setDashboardData] = useState<DashboardData | null>(null);
  const [dashboardError, setDashboardError] = useState<string | null>(null);
  const [dashboardLoading, setDashboardLoading] = useState(false);

  const handleStart = async (e: React.FormEvent) => {
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

  const resumableSessionsWithMistakes = dashboardData?.resumableSessions.filter((session) => session.mistakesCount > 0) ?? [];

  return (
    <>
      <nav
        aria-label="Primary navigation"
        className="sticky top-0 z-20 border-b border-white/60 bg-white/70 px-4 py-3 backdrop-blur-md"
      >
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-600 text-white shadow-sm">
              <Headphones size={18} />
            </div>
            <span className="text-lg font-semibold tracking-tight text-slate-900">DictaLearn</span>
            {user && (
              <Link
                href="/vocabulary"
                className="ml-2 hidden text-sm font-medium text-slate-500 transition-colors hover:text-indigo-600 sm:inline"
              >
                Vocabulary
              </Link>
            )}
          </div>
          <div className="shrink-0">
            <UserButton />
          </div>
        </div>
      </nav>

      {authLoading ? (
        <main className="mx-auto w-full max-w-6xl p-4 md:p-6">
          <p className="text-sm text-slate-500">Loading…</p>
        </main>
      ) : user ? (
        <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 md:p-6">
          <section className="rounded-3xl border border-white/70 bg-white/60 p-5 shadow-lg backdrop-blur-xl md:p-6">
            <div className="mb-4">
              <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Start your next dictation</h1>
              <p className="mt-1 text-sm text-slate-500">
                Paste a YouTube URL and jump right back into focused listening practice.
              </p>
            </div>
            <form onSubmit={handleStart} className="flex flex-col gap-3 md:flex-row md:items-center">
              <label htmlFor="youtube-url" className="sr-only">
                Enter a YouTube video URL to start your dictation lesson
              </label>
              <div className="relative flex-1">
                <Video
                  aria-hidden="true"
                  className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-400"
                  size={18}
                />
                <input
                  id="youtube-url"
                  type="text"
                  value={url}
                  onChange={(e) => {
                    setUrl(e.target.value);
                    setError(null);
                  }}
                  placeholder="https://www.youtube.com/watch?v=..."
                  className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 pl-11 text-base text-slate-900 outline-none transition-colors placeholder:text-slate-400 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                  autoFocus
                />
              </div>
              <button
                type="submit"
                disabled={submitting}
                className="inline-flex items-center justify-center gap-2 rounded-2xl bg-indigo-600 px-6 py-3 text-base font-semibold text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting ? "Loading…" : "Start Dictation"}
                {!submitting && <ArrowRight size={17} />}
              </button>
            </form>
            {error && (
              <p className="mt-3 flex items-center gap-1 text-sm text-red-600">
                <span>⚠</span> {error}
              </p>
            )}
          </section>

          {dashboardError && <p className="text-sm text-red-600">{dashboardError}</p>}

          {dashboardLoading ? (
            <p className="text-sm text-slate-500">Loading workspace…</p>
          ) : !dashboardData ? (
            <p className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-500">
              No workspace data yet. Start a new dictation to begin.
            </p>
          ) : (
            <>
              <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <MetricCard title="Completed videos" value={String(dashboardData.completedVideos)} icon={<PlayCircle size={18} />} />
                <MetricCard title="Average accuracy" value={`${dashboardData.avgAccuracy}%`} icon={<CheckCircle2 size={18} />} />
                <MetricCard title="Practice time" value={`${dashboardData.totalPracticeMinutes} min`} icon={<Clock3 size={18} />} />
                <MetricCard title="Vocabulary" value={String(dashboardData.vocabularyCount)} icon={<BookOpen size={18} />} />
              </section>

              <div className="grid gap-4 lg:grid-cols-3">
                <section className="rounded-3xl border border-white/70 bg-white/60 p-4 shadow-md backdrop-blur-xl lg:col-span-2">
                  <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-700">Continue learning</h2>
                  {dashboardData.resumableSessions.length === 0 ? (
                    <p className="text-sm text-slate-500">No recent sessions yet.</p>
                  ) : (
                    <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
                      {dashboardData.resumableSessions.map((session) => (
                        <li key={session.sessionId} className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={`https://img.youtube.com/vi/${session.videoId}/hqdefault.jpg`}
                            alt={session.videoTitle ?? `Thumbnail for lesson video ${session.videoId}`}
                            className="aspect-video w-full bg-slate-100 object-cover"
                            loading="lazy"
                          />
                          <div className="flex flex-col gap-2 p-3">
                            <p className="line-clamp-2 font-semibold text-slate-900">
                              {session.videoTitle ?? `Video ${session.videoId}`}
                            </p>
                            <p className="text-xs text-slate-500">Last practiced {new Date(session.updatedAt).toLocaleString()}</p>
                            <div className="grid grid-cols-2 gap-2 text-xs text-slate-600">
                              <p>Accuracy: {session.accuracy}%</p>
                              <p>Segment: {session.currentSegmentIndex + 1}</p>
                              <p>Attempts: {session.totalAttempts}</p>
                              <p>Mistakes: {session.mistakesCount}</p>
                            </div>
                            <div className="pt-1">
                              <Link
                                href={`/dictation/${session.videoId}`}
                                className="inline-flex items-center rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-indigo-700"
                              >
                                Resume
                              </Link>
                            </div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                <section className="rounded-3xl border border-white/70 bg-white/60 p-4 shadow-md backdrop-blur-xl">
                  <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-700">Recent mistakes</h2>
                  {resumableSessionsWithMistakes.length === 0 ? (
                    <p className="text-sm text-slate-500">No mistakes to review in recent sessions.</p>
                  ) : (
                    <ul className="space-y-2">
                      {resumableSessionsWithMistakes.slice(0, MAX_DISPLAYED_MISTAKE_SESSIONS).map((session) => (
                        <li key={session.sessionId} className="rounded-xl border border-slate-200 bg-white p-3">
                          <p className="line-clamp-2 text-sm font-medium text-slate-800">
                            {session.videoTitle ?? `Video ${session.videoId}`}
                          </p>
                          <p className="mt-1 text-xs text-slate-500">Mistakes: {session.mistakesCount}</p>
                          <Link
                            href={`/dictation/${session.videoId}`}
                            className="mt-2 inline-flex text-xs font-semibold text-indigo-600 transition-colors hover:text-indigo-800"
                          >
                            Review lesson
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </div>

              <section className="rounded-3xl border border-white/70 bg-white/60 p-4 shadow-md backdrop-blur-xl">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-700">Recent vocabulary</h2>
                  <Link href="/vocabulary" className="text-xs font-medium text-indigo-600 transition-colors hover:text-indigo-800">
                    View all
                  </Link>
                </div>
                {dashboardData.recentVocabulary.length === 0 ? (
                  <p className="text-sm text-slate-500">No saved vocabulary yet.</p>
                ) : (
                  <ul className="space-y-2">
                    {dashboardData.recentVocabulary.map((item) => (
                      <li key={item.id} className="rounded-xl border border-slate-200 bg-white p-3 text-sm">
                        <p className="font-medium text-slate-800">{item.term}</p>
                        <p className="text-xs text-slate-500">{item.sentence_context}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
        </main>
      ) : (
        <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col items-center px-4 py-12 md:py-16">
          <section className="w-full max-w-3xl text-center">
            <span
              role="status"
              className="mb-5 inline-flex items-center gap-2 rounded-full border border-indigo-100 bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-700"
            >
              <PlayCircle size={14} className="text-indigo-600" />
              Master English through listening
            </span>
            <h1 className="text-balance text-4xl font-semibold tracking-tight text-slate-900 md:text-5xl">
              Turn any YouTube video into an interactive language lesson
            </h1>
            <p className="mx-auto mt-4 max-w-2xl text-base text-slate-600 md:text-lg">
              Paste a link, listen sentence by sentence, and type what you hear. Get instant feedback while you practice.
            </p>
          </section>

          <form
            onSubmit={handleStart}
            className="mt-8 flex w-full max-w-3xl flex-col gap-3 rounded-3xl border border-white/70 bg-white/60 p-4 shadow-xl backdrop-blur-xl md:flex-row"
          >
            <label htmlFor="youtube-url" className="sr-only">
              Enter a YouTube video URL to start your dictation lesson
            </label>
            <div className="relative flex-1">
              <Video
                aria-hidden="true"
                className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-400"
                size={18}
              />
              <input
                id="youtube-url"
                type="text"
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  setError(null);
                }}
                placeholder="Paste YouTube URL here..."
                className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 pl-11 text-base text-slate-900 outline-none transition-colors placeholder:text-slate-400 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                autoFocus
              />
            </div>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center justify-center gap-2 rounded-2xl bg-indigo-600 px-6 py-3 text-base font-semibold text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? "Loading…" : "Start Dictation"}
              {!submitting && <ArrowRight size={17} />}
            </button>
          </form>

          {error && (
            <p className="mt-3 flex items-center gap-1 text-sm text-red-600">
              <span>⚠</span> {error}
            </p>
          )}

          <p className="mt-4 text-sm text-slate-500">
            Start without signing in. Sign in later to save progress.
          </p>

          <section className="mt-10 grid w-full max-w-5xl grid-cols-1 gap-4 md:grid-cols-3">
            {LANDING_FEATURE_CARDS.map((feature) => (
              <FeatureCard key={feature.title} title={feature.title} description={feature.description} />
            ))}
          </section>
        </main>
      )}
    </>
  );
}

function MetricCard({ title, value, icon }: { title: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-white/70 bg-white/60 p-4 shadow-md backdrop-blur-xl">
      <div className="mb-2 text-indigo-600">{icon}</div>
      <p className="text-xs uppercase tracking-wide text-slate-500">{title}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">{value}</p>
    </div>
  );
}

function FeatureCard({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-3xl border border-white/70 bg-white/60 p-5 shadow-lg backdrop-blur-xl">
      <h3 className="text-lg font-semibold tracking-tight text-slate-900">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-slate-600">{description}</p>
    </div>
  );
}
