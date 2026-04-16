"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import UserButton from "@/components/UserButton";
import { useAuth } from "@/context/auth";

interface DashboardData {
  completedVideos: number;
  avgAccuracy: number;
  totalPracticeMinutes: number;
  vocabularyCount: number;
  recentMistakes: Array<{
    id: string;
    expected_text: string;
    user_text: string;
    error_type: string | null;
    created_at: string;
  }>;
  recentVocabulary: Array<{
    id: string;
    term: string;
    sentence_context: string;
    created_at: string;
  }>;
  resumableSessions: Array<{ videoId: string; updatedAt: string }>;
}

export default function DashboardPage() {
  const { user, loading, openAuthModal } = useAuth();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    fetch("/api/dashboard/summary")
      .then(async (res) => {
        if (!res.ok) throw new Error();
        return res.json();
      })
      .then(setData)
      .catch(() => setError("Failed to load dashboard."));
  }, [user]);

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-white border-b border-slate-200 px-4 py-3 flex items-center gap-4">
        <Link href="/" className="text-indigo-600 hover:text-indigo-800 text-sm font-medium">
          ← Back
        </Link>
        <h1 className="text-base font-bold text-slate-800 truncate flex-1">Dashboard</h1>
        <UserButton />
      </header>

      <main className="max-w-5xl mx-auto w-full p-4 md:p-6 flex flex-col gap-4">
        {loading ? null : !user ? (
          <div className="rounded-xl border border-slate-200 bg-white p-6">
            <p className="font-semibold text-slate-800">Sign in required</p>
            <p className="text-sm text-slate-500 mt-1">
              Dashboard is available for authenticated users only.
            </p>
            <button
              onClick={openAuthModal}
              className="mt-3 px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm"
            >
              Sign in
            </button>
          </div>
        ) : error ? (
          <p className="text-red-600 text-sm">{error}</p>
        ) : !data ? (
          <p className="text-slate-500 text-sm">Loading dashboard…</p>
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <MetricCard title="Completed videos" value={String(data.completedVideos)} />
              <MetricCard title="Average accuracy" value={`${data.avgAccuracy}%`} />
              <MetricCard title="Practice time" value={`${data.totalPracticeMinutes} min`} />
              <MetricCard title="Vocabulary" value={String(data.vocabularyCount)} />
            </div>

            <section className="rounded-xl border border-slate-200 bg-white p-4">
              <h2 className="font-semibold text-slate-800 mb-2">Quick resume</h2>
              {data.resumableSessions.length === 0 ? (
                <p className="text-sm text-slate-500">No active sessions.</p>
              ) : (
                <ul className="space-y-2">
                  {data.resumableSessions.map((session) => (
                    <li key={`${session.videoId}-${session.updatedAt}`}>
                      <Link
                        href={`/dictation/${session.videoId}`}
                        className="text-sm text-indigo-600 hover:text-indigo-800 underline"
                      >
                        Resume {session.videoId}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="rounded-xl border border-slate-200 bg-white p-4">
              <h2 className="font-semibold text-slate-800 mb-2">Quick links</h2>
              <div className="flex gap-3 text-sm">
                <Link href="/vocabulary" className="text-indigo-600 hover:text-indigo-800 underline">
                  Manage vocabulary
                </Link>
                <Link href="/" className="text-indigo-600 hover:text-indigo-800 underline">
                  Start new dictation
                </Link>
              </div>
            </section>

            <section className="rounded-xl border border-slate-200 bg-white p-4">
              <h2 className="font-semibold text-slate-800 mb-2">Recent mistakes</h2>
              {data.recentMistakes.length === 0 ? (
                <p className="text-sm text-slate-500">No mistakes logged yet.</p>
              ) : (
                <ul className="space-y-2">
                  {data.recentMistakes.map((mistake) => (
                    <li key={mistake.id} className="text-sm">
                      <p className="text-slate-800">{mistake.expected_text}</p>
                      <p className="text-red-500 text-xs">You typed: {mistake.user_text || "—"}</p>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="rounded-xl border border-slate-200 bg-white p-4">
              <h2 className="font-semibold text-slate-800 mb-2">Recent vocabulary</h2>
              {data.recentVocabulary.length === 0 ? (
                <p className="text-sm text-slate-500">No saved terms yet.</p>
              ) : (
                <ul className="space-y-2">
                  {data.recentVocabulary.map((item) => (
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
    </div>
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
