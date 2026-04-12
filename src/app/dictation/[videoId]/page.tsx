"use client";

import { use, useState, useCallback, useEffect, useRef, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { clsx } from "clsx";

import YouTubePlayer, { type YouTubePlayerHandle } from "@/components/YouTubePlayer";
import DictationInput from "@/components/DictationInput";
import HintDisplay from "@/components/HintDisplay";
import AIExplainer from "@/components/AIExplainer";
import ProgressBar from "@/components/ProgressBar";

import { usePlayerStore } from "@/store/playerStore";
import { useSessionStore, selectAccuracy } from "@/store/sessionStore";
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

  // Local state
  const [currentSegIdx, setCurrentSegIdx] = useState(0);
  const [uxState, setUxState] = useState<UXState>("loading_transcript");
  const [checkResult, setCheckResult] = useState<CheckAnswerResponse | null>(null);
  const [wrongAttempts, setWrongAttempts] = useState(0);
  const [hintLevel, setHintLevel] = useState<HintLevel>(0);
  const [showAI, setShowAI] = useState(false);
  const [transcriptId, setTranscriptId] = useState<string | undefined>();

  const ytPlayerRef = useRef<YouTubePlayerHandle>(null);

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
    }
  }, [transcriptStatus, transcriptQuery.isLoading, segments.length]);

  // ---- Segment end handler (called by YouTubePlayer) ----
  const handleSegmentEnd = useCallback((segIdx: number) => {
    setCurrentSegIdx(segIdx);
    setCheckResult(null);
    setWrongAttempts(0);
    setHintLevel(0);
    setShowAI(false);
    setUxState("paused_waiting_input");
  }, []);

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
          sessionStore.matchMode,
          sessionStore.sessionId ?? undefined
        );

        setCheckResult(result);
        sessionStore.incrementAttempt(result.isCorrect);

        if (result.isCorrect) {
          setWrongAttempts(0);
          setHintLevel(0);
          setUxState("playing");

          // Auto-advance to next segment after a brief delay
          const nextIdx = currentSegIdx + 1;
          if (nextIdx < segments.length) {
            setTimeout(() => {
              setCurrentSegIdx(nextIdx);
              playSegment(nextIdx);
            }, 800);
          } else {
            // Session completed
            setUxState("session_completed");
            void saveProgress(
              videoId,
              nextIdx,
              selectAccuracy(useSessionStore.getState()),
              useSessionStore.getState().totalAttempts,
              useSessionStore.getState().sessionId ?? undefined,
              transcriptId,
              "completed"
            );
          }

          // Save progress periodically
          const state = useSessionStore.getState();
          saveProgress(
            videoId,
            nextIdx,
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
          setUxState("paused_waiting_input");
        }
      } catch {
        setUxState("paused_waiting_input");
      }
    },
    [currentSegIdx, segments, sessionStore, videoId, transcriptId, wrongAttempts]
  );

  // ---- Replay current segment ----
  const handleReplay = useCallback(() => {
    playSegment(currentSegIdx);
    setUxState("playing");
    setCheckResult(null);
  }, [currentSegIdx]);

  // ---- Skip current segment ----
  const handleSkip = useCallback(() => {
    const nextIdx = currentSegIdx + 1;
    if (nextIdx < segments.length) {
      setCurrentSegIdx(nextIdx);
      playSegment(nextIdx);
      setCheckResult(null);
      setWrongAttempts(0);
      setHintLevel(0);
      setShowAI(false);
      setUxState("playing");
    }
  }, [currentSegIdx, segments.length]);

  // ---- Play segment helper ----
  function playSegment(segIdx: number) {
    ytPlayerRef.current?.playSegment(segIdx);
  }

  // ---- Keyboard shortcuts ----
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "r" || e.key === "R") handleReplay();
      if (e.key === "s" || e.key === "S") handleSkip();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [handleReplay, handleSkip]);

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
                onClick={handleReplay}
                className="flex-1 py-2 rounded-xl border border-slate-300 text-sm font-medium hover:bg-slate-50 transition-colors"
                title="Replay (R)"
              >
                🔁 Replay (R)
              </button>
              <button
                onClick={handleSkip}
                className="flex-1 py-2 rounded-xl border border-slate-300 text-sm font-medium hover:bg-slate-50 transition-colors"
                title="Skip (S)"
              >
                ⏭ Skip (S)
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
            <StatusCard
              icon="❌"
              title="Transcript failed"
              description="Could not generate a transcript for this video. Try a different video."
              error
            />
          )}

          {uxState === "transcript_ready" && segments.length > 0 && (
            <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-4 flex flex-col gap-3">
              <p className="text-emerald-700 font-semibold">
                ✅ Transcript ready — {segments.length} sentences
              </p>
              <p className="text-sm text-slate-600">
                Press play on the video to start the first sentence.
              </p>
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
                isEnabled={uxState === "paused_waiting_input"}
                matchMode={sessionStore.matchMode}
                onMatchModeChange={(m) => sessionStore.setMatchMode(m)}
                onSubmit={handleAnswerSubmit}
                diff={checkResult?.diff}
                isCorrect={checkResult?.isCorrect ?? null}
                errorMessage={
                  checkResult && !checkResult.isCorrect
                    ? `Error type: ${checkResult.errorType}`
                    : null
                }
                wrongAttempts={wrongAttempts}
              />

              {/* Correct feedback */}
              {checkResult?.isCorrect && (
                <p className="text-emerald-600 font-semibold text-center">
                  ✅ Correct! Moving to next sentence…
                </p>
              )}

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
