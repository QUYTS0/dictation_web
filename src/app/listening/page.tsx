"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Headphones, Languages, Video } from "lucide-react";
import { isValidYouTubeUrl } from "@/lib/utils/url";
import AppHeader from "@/components/AppHeader";

export default function ListeningLandingPage() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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

      router.push(`/listening/${data.videoId}`);
    } catch {
      setError("Network error. Please check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="relative flex min-h-screen w-full flex-col overflow-hidden bg-[#f4f7ff] font-sans text-slate-900 antialiased">
      <div className="pointer-events-none absolute -left-[10%] -top-[10%] z-0 h-[40%] w-[40%] rounded-full bg-purple-200 opacity-60 blur-[120px]" />
      <div className="pointer-events-none absolute bottom-[10%] right-[0%] z-0 h-[40%] w-[40%] rounded-full bg-blue-200 opacity-60 blur-[120px]" />

      <div className="relative z-10 flex flex-1 flex-col">
        <AppHeader active="listening" />

        <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-center px-4 py-16">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-primary-100 bg-primary-50 px-3 py-1 text-xs font-semibold text-primary-700">
            <Headphones size={14} className="text-primary-500" />
            <span>Listening Practice</span>
          </div>
          <h1 className="mb-4 text-center text-3xl font-semibold leading-tight tracking-tight text-slate-900 md:text-5xl">
            Paste a video, get script + <span className="text-primary-600">Vietnamese translation</span>
          </h1>
          <p className="mx-auto mb-8 max-w-xl text-center text-base leading-relaxed text-slate-600">
            Play the video normally and toggle the English script and Vietnamese translation on or off,
            karaoke-style, to train your listening comprehension at your own pace.
          </p>

          <form
            onSubmit={handleStart}
            className="mx-auto flex w-full max-w-2xl flex-col gap-3 rounded-3xl border border-white/60 bg-white/40 p-3 shadow-xl transition-all focus-within:ring-2 focus-within:ring-primary-500/30 backdrop-blur-xl md:p-4 sm:flex-row"
          >
            <div className="relative flex flex-1 items-center">
              <Video className="absolute left-4 text-slate-400" size={20} />
              <input
                id="listening-youtube-url"
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
              {submitting ? "Loading…" : "Start Listening"} {!submitting && <ArrowRight size={18} />}
            </button>
          </form>
          {error && <p className="mt-3 text-sm text-red-600">⚠ {error}</p>}

          <div className="mt-10 flex items-center gap-2 rounded-2xl border border-white/60 bg-white/40 px-4 py-3 text-sm text-slate-600 shadow-sm backdrop-blur-md">
            <Languages size={18} className="text-primary-500" />
            Translations try YouTube&apos;s Vietnamese captions first, then fall back automatically if unavailable.
          </div>
        </main>
      </div>
    </div>
  );
}
