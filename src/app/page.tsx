"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
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

  return (
    <>
      <nav className="flex items-center justify-between px-4 py-3 border-b border-slate-200 bg-white">
        <div className="flex items-center gap-4">
          <span className="font-bold text-slate-800 text-base">🎧 Dictation Trainer</span>
          {user && (
            <Link
              href="/vocabulary"
              className="text-sm font-medium text-slate-600 hover:text-slate-900"
            >
              Vocabulary
            </Link>
          )}
        </div>
        <div className="shrink-0">
          <UserButton />
        </div>
      </nav>

      {authLoading ? (
        <main className="max-w-5xl mx-auto w-full p-4 md:p-6">
          <p className="text-sm text-slate-500">Loading…</p>
        </main>
      ) : user ? (
        <main className="max-w-5xl mx-auto w-full p-4 md:p-6 flex flex-col gap-4">
          <section className="rounded-2xl border border-slate-200 bg-white p-5 md:p-6 shadow-sm">
            <div className="mb-4">
              <h1 className="text-2xl font-bold text-slate-900">Start New Dictation</h1>
              <p className="text-sm text-slate-500 mt-1">
                Paste a YouTube URL and continue improving your listening accuracy.
              </p>
            </div>
            <form onSubmit={handleStart} className="flex flex-col gap-3">
              <label htmlFor="youtube-url" className="font-semibold text-slate-700 text-sm">
                YouTube video URL
              </label>
              <input
                id="youtube-url"
                type="text"
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  setError(null);
                }}
                placeholder="https://www.youtube.com/watch?v=..."
                className="w-full rounded-xl border border-slate-300 px-4 py-3 text-base outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 transition-colors"
                autoFocus
              />
              {error && (
                <p className="text-red-600 text-sm flex items-center gap-1">
                  <span>⚠</span> {error}
                </p>
              )}
              <button
                type="submit"
                disabled={submitting}
                className="w-full sm:w-auto rounded-xl bg-indigo-600 text-white font-bold px-6 py-3 text-base hover:bg-indigo-700 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {submitting ? "Loading…" : "Start Dictation →"}
              </button>
            </form>
          </section>

          {dashboardError && <p className="text-red-600 text-sm">{dashboardError}</p>}

          {dashboardLoading ? (
            <p className="text-sm text-slate-500">Loading workspace…</p>
          ) : !dashboardData ? (
            <p className="text-sm text-slate-500">No workspace data yet. Start a new dictation to begin.</p>
          ) : (
            <>
              <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <MetricCard title="Completed videos" value={String(dashboardData.completedVideos)} />
                <MetricCard title="Average accuracy" value={`${dashboardData.avgAccuracy}%`} />
                <MetricCard title="Practice time" value={`${dashboardData.totalPracticeMinutes} min`} />
                <MetricCard title="Vocabulary" value={String(dashboardData.vocabularyCount)} />
              </section>

              <section className="rounded-xl border border-slate-200 bg-white p-4">
                <h2 className="font-semibold text-slate-800 mb-2">Continue learning</h2>
                {dashboardData.resumableSessions.length === 0 ? (
                  <p className="text-sm text-slate-500">No recent lessons to continue yet.</p>
                ) : (
                  <ul className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {dashboardData.resumableSessions.map((session) => (
                      <li key={session.sessionId} className="rounded-xl border border-slate-200 overflow-hidden">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={`https://img.youtube.com/vi/${session.videoId}/hqdefault.jpg`}
                          alt={session.videoTitle ?? `Thumbnail for lesson video ${session.videoId}`}
                          className="w-full aspect-video object-cover bg-slate-100"
                          loading="lazy"
                        />
                        <div className="p-3 flex flex-col gap-2">
                          <p className="font-semibold text-slate-900 line-clamp-2">
                            {session.videoTitle ?? `Video ${session.videoId}`}
                          </p>
                          <p className="text-xs text-slate-500">
                            Last practiced {new Date(session.updatedAt).toLocaleString()}
                          </p>
                          <div className="grid grid-cols-2 gap-2 text-xs text-slate-600">
                            <p>Accuracy: {session.accuracy}%</p>
                            <p>Segment: {session.currentSegmentIndex + 1}</p>
                            <p>Attempts: {session.totalAttempts}</p>
                            <p>Mistakes: {session.mistakesCount}</p>
                          </div>
                          <div className="flex items-center justify-between gap-2 pt-1">
                            <p className="text-xs text-slate-500">
                              {session.mistakesCount > 0
                                ? "Review mistakes in this lesson."
                                : "Continue this lesson from where you left off."}
                            </p>
                            <Link
                              href={`/dictation/${session.videoId}`}
                              className="inline-flex items-center rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 transition-colors"
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

              <section className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex items-center justify-between gap-3 mb-2">
                  <h2 className="font-semibold text-slate-800">Recent vocabulary</h2>
                  <Link href="/vocabulary" className="text-xs text-indigo-600 hover:text-indigo-800 underline">
                    View all
                  </Link>
                </div>
                {dashboardData.recentVocabulary.length === 0 ? (
                  <p className="text-sm text-slate-500">No saved vocabulary yet.</p>
                ) : (
                  <ul className="space-y-2">
                    {dashboardData.recentVocabulary.map((item) => (
                      <li key={item.id} className="text-sm">
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
        <main className="flex flex-1 flex-col items-center justify-center px-4 py-16">
          <div className="mb-10 text-center">
            <div className="text-5xl mb-4">🎧</div>
            <h1 className="text-4xl font-extrabold tracking-tight text-slate-900 mb-2">
              English Dictation Trainer
            </h1>
            <p className="text-slate-500 text-lg max-w-md mx-auto">
              Paste a YouTube link, listen sentence by sentence, and type what you
              hear. AI will help you fix mistakes.
            </p>
          </div>

          <form
            onSubmit={handleStart}
            className="w-full max-w-xl bg-white rounded-2xl shadow-md border border-slate-200 p-6 flex flex-col gap-4"
          >
            <label htmlFor="youtube-url" className="font-semibold text-slate-700">
              YouTube video URL
            </label>
            <input
              id="youtube-url"
              type="text"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setError(null);
              }}
              placeholder="https://www.youtube.com/watch?v=..."
              className="w-full rounded-xl border border-slate-300 px-4 py-3 text-base outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 transition-colors"
              autoFocus
            />

            {error && (
              <p className="text-red-600 text-sm flex items-center gap-1">
                <span>⚠</span> {error}
              </p>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-xl bg-indigo-600 text-white font-bold py-3 text-base hover:bg-indigo-700 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {submitting ? "Loading…" : "Start Dictation →"}
            </button>

            <p className="text-center text-xs text-slate-400">
              Start without signing in.{" "}
              <span className="text-slate-500">
                Sign in to save progress, vocabulary, and dashboard data.
              </span>
            </p>
          </form>

          <ul className="mt-10 grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-xl w-full text-sm text-slate-600">
            {[
              "▶  Auto-pause after each sentence",
              "✅  Relaxed matching (case & punctuation ignored)",
              "💡  4-level hint system",
              "🤖  AI grammar explanations",
              "📊  Progress & accuracy tracking",
              "🔁  Replay any sentence anytime",
            ].map((feature) => (
              <li key={feature} className="flex items-start gap-2">
                {feature}
              </li>
            ))}
          </ul>
        </main>
      )}
    </>
  );
}

function MetricCard({ title, value }: { title: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <p className="text-xs text-slate-500">{title}</p>
      <p className="text-2xl font-bold text-slate-900 mt-1">{value}</p>
    </div>
  );
}
