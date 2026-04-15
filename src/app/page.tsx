"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { isValidYouTubeUrl } from "@/lib/utils/url";
import UserButton from "@/components/UserButton";

export default function HomePage() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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

    setLoading(true);
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
      setLoading(false);
    }
  };

  return (
    <>
      {/* Site nav */}
      <nav className="flex items-center justify-between px-4 py-3 border-b border-slate-200 bg-white">
        <span className="font-bold text-slate-800 text-base">🎧 Dictation Trainer</span>
        <UserButton />
      </nav>

      <main className="flex flex-1 flex-col items-center justify-center px-4 py-16">
        {/* Header */}
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

        {/* Input form */}
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
            disabled={loading}
            className="w-full rounded-xl bg-indigo-600 text-white font-bold py-3 text-base hover:bg-indigo-700 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {loading ? "Loading…" : "Start Dictation →"}
          </button>

          {/* Helper text */}
          <p className="text-center text-xs text-slate-400">
            Start without signing in.{" "}
            <span className="text-slate-500">
              Sign in to save progress, vocabulary, and dashboard data.
            </span>
          </p>
        </form>

        {/* Feature list */}
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
    </>
  );
}
