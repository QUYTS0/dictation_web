"use client";

import { use, useEffect, useRef } from "react";
import Link from "next/link";
import clsx from "clsx";
import { ArrowLeft, FileText, Keyboard, Languages, Play } from "lucide-react";

import YouTubePlayer from "@/components/YouTubePlayer";
import UserButton from "@/components/UserButton";
import { StatusCard } from "@/components/StatusCard";

import { useAuth, useRequireAuth } from "@/context/auth";
import { useBookmarks } from "@/hooks/useBookmarks";
import { formatDurationSeconds } from "@/lib/utils/time";
import { useListeningSession } from "./useListeningSession";
import { SubtitleOverlay } from "./components/SubtitleOverlay";
import { TranscriptPanel } from "./components/TranscriptPanel";

interface PageProps {
  params: Promise<{ videoId: string }>;
}

export default function ListeningPage({ params }: PageProps) {
  const { videoId } = use(params);
  const { user } = useAuth();
  const requireAuth = useRequireAuth();

  const {
    loadState,
    transcriptTitle,
    segments,
    activeSegmentIndex,
    showScript,
    setShowScript,
    showTranslation,
    setShowTranslation,
    translationLoading,
    translationError,
    hasTranslations,
    refetchTranscript,
    refetchTranslation,
    ytPlayerRef,
    handleSeekToSegment,
    handleStart,
    handleResume,
    handleSegmentEnd,
    resumeAvailable,
    resumeTimeSec,
  } = useListeningSession({ videoId, user });

  const { bookmarkedSegmentIndexes, toggleBookmark } = useBookmarks(videoId, user);

  const handleToggleBookmark = (segment: { segmentIndex: number; start: number; textEn: string }) => {
    requireAuth(() => {
      void toggleBookmark(segment.segmentIndex, segment.start, segment.textEn).catch(() => {});
    });
  };

  // ---- Deep-link jump: "?segment=" opens the video directly at a bookmarked sentence. ----
  const segmentJumpAppliedRef = useRef(false);
  useEffect(() => {
    if (segmentJumpAppliedRef.current) return;
    if (loadState !== "ready" || segments.length === 0) return;
    const segmentParam = new URLSearchParams(window.location.search).get("segment");
    if (!segmentParam) return;
    const segIdx = Number(segmentParam);
    if (!Number.isInteger(segIdx) || segIdx < 0 || segIdx >= segments.length) return;
    segmentJumpAppliedRef.current = true;
    handleSeekToSegment(segments[segIdx]);
  }, [loadState, segments, handleSeekToSegment]);

  const activeSegment = activeSegmentIndex >= 0 ? segments[activeSegmentIndex] : null;
  const workspaceTitle = transcriptTitle ?? `Video ${videoId}`;

  return (
    <div className="relative flex h-screen w-full flex-col overflow-hidden bg-[#f4f7ff] font-sans text-slate-900 antialiased">
      <div className="pointer-events-none absolute -left-[10%] -top-[10%] z-0 h-[40%] w-[40%] rounded-full bg-purple-200 opacity-60 blur-[120px]" />
      <div className="pointer-events-none absolute bottom-[10%] right-[0%] z-0 h-[40%] w-[40%] rounded-full bg-blue-200 opacity-60 blur-[120px]" />

      <header className="sticky top-0 z-10 w-full border-b border-white/40 bg-white/30 px-4 py-3 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-none items-center justify-between">
          <div className="flex min-w-0 items-center gap-4">
            <Link
              href="/dashboard"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100"
              aria-label="Back to dashboard"
            >
              <ArrowLeft size={18} />
            </Link>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold leading-tight text-slate-900">{workspaceTitle}</h1>
              <span className="text-xs text-slate-500">Listening Practice</span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <Link
              href={`/dictation/${videoId}`}
              className="hidden items-center gap-1.5 rounded-lg border border-white/60 bg-white/40 px-2.5 py-1 text-xs font-semibold text-slate-600 transition-colors hover:bg-white/80 sm:flex"
              title="Switch to Dictation mode — same transcript, no regenerating"
            >
              <Keyboard size={14} />
              Dictation mode
            </Link>
            <UserButton />
          </div>
        </div>
      </header>

      <main className="relative z-10 mx-auto flex w-full max-w-7xl flex-1 flex-col gap-4 overflow-y-auto px-4 py-4 lg:flex-row lg:overflow-hidden">
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setShowScript((v) => !v)}
              className={clsx(
                "flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-bold transition-colors",
                showScript
                  ? "border-primary-200 bg-primary-50 text-primary-700"
                  : "border-white/60 bg-white/40 text-slate-600 hover:bg-white/80"
              )}
            >
              <FileText size={14} />
              {showScript ? "Script: On" : "Script: Off"}
            </button>
            <button
              type="button"
              onClick={() => setShowTranslation((v) => !v)}
              className={clsx(
                "flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-bold transition-colors",
                showTranslation
                  ? "border-primary-200 bg-primary-50 text-primary-700"
                  : "border-white/60 bg-white/40 text-slate-600 hover:bg-white/80"
              )}
            >
              <Languages size={14} />
              {showTranslation ? "Translation: On" : "Translation: Off"}
            </button>
          </div>

          <div className="relative aspect-video w-full shrink-0 overflow-hidden rounded-3xl border border-white/20 bg-black shadow-xl">
            {loadState === "ready" && (
              <YouTubePlayer ref={ytPlayerRef} videoId={videoId} segments={[]} onSegmentEnd={handleSegmentEnd} />
            )}
            <SubtitleOverlay segment={activeSegment} showScript={showScript} showTranslation={showTranslation} />
          </div>

          {loadState === "loading" && (
            <StatusCard icon="⏳" title="Loading transcript…" description="Fetching transcript from the database." />
          )}

          {loadState === "processing" && (
            <StatusCard
              icon="🔄"
              title="Generating transcript…"
              description="This may take a moment. The page will update automatically."
              pulse
            />
          )}

          {loadState === "failed" && (
            <StatusCard
              icon="❌"
              title="Transcript failed"
              description="Could not automatically fetch captions for this video. Try a different video with captions enabled, or use Dictation mode which supports pasting a transcript manually."
              error
              onRetry={() => void refetchTranscript()}
            />
          )}

          {loadState === "ready" && (
            <div className="flex flex-wrap items-center gap-3">
              {resumeAvailable && (
                <button
                  type="button"
                  onClick={handleResume}
                  className="flex items-center gap-2 rounded-xl bg-primary-600 px-6 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-primary-700"
                >
                  <Play size={16} /> Continue from {formatDurationSeconds(resumeTimeSec)}
                </button>
              )}
              <button
                type="button"
                onClick={handleStart}
                className={clsx(
                  "flex items-center gap-2 rounded-xl px-6 py-2 text-sm font-semibold shadow-sm transition-colors",
                  resumeAvailable
                    ? "border border-white/60 bg-white/40 text-slate-600 hover:bg-white/80"
                    : "bg-primary-600 text-white hover:bg-primary-700"
                )}
              >
                <Play size={16} /> Start from beginning
              </button>
              {translationLoading && (
                <span className="text-xs text-slate-500">Fetching Vietnamese translation…</span>
              )}
              {!translationLoading && translationError && !hasTranslations && (
                <span role="alert" className="flex items-center gap-2 text-xs text-red-500">
                  Translation unavailable right now — showing script only.
                  <button
                    type="button"
                    onClick={() => void refetchTranslation()}
                    className="font-semibold underline text-red-600 hover:text-red-800"
                  >
                    Retry
                  </button>
                </span>
              )}
            </div>
          )}
        </div>

        <div className="flex min-h-0 w-full flex-col overflow-hidden rounded-3xl border border-white/80 bg-white/60 shadow-lg backdrop-blur-xl lg:w-[360px] lg:shrink-0">
          <div className="border-b border-white/40 bg-white/30 p-4 backdrop-blur-md">
            <h2 className="font-semibold text-slate-900">Script</h2>
          </div>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-4">
            <TranscriptPanel
              segments={segments}
              activeSegmentIndex={activeSegmentIndex}
              showScript={showScript}
              showTranslation={showTranslation}
              onSeek={handleSeekToSegment}
              bookmarkedSegmentIndexes={bookmarkedSegmentIndexes}
              onToggleBookmark={handleToggleBookmark}
            />
          </div>
        </div>
      </main>
    </div>
  );
}
