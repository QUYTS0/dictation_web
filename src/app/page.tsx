"use client";

import { FormEvent, ReactNode, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import {
  ArrowRight,
  BrainCircuit,
  Headphones,
  Play,
  ShieldCheck,
  Video,
  Zap,
} from "lucide-react";
import { motion } from "motion/react";
import { isValidYouTubeUrl } from "@/lib/utils/url";
import { useAuth } from "@/context/auth";

type StudyMode = "dictation" | "listening";

function StudyModeToggle({ mode, onChange }: { mode: StudyMode; onChange: (mode: StudyMode) => void }) {
  return (
    <div className="flex shrink-0 items-center rounded-full border border-white/70 bg-white/60 p-1 shadow-sm backdrop-blur-md">
      <button
        type="button"
        onClick={() => onChange("dictation")}
        className={clsx(
          "rounded-full px-3 py-1.5 text-xs font-semibold transition-colors",
          mode === "dictation" ? "bg-primary-600 text-white" : "text-slate-600 hover:bg-white/80"
        )}
      >
        Dictation
      </button>
      <button
        type="button"
        onClick={() => onChange("listening")}
        className={clsx(
          "rounded-full px-3 py-1.5 text-xs font-semibold transition-colors",
          mode === "listening" ? "bg-primary-600 text-white" : "text-slate-600 hover:bg-white/80"
        )}
      >
        Listening
      </button>
    </div>
  );
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
  const [mode, setMode] = useState<StudyMode>("dictation");
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

      router.push(mode === "listening" ? `/dictation/${data.videoId}?mode=listening` : `/dictation/${data.videoId}`);
    } catch {
      setError("Network error. Please check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  };

  useEffect(() => {
    if (!authLoading && user) {
      router.replace("/dashboard");
    }
  }, [authLoading, user, router]);

  if (authLoading || user) {
    return (
      <main className="mx-auto w-full max-w-6xl p-4 md:p-6">
        <p className="text-sm text-slate-500">Loading…</p>
      </main>
    );
  }

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
                <a
                  href="#landing-youtube-url"
                  className="rounded-full bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-slate-800"
                >
                  Get Started
                </a>
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
                <h1 className="mb-6 text-4xl font-semibold leading-tight tracking-tight text-balance text-slate-900 md:text-6xl">
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
                className="mx-auto flex max-w-2xl flex-col gap-3 rounded-3xl border border-white/60 bg-white/40 p-3 shadow-xl transition-all focus-within:ring-2 focus-within:ring-primary-500/30 backdrop-blur-xl md:p-4"
              >
                <div className="flex flex-col gap-3 sm:flex-row">
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
                    {submitting ? "Loading…" : mode === "dictation" ? "Start Dictation" : "Start Listening"}{" "}
                    {!submitting && <ArrowRight size={18} />}
                  </button>
                </div>
                <div className="flex justify-center sm:justify-start">
                  <StudyModeToggle mode={mode} onChange={setMode} />
                </div>
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
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-white/80 bg-white/60 text-primary-600 shadow-sm">
        {icon}
      </div>
      <h3 className="mb-2 text-lg font-semibold text-slate-900">{title}</h3>
      <p className="text-sm leading-relaxed text-slate-500">{description}</p>
    </motion.div>
  );
}

