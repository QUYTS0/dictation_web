"use client";

import { use, useState, useCallback, useEffect, useRef, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { clsx } from "clsx";

import YouTubePlayer, { type YouTubePlayerHandle } from "@/components/YouTubePlayer";
import DictationInput from "@/components/DictationInput";
import HintDisplay from "@/components/HintDisplay";
import AIExplainer from "@/components/AIExplainer";
import ProgressBar from "@/components/ProgressBar";

import { usePlayerStore } from "@/store/playerStore";
import { useSessionStore, selectAccuracy } from "@/store/sessionStore";
import { normalizeText } from "@/lib/utils/text";
import type {
  TranscriptResponse,
  TranscriptSegment,
  CheckAnswerResponse,
  MatchMode,
  HintLevel,
  UXState,
} from "@/lib/types";

// ---- Data fetching ----

async function fetchTranscript(videoId: string): Promise<TranscriptResponse> {
  const res = await fetch(`/api/transcript/${videoId}?lang=en`);
  if (!res.ok) throw new Error("Failed to fetch transcript");
  return res.json();
}

async function checkAnswer(
  segmentIndex: number,
  userText: string,
  expectedText: string,
  matchMode: MatchMode,
  sessionId?: string
): Promise<CheckAnswerResponse> {
  const res = await fetch("/api/dictation/check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ segmentIndex, userText, expectedText, matchMode, sessionId }),
  });
  if (!res.ok) throw new Error("Failed to check answer");
  return res.json();
}

async function saveProgress(
  videoId: string,
  segmentIndex: number,
  accuracy: number,
  totalAttempts: number,
  sessionId?: string,
  transcriptId?: string,
  status: "active" | "completed" | "abandoned" = "active"
): Promise<{ sessionId: string }> {
  const res = await fetch("/api/session/save-progress", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId,
      youtubeVideoId: videoId,
      transcriptId,
      currentSegmentIndex: segmentIndex,
      accuracy,
      totalAttempts,
      status,
    }),
  });
  if (!res.ok) throw new Error("Failed to save progress");
  return res.json();
}

// ---- Page component ----

interface PageProps {
  params: Promise<{ videoId: string }>;
}

export default function DictationPage({ params }: PageProps) {
  const { videoId } = use(params);

  // Stores
  const playerStore = usePlayerStore();
  const sessionStore = useSessionStore();
  const accuracy = selectAccuracy(sessionStore);
  const queryClient = useQueryClient();

  // Local state
  const [currentSegIdx, setCurrentSegIdx] = useState(0);
  const [uxState, setUxState] = useState<UXState>("loading_transcript");
  const [checkResult, setCheckResult] = useState<CheckAnswerResponse | null>(null);
  const [wrongAttempts, setWrongAttempts] = useState(0);
  const [hintLevel, setHintLevel] = useState<HintLevel>(0);
  const [showAI, setShowAI] = useState(false);
  const [transcriptId, setTranscriptId] = useState<string | undefined>();
  const [isRegenerating, setIsRegenerating] = useState(false);
  // Incremented on each wrong-answer retry to force-remount DictationInput
  // (gives it fresh state without needing setState inside a useEffect).
  const [dictationKey, setDictationKey] = useState(0);

  const ytPlayerRef = useRef<YouTubePlayerHandle>(null);
  // Tracks whether the player is replaying the current segment after a correct
  // answer (before advancing to the next one).
  const isReplayingAfterCorrect = useRef(false);
  const nextSegAfterReplay = useRef(0);
  // Tracks whether the user manually triggered a replay while already paused
  // (R key / Replay button while input is visible). In this case we keep the
  // input and its typed words intact when the segment ends.
  const isManualReplayWhilePaused = useRef(false);

  // ---- Transcript query ----
  const transcriptQuery = useQuery({
    queryKey: ["transcript", videoId],
    queryFn: () => fetchTranscript(videoId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "processing" ? 3000 : false;
    },
    enabled: !!videoId,
  });

  const segments: TranscriptSegment[] = useMemo(
    () => transcriptQuery.data?.segments ?? [],
    [transcriptQuery.data?.segments]
  );
  const transcriptStatus = transcriptQuery.data?.status;

  // Sync segments into player store
  useEffect(() => {
    playerStore.setSegments(segments);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segments]);

  // Update UX state based on transcript status
  useEffect(() => {
    if (transcriptQuery.isLoading) {
      setUxState("loading_transcript");
    } else if (transcriptStatus === "processing") {
      setUxState("transcript_processing");
    } else if (transcriptStatus === "failed") {
      setUxState("transcript_failed");
    } else if (transcriptStatus === "ready" && segments.length > 0) {
      setUxState("transcript_ready");
    } else if (transcriptStatus === "ready" && segments.length === 0) {
      // Transcript marked ready but no segments — treat as failed so user gets feedback
      setUxState("transcript_failed");
    }
  }, [transcriptStatus, transcriptQuery.isLoading, segments.length]);

  // ---- Segment end handler (called by YouTubePlayer) ----
  const handleSegmentEnd = useCallback((segIdx: number) => {
    // Manual replay triggered while input was already visible — keep everything
    // intact so the user's typed words are preserved.
    if (isManualReplayWhilePaused.current) {
      isManualReplayWhilePaused.current = false;
      return;
    }

    if (isReplayingAfterCorrect.current) {
      // The player just finished the post-correct replay — advance to next segment.
      isReplayingAfterCorrect.current = false;
      const nextIdx = nextSegAfterReplay.current;
      setCheckResult(null);
      setWrongAttempts(0);
      setHintLevel(0);
      setShowAI(false);

      if (nextIdx < segments.length) {
        setCurrentSegIdx(nextIdx);
        ytPlayerRef.current?.playSegment(nextIdx);
        // uxState stays "playing" until the next segment ends normally
      } else {
        setUxState("session_completed");
        const state = useSessionStore.getState();
        void saveProgress(
          videoId,
          nextIdx,
          selectAccuracy(state),
          state.totalAttempts,
          state.sessionId ?? undefined,
          transcriptId,
          "completed"
        );
      }
      return;
    }

    // Normal flow: segment ended while practicing — show the dictation input.
    setCurrentSegIdx(segIdx);
    setCheckResult(null);
    setWrongAttempts(0);
    setHintLevel(0);
    setShowAI(false);
    setUxState("paused_waiting_input");
  }, [segments.length, videoId, transcriptId]);

  // ---- Answer submission ----
  const handleAnswerSubmit = useCallback(
    async (userText: string) => {
      if (!segments[currentSegIdx]) return;
      setUxState("checking_answer");

      try {
        const result = await checkAnswer(
          currentSegIdx,
          userText,
          segments[currentSegIdx].text,
          "relaxed",
          sessionStore.sessionId ?? undefined
        );

        setCheckResult(result);
        sessionStore.incrementAttempt(result.isCorrect);

        if (result.isCorrect) {
          setWrongAttempts(0);
          setHintLevel(0);
          setUxState("playing");

          // Replay the current sentence so the user hears it again before moving on.
          // handleSegmentEnd will advance to the next segment when the replay finishes.
          isReplayingAfterCorrect.current = true;
          nextSegAfterReplay.current = currentSegIdx + 1;
          ytPlayerRef.current?.playSegment(currentSegIdx);

          // Save progress (fire-and-forget)
          const state = useSessionStore.getState();
          saveProgress(
            videoId,
            currentSegIdx + 1,
            selectAccuracy(state),
            state.totalAttempts,
            state.sessionId ?? undefined,
            transcriptId
          )
            .then((r) => {
              if (!state.sessionId) sessionStore.setSessionId(r.sessionId);
            })
            .catch(() => {});
        } else {
          const newWrong = wrongAttempts + 1;
          setWrongAttempts(newWrong);
          if (newWrong >= 3) setShowAI(true);
          setDictationKey((k) => k + 1); // remount DictationInput so state resets cleanly
          setUxState("paused_waiting_input");
        }
      } catch {
        setUxState("paused_waiting_input");
      }
    },
    [currentSegIdx, segments, sessionStore, videoId, transcriptId, wrongAttempts]
  );

  // ---- Start session (seek to segment 0 and play) ----
  const handleStart = useCallback(() => {
    setUxState("playing");
    ytPlayerRef.current?.playSegment(0);
  }, []);

  // ---- Replay current segment ----
  const handleReplay = useCallback(() => {
    // If the input is already visible, mark this as a "paused replay" so the
    // segment-end handler won't reset the input or typed words.
    const isAlreadyPaused = uxState === "paused_waiting_input";
    isManualReplayWhilePaused.current = isAlreadyPaused;
    if (!isAlreadyPaused) {
      setUxState("playing");
      setCheckResult(null); // Clear stale check result when replaying from playing state
    }
    ytPlayerRef.current?.playSegment(currentSegIdx);
  }, [currentSegIdx, uxState]);

  // ---- Skip current segment ----
  const handleSkip = useCallback(() => {
    const nextIdx = currentSegIdx + 1;
    if (nextIdx < segments.length) {
      setCurrentSegIdx(nextIdx);
      ytPlayerRef.current?.playSegment(nextIdx);
      setCheckResult(null);
      setWrongAttempts(0);
      setHintLevel(0);
      setShowAI(false);
      setUxState("playing");
    }
  }, [currentSegIdx, segments.length]);

  // ---- Go to previous segment ----
  const handlePrevious = useCallback(() => {
    const prevIdx = currentSegIdx - 1;
    if (prevIdx >= 0) {
      setCurrentSegIdx(prevIdx);
      ytPlayerRef.current?.playSegment(prevIdx);
      setCheckResult(null);
      setWrongAttempts(0);
      setHintLevel(0);
      setShowAI(false);
      setUxState("playing");
    }
  }, [currentSegIdx]);

  // ---- Force-regenerate transcript ----
  const handleRegenerate = useCallback(async () => {
    setIsRegenerating(true);
    setTranscriptId(undefined);
    try {
      const res = await fetch("/api/transcript/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId, force: true }),
      });
      if (!res.ok) throw new Error("Regenerate request failed");
      // Reset UI state back to loading so the query refetch picks up the
      // new "processing" transcript and starts polling.
      setUxState("loading_transcript");
      setCurrentSegIdx(0);
      setCheckResult(null);
      setWrongAttempts(0);
      setHintLevel(0);
      setShowAI(false);
      await queryClient.invalidateQueries({ queryKey: ["transcript", videoId] });
    } catch {
      // Ignore errors — the user can try again
    } finally {
      setIsRegenerating(false);
    }
  }, [videoId, queryClient]);

  // ---- Keyboard shortcuts ----
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "r" || e.key === "R") handleReplay();
      if (e.key === "s" || e.key === "S") handleSkip();
      if (e.key === "ArrowLeft") { e.preventDefault(); handlePrevious(); }
      if (e.key === "ArrowRight") { e.preventDefault(); handleSkip(); }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [handleReplay, handleSkip, handlePrevious]);

  // ---- Trigger transcript generation if not ready ----
  useEffect(() => {
    if (transcriptStatus === "processing" && !transcriptId) {
      fetch("/api/transcript/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId }),
      })
        .then((r) => r.json())
        .then((d) => {
          if (d.transcriptId) setTranscriptId(d.transcriptId);
        })
        .catch(() => {});
    }
  }, [transcriptStatus, transcriptId, videoId]);

  const currentSegment = segments[currentSegIdx];

  // Precompute word counts for all segments once when segments load
  const wordCounts = useMemo(
    () =>
      segments.map((seg) =>
        normalizeText(seg.text, "relaxed").split(" ").filter(Boolean).length
      ),
    [segments]
  );
  const wordCount = wordCounts[currentSegIdx] ?? 0;

  // ---- Render ----
  return (
    <div className="min-h-screen flex flex-col">
      {/* Top bar */}
      <header className="bg-white border-b border-slate-200 px-4 py-3 flex items-center gap-4">
        <Link href="/" className="text-indigo-600 hover:text-indigo-800 text-sm font-medium">
          ← Back
        </Link>
        <h1 className="text-base font-bold text-slate-800 truncate flex-1">
          English Dictation Trainer
        </h1>
        {/* Regenerate button — shown when a transcript is loaded so user can fix timestamp issues */}
        {(uxState === "transcript_ready" || uxState === "playing" || uxState === "paused_waiting_input" || uxState === "checking_answer") && (
          <button
            onClick={handleRegenerate}
            disabled={isRegenerating}
            title="Re-fetch captions from YouTube if sentences don't match the audio"
            aria-label={isRegenerating ? "Regenerating transcript…" : "Regenerate transcript"}
            className="text-xs text-slate-400 hover:text-amber-600 disabled:opacity-50 transition-colors whitespace-nowrap"
          >
            {isRegenerating ? "⏳ Regenerating…" : "🔄 Regenerate"}
          </button>
        )}
        <span className="text-xs text-slate-400 font-mono">{videoId}</span>
      </header>

      <main className="flex-1 flex flex-col lg:flex-row gap-6 p-4 lg:p-6 max-w-5xl mx-auto w-full">
        {/* Left column: player + progress */}
        <div className="flex flex-col gap-4 lg:w-1/2">
          {/* YouTube Player */}
          <div className="w-full">
            {uxState !== "loading_transcript" &&
              uxState !== "transcript_processing" &&
              uxState !== "transcript_failed" && (
                <YouTubePlayer
                  ref={ytPlayerRef}
                  videoId={videoId}
                  segments={segments}
                  onSegmentEnd={handleSegmentEnd}
                />
              )}
          </div>

          {/* Progress bar */}
          {segments.length > 0 && (
            <ProgressBar
              currentIndex={currentSegIdx}
              totalSegments={segments.length}
              accuracy={accuracy}
            />
          )}

          {/* Replay / Skip controls */}
          {(uxState === "paused_waiting_input" || uxState === "playing") && (
            <div className="flex gap-2">
              <button
                onClick={handlePrevious}
                disabled={currentSegIdx === 0}
                className="flex-1 py-2 rounded-xl border border-slate-300 text-sm font-medium hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                title="Previous sentence (←)"
              >
                ⏮ Prev (←)
              </button>
              <button
                onClick={handleReplay}
                className="flex-1 py-2 rounded-xl border border-slate-300 text-sm font-medium hover:bg-slate-50 transition-colors"
                title="Replay (R)"
              >
                🔁 Replay (R)
              </button>
              <button
                onClick={handleSkip}
                disabled={currentSegIdx >= segments.length - 1}
                className="flex-1 py-2 rounded-xl border border-slate-300 text-sm font-medium hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                title="Next sentence (S / →)"
              >
                ⏭ Next (S/→)
              </button>
            </div>
          )}
        </div>

        {/* Right column: dictation controls */}
        <div className="flex flex-col gap-4 lg:w-1/2">
          {/* UX State indicators */}
          {uxState === "loading_transcript" && (
            <StatusCard icon="⏳" title="Loading transcript…" description="Fetching transcript from the database." />
          )}

          {uxState === "transcript_processing" && (
            <StatusCard
              icon="🔄"
              title="Generating transcript…"
              description="This may take a moment. The page will update automatically."
              pulse
            />
          )}

          {uxState === "transcript_failed" && (
            <div className="rounded-xl border border-red-300 bg-red-50 p-5 flex flex-col gap-2">
              <p className="text-2xl">❌</p>
              <p className="font-semibold text-slate-800">Transcript failed</p>
              <p className="text-sm text-slate-500">
                Could not generate a transcript for this video. You can try re-fetching from YouTube.
              </p>
              <button
                onClick={handleRegenerate}
                disabled={isRegenerating}
                aria-label={isRegenerating ? "Regenerating transcript…" : "Retry or regenerate transcript"}
                className="self-start mt-1 px-4 py-2 rounded-xl bg-amber-500 text-white font-semibold text-sm hover:bg-amber-600 disabled:opacity-50 transition-colors"
              >
                {isRegenerating ? "⏳ Regenerating…" : "🔄 Retry / Regenerate transcript"}
              </button>
            </div>
          )}

          {uxState === "transcript_ready" && segments.length > 0 && (
            <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-4 flex flex-col gap-3">
              <p className="text-emerald-700 font-semibold">
                ✅ Transcript ready — {segments.length} sentences
              </p>
              <p className="text-sm text-slate-600">
                Press the button below to start. The video will play each sentence one at a time and pause so you can type what you heard.
              </p>
              <div className="flex items-center gap-3 mt-1">
                <button
                  onClick={handleStart}
                  className="px-6 py-2 rounded-xl bg-indigo-600 text-white font-semibold text-sm hover:bg-indigo-700 transition-colors"
                >
                  ▶ Start Dictation
                </button>
                <button
                  onClick={handleRegenerate}
                  disabled={isRegenerating}
                  title="Re-fetch captions from YouTube to fix sentence/audio mismatches"
                  aria-label={isRegenerating ? "Regenerating transcript…" : "Regenerate transcript"}
                  className="text-xs text-slate-500 hover:text-amber-600 disabled:opacity-50 transition-colors underline"
                >
                  {isRegenerating ? "⏳ Regenerating…" : "🔄 Regenerate transcript"}
                </button>
              </div>
            </div>
          )}

          {uxState === "session_completed" && (
            <div className="rounded-xl border border-indigo-300 bg-indigo-50 p-6 flex flex-col gap-3 text-center">
              <p className="text-3xl">🎉</p>
              <p className="text-indigo-700 font-bold text-xl">Session Complete!</p>
              <p className="text-slate-600 text-sm">
                Final accuracy: <span className="font-bold">{accuracy}%</span> over{" "}
                {sessionStore.totalAttempts} attempts.
              </p>
              <Link
                href="/"
                className="mt-2 inline-block rounded-xl bg-indigo-600 text-white px-6 py-2 font-semibold hover:bg-indigo-700 transition-colors"
              >
                Try another video
              </Link>
            </div>
          )}

          {/* Dictation input area */}
          {(uxState === "paused_waiting_input" || uxState === "checking_answer") && (
            <div className="flex flex-col gap-4">
              {/* Current segment display (blank until answered) */}
              {currentSegment && (
                <div className="rounded-xl bg-white border border-slate-200 p-3 text-sm text-slate-400">
                  Sentence {currentSegIdx + 1} of {segments.length}
                </div>
              )}

              <DictationInput
                key={`${currentSegIdx}-${dictationKey}`}
                isEnabled={uxState === "paused_waiting_input"}
                wordCount={wordCount}
                onSubmit={handleAnswerSubmit}
                diff={checkResult?.diff}
                isCorrect={checkResult?.isCorrect ?? null}
                wrongAttempts={wrongAttempts}
              />

              {/* Hint */}
              {currentSegment && !checkResult?.isCorrect && (
                <HintDisplay
                  text={currentSegment.text}
                  level={hintLevel}
                  onLevelChange={(l) => setHintLevel(l)}
                />
              )}

              {/* AI Tutor */}
              {showAI && currentSegment && checkResult && !checkResult.isCorrect && (
                <AIExplainer
                  expectedText={currentSegment.text}
                  userText={checkResult.normalizedUser}
                />
              )}

              {!showAI && wrongAttempts > 0 && !checkResult?.isCorrect && (
                <button
                  onClick={() => setShowAI(true)}
                  className="text-xs text-violet-600 underline self-end hover:text-violet-800"
                >
                  Ask AI to explain
                </button>
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

// ---- Helper component ----

function StatusCard({
  icon,
  title,
  description,
  pulse,
  error,
}: {
  icon: string;
  title: string;
  description: string;
  pulse?: boolean;
  error?: boolean;
}) {
  return (
    <div
      className={clsx(
        "rounded-xl border p-5 flex flex-col gap-2",
        error
          ? "border-red-300 bg-red-50"
          : "border-slate-200 bg-white"
      )}
    >
      <p className={clsx("text-2xl", pulse && "animate-pulse")}>{icon}</p>
      <p className="font-semibold text-slate-800">{title}</p>
      <p className="text-sm text-slate-500">{description}</p>
    </div>
  );
}
