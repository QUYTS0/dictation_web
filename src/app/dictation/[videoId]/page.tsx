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
import UserButton from "@/components/UserButton";
import VocabularySaveButton from "@/components/VocabularySaveButton";

import { usePlayerStore } from "@/store/playerStore";
import { useSessionStore, selectAccuracy } from "@/store/sessionStore";
import { normalizeText } from "@/lib/utils/text";
import { useAuth, useRequireAuth } from "@/context/auth";
import type {
  TranscriptResponse,
  TranscriptSegment,
  CheckAnswerResponse,
  MatchMode,
  HintLevel,
  UXState,
  DiffToken,
  ResumeSessionResponse,
  VocabularyItem,
} from "@/lib/types";

// ---- Inline types ----

interface MistakeRecord {
  segIdx: number;
  expectedText: string;
  userText: string;
  diff: DiffToken[];
}

type LessonItemType = "word" | "phrase" | "sentence";
type SavedFilter = "all" | LessonItemType;
type RightPanelTab = "saved" | "script";

type LessonSavedItem = VocabularyItem & { type: LessonItemType };

function getSelectedType(wordCount: number): LessonItemType | null {
  if (wordCount <= 0) return null;
  if (wordCount === 1) return "word";
  return "phrase";
}

function getSavedFilterLabel(filter: SavedFilter) {
  if (filter === "all") return "All";
  if (filter === "word") return "Words";
  if (filter === "phrase") return "Phrases";
  return "Sentences";
}

function splitSentenceIntoWords(sentence: string) {
  return sentence.trim().split(/\s+/).filter(Boolean);
}

function normalizeRange(start: number, end: number, maxLength: number) {
  const normalizedStart = Math.max(0, Math.min(start, end));
  const normalizedEnd = Math.min(maxLength - 1, Math.max(start, end));
  return { start: normalizedStart, end: normalizedEnd };
}

function areSelectionsEqual(
  prev: { segmentIndex: number; start: number; end: number } | null,
  next: { segmentIndex: number; start: number; end: number }
) {
  return (
    !!prev &&
    prev.segmentIndex === next.segmentIndex &&
    prev.start === next.start &&
    prev.end === next.end
  );
}

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
  videoCurrentTimeSec: number,
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
      videoCurrentTimeSec,
      accuracy,
      totalAttempts,
      status,
    }),
  });
  if (!res.ok) throw new Error("Failed to save progress");
  return res.json();
}

async function fetchResumeSession(videoId: string): Promise<ResumeSessionResponse> {
  const res = await fetch(`/api/session/resume?videoId=${encodeURIComponent(videoId)}`);
  if (!res.ok) throw new Error("Failed to fetch resume session");
  return res.json();
}

async function restartSession(videoId: string, sessionId?: string): Promise<void> {
  const res = await fetch("/api/session/restart", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videoId, sessionId }),
  });
  if (!res.ok) throw new Error("Failed to restart session");
}

// ---- Page component ----

interface PageProps {
  params: Promise<{ videoId: string }>;
}

interface ResumeState {
  sessionId: string;
  currentSegmentIndex: number;
  videoCurrentTimeSec: number;
}

// Let the embedded player seek after the segment playback command settles.
const RESUME_SEEK_DELAY_MS = 150;

function buildAiExplainPayload({
  selectedType,
  selectedText,
  sentenceText,
  userText,
}: {
  selectedType: LessonItemType | null;
  selectedText: string;
  sentenceText: string;
  userText: string;
}) {
  if (selectedType && selectedText) {
    return {
      buttonLabel: `Explain selected ${selectedType}`,
      expectedText: `Explain this ${selectedType} from a dictation lesson: "${selectedText}". Source sentence: "${sentenceText}"`,
      userText: selectedText,
    };
  }

  return {
    buttonLabel: "Explain this sentence",
    expectedText: sentenceText,
    userText,
  };
}

export default function DictationPage({ params }: PageProps) {
  const { videoId } = use(params);
  const { user } = useAuth();
  const requireAuth = useRequireAuth();

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
  // In-memory mistake tracking for the session-review panel at completion
  const [mistakes, setMistakes] = useState<MistakeRecord[]>([]);
  const [resumeState, setResumeState] = useState<ResumeState | null>(null);
  const [resumeLoading, setResumeLoading] = useState(false);
  const [inputFocusSignal, setInputFocusSignal] = useState(0);
  const [selectionRange, setSelectionRange] = useState<{ start: number; end: number } | null>(null);
  const [learningItems, setLearningItems] = useState<LessonSavedItem[]>([]);
  const [learningNote, setLearningNote] = useState("");
  const [learningError, setLearningError] = useState<string | null>(null);
  const [learningSaving, setLearningSaving] = useState(false);
  const [showLearningPanel, setShowLearningPanel] = useState(true);
  const [rightPanelTab, setRightPanelTab] = useState<RightPanelTab>("saved");
  const [savedFilter, setSavedFilter] = useState<SavedFilter>("all");
  const [scriptSelection, setScriptSelection] = useState<{
    segmentIndex: number;
    start: number;
    end: number;
  } | null>(null);
  const [scriptSelectionAnchor, setScriptSelectionAnchor] = useState<{
    segmentIndex: number;
    index: number;
  } | null>(null);
  const [showVideo, setShowVideo] = useState(true);
  const [aiExplanationReady, setAiExplanationReady] = useState(false);

  const ytPlayerRef = useRef<YouTubePlayerHandle>(null);
  const learningNoteInputRef = useRef<HTMLInputElement>(null);
  // Tracks whether the user manually triggered a replay while already paused
  // (keyboard shortcut / Replay button while input is visible). In this case we keep the
  // input and its typed words intact when the segment ends.
  const isManualReplayWhilePaused = useRef(false);
  // Ref mirror of currentSegIdx — lets handleSegmentEnd guard against stale
  // callbacks that fire after the user has already submitted early and advanced.
  const currentSegIdxRef = useRef(0);
  const resumeLoadedRef = useRef(false);

  useEffect(() => {
    resumeLoadedRef.current = false;
    setResumeState(null);
  }, [videoId, user?.id]);

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
    // Guard: if the user already submitted early and advanced past this segment,
    // ignore the stale callback from the player's time-polling tick.
    if (segIdx < currentSegIdxRef.current) return;

    // Manual replay triggered while input was already visible — keep everything
    // intact so the user's typed words are preserved.
    if (isManualReplayWhilePaused.current) {
      isManualReplayWhilePaused.current = false;
      return;
    }

    // Normal flow: segment ended while practicing — show the dictation input.
    setCurrentSegIdx(segIdx);
    currentSegIdxRef.current = segIdx;
    setCheckResult(null);
    setWrongAttempts(0);
    setHintLevel(0);
    setShowAI(false);
    setUxState("paused_waiting_input");
  }, []);

  const triggerAutoSave = useCallback(
    (segmentIndex: number, status: "active" | "completed" | "abandoned" = "active") => {
      if (!user) return;
      const state = useSessionStore.getState();
      void saveProgress(
        videoId,
        segmentIndex,
        playerStore.currentTimeSec,
        selectAccuracy(state),
        state.totalAttempts,
        state.sessionId ?? undefined,
        transcriptId,
        status
      )
        .then((r) => {
          if (!state.sessionId) sessionStore.setSessionId(r.sessionId);
        })
        .catch(() => {
          if (state.sessionId) sessionStore.setSessionId(null);
        });
    },
    [playerStore.currentTimeSec, sessionStore, transcriptId, user, videoId]
  );

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
          setCheckResult(null);
          setShowAI(false);

          const nextIdx = currentSegIdx + 1;
          triggerAutoSave(nextIdx, "active");

          if (nextIdx < segments.length) {
            currentSegIdxRef.current = nextIdx;
            setCurrentSegIdx(nextIdx);
            setUxState("playing");
            ytPlayerRef.current?.playSegment(nextIdx);
          } else {
            setUxState("session_completed");
            triggerAutoSave(nextIdx, "completed");
          }
        } else {
          const newWrong = wrongAttempts + 1;
          setWrongAttempts(newWrong);
          if (newWrong >= 3) setShowAI(true);
          // Record first mistake for this segment (deduplicated by segIdx)
          const segText = segments[currentSegIdx].text;
          setMistakes((prev) =>
            prev.some((m) => m.segIdx === currentSegIdx)
              ? prev
              : [
                  ...prev,
                  {
                    segIdx: currentSegIdx,
                    expectedText: segText,
                    userText: result.normalizedUser || userText,
                    diff: result.diff ?? [],
                  },
                ]
          );
          // Pause video when the user submits incorrectly during playback
          ytPlayerRef.current?.pauseVideo();
          setDictationKey((k) => k + 1); // remount DictationInput so state resets cleanly
          setUxState("paused_waiting_input");
        }
      } catch {
        setUxState("paused_waiting_input");
      }
    },
    [currentSegIdx, segments, sessionStore, triggerAutoSave, wrongAttempts]
  );

  // ---- Start session (seek to segment 0 and play) ----
  const handleStart = useCallback(() => {
    triggerAutoSave(0, "active");
    setUxState("playing");
    ytPlayerRef.current?.playSegment(0);
  }, [triggerAutoSave]);

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
      currentSegIdxRef.current = nextIdx;
      setCurrentSegIdx(nextIdx);
      ytPlayerRef.current?.playSegment(nextIdx);
      setCheckResult(null);
      setWrongAttempts(0);
      setHintLevel(0);
      setShowAI(false);
      setUxState("playing");
      triggerAutoSave(nextIdx, "active");
    }
  }, [currentSegIdx, segments.length, triggerAutoSave]);

  // ---- Go to previous segment ----
  const handlePrevious = useCallback(() => {
    const prevIdx = currentSegIdx - 1;
    if (prevIdx >= 0) {
      currentSegIdxRef.current = prevIdx;
      setCurrentSegIdx(prevIdx);
      ytPlayerRef.current?.playSegment(prevIdx);
      setCheckResult(null);
      setWrongAttempts(0);
      setHintLevel(0);
      setShowAI(false);
      setUxState("playing");
      triggerAutoSave(prevIdx, "active");
    }
  }, [currentSegIdx, triggerAutoSave]);

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
      const target = e.target;
      const isTypingTarget =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable);

      if (!isTypingTarget && e.key === "/") {
        e.preventDefault();
        setInputFocusSignal((v) => v + 1);
        return;
      }

      if (isTypingTarget) return;

      if (e.shiftKey && e.code === "Space") {
        e.preventDefault();
        handleReplay();
      }

      if (e.ctrlKey && e.key === "ArrowLeft") {
        e.preventDefault();
        handlePrevious();
      }

      if (e.ctrlKey && e.key === "ArrowRight") {
        e.preventDefault();
        handleSkip();
      }
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

  // ---- Load resumable session for authenticated users ----
  useEffect(() => {
    if (!user || transcriptStatus !== "ready" || resumeLoadedRef.current) return;
    setResumeLoading(true);
    fetchResumeSession(videoId)
      .then((data) => {
        if (data.session) {
          setResumeState({
            sessionId: data.session.sessionId,
            currentSegmentIndex: data.session.currentSegmentIndex,
            videoCurrentTimeSec: data.session.videoCurrentTimeSec,
          });
        }
      })
      .catch(() => {})
      .finally(() => {
        resumeLoadedRef.current = true;
        setResumeLoading(false);
      });
  }, [transcriptStatus, user, videoId]);

  // ---- Autosave when tab is hidden / page is being closed ----
  useEffect(() => {
    if (!user) return;
    const persist = () => triggerAutoSave(currentSegIdxRef.current, "active");
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") persist();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", persist);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", persist);
    };
  }, [triggerAutoSave, user]);

  const handleResume = useCallback(() => {
    if (!resumeState || segments.length === 0) return;
    const segIdx = Math.min(Math.max(resumeState.currentSegmentIndex, 0), segments.length - 1);
    sessionStore.setSessionId(resumeState.sessionId);
    currentSegIdxRef.current = segIdx;
    setCurrentSegIdx(segIdx);
    setResumeState(null);
    setUxState("playing");
    ytPlayerRef.current?.playSegment(segIdx);
    const resumeTimeSec = resumeState.videoCurrentTimeSec;
    if (resumeTimeSec > 0) {
      window.setTimeout(() => {
        ytPlayerRef.current?.seekTo(resumeTimeSec, true);
      }, RESUME_SEEK_DELAY_MS);
    }
  }, [resumeState, segments.length, sessionStore]);

  const handleRestart = useCallback(() => {
    if (!user) return;
    void restartSession(videoId, resumeState?.sessionId)
      .then(() => {
        setResumeState(null);
        sessionStore.setSessionId(null);
      })
      .catch(() => {});
  }, [resumeState?.sessionId, sessionStore, user, videoId]);

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

  // Derived flag: show dictation input during playback and while paused/checking
  const shouldShowInput =
    (uxState === "paused_waiting_input" ||
      uxState === "checking_answer" ||
      uxState === "playing") &&
    !!currentSegment;

  const currentSentenceWords = useMemo(
    () => (currentSegment ? splitSentenceIntoWords(currentSegment.text) : []),
    [currentSegment]
  );

  const normalizedSelection = useMemo(() => {
    if (!selectionRange || currentSentenceWords.length === 0) return null;
    const start = Math.max(0, Math.min(selectionRange.start, selectionRange.end));
    const end = Math.min(currentSentenceWords.length - 1, Math.max(selectionRange.start, selectionRange.end));
    return { start, end };
  }, [currentSentenceWords.length, selectionRange]);

  const selectedWords = useMemo(() => {
    if (!normalizedSelection) return [];
    return currentSentenceWords.slice(normalizedSelection.start, normalizedSelection.end + 1);
  }, [currentSentenceWords, normalizedSelection]);

  const selectedText = selectedWords.join(" ");
  const selectedType = getSelectedType(selectedWords.length);

  const lessonSavedInCurrentVideo = useMemo(
    () => learningItems.filter((item) => item.video_id === videoId),
    [learningItems, videoId]
  );
  const filteredSavedItems = useMemo(() => {
    if (savedFilter === "all") return lessonSavedInCurrentVideo;
    return lessonSavedInCurrentVideo.filter((item) => item.type === savedFilter);
  }, [lessonSavedInCurrentVideo, savedFilter]);
  const scriptWordsBySegment = useMemo(
    () => segments.map((segment) => splitSentenceIntoWords(segment.text)),
    [segments]
  );
  const scriptSelectionSegmentIndex = scriptSelection?.segmentIndex ?? null;
  const scriptSelectionStart = scriptSelection?.start ?? null;
  const scriptSelectionEnd = scriptSelection?.end ?? null;
  const scriptSelectedWords = useMemo(() => {
    if (
      scriptSelectionSegmentIndex === null ||
      scriptSelectionStart === null ||
      scriptSelectionEnd === null
    ) {
      return [];
    }
    const words = scriptWordsBySegment[scriptSelectionSegmentIndex] ?? [];
    if (words.length === 0) return [];
    const { start, end } = normalizeRange(scriptSelectionStart, scriptSelectionEnd, words.length);
    return words.slice(start, end + 1);
  }, [scriptSelectionEnd, scriptSelectionSegmentIndex, scriptSelectionStart, scriptWordsBySegment]);
  const scriptSelectedText = scriptSelectedWords.join(" ");
  const scriptSelectedType = getSelectedType(scriptSelectedWords.length);
  const scriptSelectedSegment = scriptSelection
    ? segments[scriptSelection.segmentIndex] ?? null
    : null;

  const aiExplainPayload = buildAiExplainPayload({
    selectedType,
    selectedText,
    sentenceText: currentSegment?.text ?? "",
    userText: checkResult?.normalizedUser || currentSegment?.text || "",
  });
  const shouldShowAiExplainButton =
    !showAI &&
    !!checkResult &&
    (selectedType !== null || (wrongAttempts > 0 && !checkResult.isCorrect));
  const shouldShowPostCheckReview =
    !!checkResult && (uxState === "paused_waiting_input" || uxState === "checking_answer");
  const shouldRenderVideoPlayer =
    uxState !== "loading_transcript" &&
    uxState !== "transcript_processing" &&
    uxState !== "transcript_failed";
  const videoBlock = !showVideo ? (
    <div className="aspect-video rounded-xl border border-slate-200 bg-slate-50 flex items-center justify-center text-sm text-slate-500">
      Video hidden - use “Show video” to display it again.
    </div>
  ) : (
    shouldRenderVideoPlayer && (
      <YouTubePlayer
        ref={ytPlayerRef}
        videoId={videoId}
        segments={segments}
        onSegmentEnd={handleSegmentEnd}
      />
    )
  );

  const toggleSelection = useCallback(
    (idx: number) => {
      setSelectionRange((prev) => {
        // 1) no selection -> start with one selected token
        if (!prev) return { start: idx, end: idx };
        // 2) same token clicked again while single-select -> clear selection
        if (prev.start === prev.end) {
          if (prev.start === idx) return null;
          // 3) different token clicked while single-select -> create a contiguous range
          return { start: prev.start, end: idx };
        }
        // 4) when a range already exists -> reset to new single-select anchor
        return { start: idx, end: idx };
      });
    },
    []
  );

  const saveLessonCaptureAtSegment = useCallback(
    (text: string, type: LessonItemType, segmentIndex: number, sentenceContext: string) => {
      const trimmedText = text.trim();
      if (!trimmedText) return;

      const saveNote = learningNote.trim();
      requireAuth(() => {
        setLearningSaving(true);
        setLearningError(null);
        void fetch("/api/vocabulary", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            videoId,
            segmentIndex,
            term: trimmedText,
            sentenceContext,
            note: saveNote || undefined,
          }),
        })
          .then(async (res) => {
            if (!res.ok) throw new Error("Failed to save vocabulary item");
            const data = (await res.json()) as { item: VocabularyItem };
            const item: LessonSavedItem = {
              ...data.item,
              type,
              note: data.item.note ?? "",
            };
            setLearningItems((prev) => {
              // API can return an existing row (upsert-like behavior), so we update in place.
              // New items are prepended so the latest additions stay easy to scan.
              const existingIndex = prev.findIndex((existing) => existing.id === item.id);
              if (existingIndex === -1) return [item, ...prev];
              const next = [...prev];
              next[existingIndex] = item;
              return next;
            });
            setLearningNote("");
            setShowLearningPanel(true);
            if (type !== "sentence") {
              setSelectionRange(null);
              setScriptSelection(null);
              setScriptSelectionAnchor(null);
            }
          })
          .catch((err: unknown) => {
            const message =
              err instanceof Error && err.message
                ? err.message
                : "Failed to save learning item. Please try again.";
            setLearningError(message);
          })
          .finally(() => {
            setLearningSaving(false);
          });
      });
    },
    [learningNote, requireAuth, videoId]
  );

  const saveLessonCapture = useCallback(
    (text: string, type: LessonItemType) => {
      if (!currentSegment) return;
      saveLessonCaptureAtSegment(text, type, currentSegIdx, currentSegment.text);
    },
    [currentSegIdx, currentSegment, saveLessonCaptureAtSegment]
  );

  const handleScriptWordClick = useCallback(
    (segmentIndex: number, wordIndex: number, word: string, shiftKey: boolean) => {
      const sentence = segments[segmentIndex];
      if (!sentence) return;

      if (!shiftKey) {
        setScriptSelectionAnchor({ segmentIndex, index: wordIndex });
        setScriptSelection(null);
        saveLessonCaptureAtSegment(word, "word", sentence.segmentIndex, sentence.text);
        return;
      }

      setScriptSelection((prev) => {
        if (!scriptSelectionAnchor || scriptSelectionAnchor.segmentIndex !== segmentIndex) {
          setScriptSelectionAnchor({ segmentIndex, index: wordIndex });
          return { segmentIndex, start: wordIndex, end: wordIndex };
        }
        const next = {
          segmentIndex,
          start: scriptSelectionAnchor.index,
          end: wordIndex,
        };
        if (areSelectionsEqual(prev, next)) {
          return null;
        }
        return next;
      });
    },
    [saveLessonCaptureAtSegment, scriptSelectionAnchor, segments]
  );

  const handleSaveScriptSelection = useCallback(() => {
    if (
      !scriptSelection ||
      !scriptSelectedText ||
      !scriptSelectedType ||
      scriptSelectedType !== "phrase" ||
      !scriptSelectedSegment
    ) {
      return;
    }
    saveLessonCaptureAtSegment(
      scriptSelectedText,
      scriptSelectedType,
      scriptSelectedSegment.segmentIndex,
      scriptSelectedSegment.text
    );
  }, [
    saveLessonCaptureAtSegment,
    scriptSelectedSegment,
    scriptSelectedText,
    scriptSelectedType,
    scriptSelection,
  ]);

  useEffect(() => {
    setSelectionRange(null);
    setLearningNote("");
  }, [currentSegIdx, currentSegment?.text]);

  useEffect(() => {
    setScriptSelection(null);
    setScriptSelectionAnchor(null);
  }, [videoId]);

  useEffect(() => {
    if (!showAI) setAiExplanationReady(false);
  }, [showAI]);

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
        <span className="text-xs text-slate-400 font-mono hidden sm:block">{videoId}</span>
        <UserButton />
      </header>

      <main
        className={clsx(
          "flex-1 flex flex-col lg:flex-row gap-6 p-4 lg:p-6 max-w-7xl mx-auto w-full transition-all duration-300",
          !showLearningPanel && "lg:justify-center"
        )}
      >
        {/* Primary lesson column */}
        <div
          className={clsx(
            "flex flex-col gap-4 transition-all duration-300",
            showLearningPanel ? "lg:w-2/3" : "lg:w-3/4 xl:w-2/3"
          )}
        >
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-slate-700">Video</p>
            <button
              onClick={() => setShowVideo((v) => !v)}
              className="text-xs px-3 py-1.5 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50"
            >
              {showVideo ? "Hide video" : "Show video"}
            </button>
          </div>

          {/* YouTube Player */}
          <div className="w-full">
            {videoBlock}
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
                title="Previous sentence (Ctrl+←)"
              >
                ⏮ Prev (Ctrl+←)
              </button>
              <button
                onClick={handleReplay}
                className="flex-1 py-2 rounded-xl border border-slate-300 text-sm font-medium hover:bg-slate-50 transition-colors"
                title="Replay (Shift+Space)"
              >
                🔁 Replay (Shift+Space)
              </button>
              <button
                onClick={handleSkip}
                disabled={currentSegIdx >= segments.length - 1}
                className="flex-1 py-2 rounded-xl border border-slate-300 text-sm font-medium hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                title="Next sentence (Ctrl+→)"
              >
                ⏭ Next (Ctrl+→)
              </button>
            </div>
          )}

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
                {resumeState ? (
                  <>
                    <button
                      onClick={handleResume}
                      className="px-6 py-2 rounded-xl bg-indigo-600 text-white font-semibold text-sm hover:bg-indigo-700 transition-colors"
                    >
                      ▶ Resume at sentence {resumeState.currentSegmentIndex + 1}
                    </button>
                    <button
                      onClick={handleRestart}
                      className="px-4 py-2 rounded-xl border border-slate-300 text-slate-700 font-semibold text-sm hover:bg-slate-50 transition-colors"
                    >
                      Restart
                    </button>
                  </>
                ) : (
                  <button
                    onClick={handleStart}
                    className="px-6 py-2 rounded-xl bg-indigo-600 text-white font-semibold text-sm hover:bg-indigo-700 transition-colors"
                  >
                    ▶ Start Dictation
                  </button>
                )}
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
              {resumeLoading && (
                <p className="text-xs text-slate-500">Checking for saved progress…</p>
              )}
            </div>
          )}

          {uxState === "session_completed" && (
            <div className="rounded-xl border border-indigo-300 bg-indigo-50 p-6 flex flex-col gap-4">
              <div className="text-center">
                <p className="text-3xl">🎉</p>
                <p className="text-indigo-700 font-bold text-xl">Session Complete!</p>
                <p className="text-slate-600 text-sm mt-1">
                  Final accuracy: <span className="font-bold">{accuracy}%</span> over{" "}
                  {sessionStore.totalAttempts} attempts.
                </p>
              </div>

              {/* Mistakes review */}
              {mistakes.length > 0 ? (
                <div className="flex flex-col gap-2">
                  <p className="text-slate-700 font-semibold text-sm">
                    Mistakes ({mistakes.length} sentence{mistakes.length !== 1 ? "s" : ""}):
                  </p>
                  <div className="flex flex-col gap-2 max-h-72 overflow-y-auto pr-1">
                    {mistakes.map((m) => (
                      <div
                        key={m.segIdx}
                        className="bg-white rounded-lg border border-slate-200 p-3 flex flex-col gap-1"
                      >
                        <span className="text-xs text-slate-400 font-medium">
                          Sentence {m.segIdx + 1}
                        </span>
                        <span className="text-sm text-slate-800">{m.expectedText}</span>
                        <span className="text-xs text-red-500">
                          You typed:{" "}
                          {m.userText || <span className="italic text-slate-400">nothing</span>}
                        </span>
                        <VocabularySaveButton
                          videoId={videoId}
                          segmentIndex={m.segIdx}
                          sentenceContext={m.expectedText}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="text-emerald-600 text-sm font-medium text-center">
                  🏆 Perfect session — no mistakes!
                </p>
              )}

              <Link
                href="/"
                className="mt-2 inline-block rounded-xl bg-indigo-600 text-white px-6 py-2 font-semibold hover:bg-indigo-700 transition-colors text-center"
              >
                Try another video
              </Link>
            </div>
          )}

          {/* Dictation input area — below video and controls */}
          {shouldShowInput && (
            <div className="flex flex-col gap-4">
              <div className="rounded-xl bg-white border border-slate-200 p-3 text-sm text-slate-400 flex items-center justify-between">
                <span>Sentence {currentSegIdx + 1} of {segments.length}</span>
                {uxState === "playing" && (
                  <span className="text-xs text-emerald-600 font-medium animate-pulse">
                    ▶ Playing…
                  </span>
                )}
              </div>

              <DictationInput
                key={`${currentSegIdx}-${dictationKey}`}
                isEnabled={uxState === "paused_waiting_input" || uxState === "playing"}
                wordCount={wordCount}
                onSubmit={handleAnswerSubmit}
                diff={checkResult?.diff}
                isCorrect={checkResult?.isCorrect ?? null}
                wrongAttempts={wrongAttempts}
                focusSignal={inputFocusSignal}
              />

              {/* Review current sentence only after user has checked/submitted */}
              {shouldShowPostCheckReview && currentSegment && (
                <div className="rounded-xl border border-slate-200 bg-white p-3 flex flex-col gap-3">
                  <p className="text-sm font-semibold text-slate-700">
                    Review current sentence
                  </p>
                  <SentenceTokenSelector
                    words={currentSentenceWords}
                    selection={normalizedSelection}
                    onToggleSelection={toggleSelection}
                    onSaveWord={(word) => saveLessonCapture(word, "word")}
                  />
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => selectedText && selectedType && saveLessonCapture(selectedText, selectedType)}
                      disabled={learningSaving || !selectedText || !selectedType}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold border border-indigo-300 text-indigo-700 bg-indigo-50 hover:bg-indigo-100 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Save {selectedType ?? "selection"}
                    </button>
                    <button
                      onClick={() => currentSegment && saveLessonCapture(currentSegment.text, "sentence")}
                      disabled={learningSaving || !currentSegment}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold border border-slate-300 text-slate-700 bg-slate-50 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Save full sentence
                    </button>
                    {normalizedSelection && (
                      <button
                        onClick={() => setSelectionRange(null)}
                        className="px-3 py-1.5 rounded-lg text-xs font-semibold border border-slate-300 text-slate-600 hover:bg-slate-50"
                      >
                        Clear selection
                      </button>
                    )}
                  </div>

                  <input
                    ref={learningNoteInputRef}
                    value={learningNote}
                    onChange={(e) => setLearningNote(e.target.value)}
                    placeholder="Optional note for your next saved item"
                    className="rounded-lg border border-slate-300 px-3 py-2 text-xs focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 outline-none"
                  />

                  {selectedText && (
                    <p className="text-xs text-slate-600">
                      Selected {selectedType}: <span className="font-medium text-slate-800">{selectedText}</span>
                    </p>
                  )}

                  {learningError && (
                    <p className="text-xs text-red-600">{learningError}</p>
                  )}
                </div>
              )}

              {/* Hint — only relevant when paused */}
              {(uxState === "paused_waiting_input" || uxState === "checking_answer") &&
                !checkResult?.isCorrect && (
                  <HintDisplay
                    text={currentSegment.text}
                    level={hintLevel}
                    onLevelChange={(l) => setHintLevel(l)}
                  />
                )}

              {/* AI Tutor — available in review state */}
              {shouldShowPostCheckReview && showAI && currentSegment && (
                <AIExplainer
                  expectedText={aiExplainPayload.expectedText}
                  userText={aiExplainPayload.userText}
                  buttonLabel={aiExplainPayload.buttonLabel}
                  onExplanationReady={setAiExplanationReady}
                />
              )}

              {shouldShowPostCheckReview && showAI && currentSegment && aiExplanationReady && (
                <div className="flex flex-wrap gap-2">
                  {selectedText && selectedType && (
                    <button
                      onClick={() => saveLessonCapture(selectedText, selectedType)}
                      disabled={!selectedType}
                      className="text-xs px-3 py-1 rounded-full border border-indigo-300 text-indigo-700 bg-indigo-50 hover:bg-indigo-100"
                    >
                      Save {selectedType}
                    </button>
                  )}
                  <button
                    onClick={() => currentSegment && saveLessonCapture(currentSegment.text, "sentence")}
                    className="text-xs px-3 py-1 rounded-full border border-slate-300 text-slate-700 bg-slate-50 hover:bg-slate-100"
                  >
                    Save sentence
                  </button>
                  <button
                    onClick={() => learningNoteInputRef.current?.focus()}
                    className="text-xs px-3 py-1 rounded-full border border-slate-300 text-slate-700 hover:bg-slate-50"
                  >
                    Add note
                  </button>
                </div>
              )}

              {shouldShowPostCheckReview && shouldShowAiExplainButton && (
                <button
                  onClick={() => setShowAI(true)}
                  className="text-xs text-violet-600 underline self-end hover:text-violet-800"
                >
                  Ask AI to explain {selectedType ? `this ${selectedType}` : "this sentence"}
                </button>
              )}
            </div>
          )}
        </div>

        {/* Secondary right panel */}
        <aside
          className={clsx(
            "transition-all duration-300",
            showLearningPanel ? "lg:w-1/3" : "lg:w-14"
          )}
        >
          <div
            className={clsx(
              "rounded-xl border border-slate-200 bg-white lg:sticky lg:top-4 transition-all duration-300",
              showLearningPanel ? "p-4" : "p-2"
            )}
          >
            <div className="flex items-center justify-between">
              {showLearningPanel ? (
                <p className="text-sm font-semibold text-slate-700">Lesson panel</p>
              ) : (
                <span className="sr-only">Lesson panel collapsed. Press button to expand.</span>
              )}
              <button
                onClick={() => setShowLearningPanel((v) => !v)}
                className="h-8 w-8 shrink-0 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 transition-colors"
                aria-label={showLearningPanel ? "Collapse right panel" : "Expand right panel"}
                title={showLearningPanel ? "Collapse right panel" : "Expand right panel"}
              >
                <svg
                  viewBox="0 0 20 20"
                  fill="none"
                  aria-hidden="true"
                  className={clsx("h-4 w-4 mx-auto transition-transform", !showLearningPanel && "rotate-180")}
                >
                  <path d="M12.5 4.5L7.5 10l5 5.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>

            {showLearningPanel && (
              <div className="mt-3 flex flex-col gap-3">
                <div className="rounded-lg bg-slate-100 p-1 grid grid-cols-2 gap-1">
                  <button
                    onClick={() => setRightPanelTab("saved")}
                    className={clsx(
                      "rounded-md px-3 py-1.5 text-xs font-semibold transition-colors",
                      rightPanelTab === "saved"
                        ? "bg-white text-slate-800 shadow-sm"
                        : "text-slate-500 hover:text-slate-700"
                    )}
                  >
                    Saved
                  </button>
                  <button
                    onClick={() => setRightPanelTab("script")}
                    className={clsx(
                      "rounded-md px-3 py-1.5 text-xs font-semibold transition-colors",
                      rightPanelTab === "script"
                        ? "bg-white text-slate-800 shadow-sm"
                        : "text-slate-500 hover:text-slate-700"
                    )}
                  >
                    Script
                  </button>
                </div>

                {rightPanelTab === "saved" ? (
                  <div className="flex flex-col gap-3">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-semibold text-slate-700">
                        Saved items ({lessonSavedInCurrentVideo.length})
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {(["all", "word", "phrase", "sentence"] as SavedFilter[]).map((filter) => (
                        <button
                          key={filter}
                          onClick={() => setSavedFilter(filter)}
                          className={clsx(
                            "px-2.5 py-1 rounded-full text-[11px] font-semibold border transition-colors",
                            savedFilter === filter
                              ? "border-indigo-300 bg-indigo-50 text-indigo-700"
                              : "border-slate-300 text-slate-600 hover:bg-slate-50"
                          )}
                        >
                          {getSavedFilterLabel(filter)}
                        </button>
                      ))}
                    </div>
                    {filteredSavedItems.length === 0 ? (
                      <p className="text-xs text-slate-500">
                        {savedFilter === "all"
                          ? "No saved items yet."
                          : `No ${getSavedFilterLabel(savedFilter).toLowerCase()} saved yet.`}
                      </p>
                    ) : (
                      <LessonSavedItemsList items={filteredSavedItems} compact />
                    )}
                  </div>
                ) : (
                  <div className="flex flex-col gap-3">
                    <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                      Viewing the script may reveal answers.
                    </div>
                    <p className="text-[11px] text-slate-500">
                      Click a word to save it instantly. Shift+click words in the same sentence to select and save a phrase.
                    </p>

                    {segments.length === 0 ? (
                      <p className="text-xs text-slate-500">Script is not available yet.</p>
                    ) : (
                      <div className="max-h-[60vh] overflow-y-auto pr-1 flex flex-col gap-3">
                        {segments.map((segment, segIdx) => {
                          const words = scriptWordsBySegment[segIdx] ?? [];
                          const hasSelection = scriptSelection?.segmentIndex === segIdx;
                          const normalizedScriptRange = hasSelection
                            ? normalizeRange(scriptSelection.start, scriptSelection.end, words.length)
                            : null;
                          const selectedStart = normalizedScriptRange?.start ?? -1;
                          const selectedEnd = normalizedScriptRange?.end ?? -1;
                          return (
                            <div key={segment.segmentIndex} className="rounded-lg border border-slate-200 p-3 bg-slate-50">
                              <div className="flex items-center justify-between gap-2 mb-2">
                                <p className="text-xs font-semibold text-slate-600">
                                  Sentence {segment.segmentIndex + 1}
                                </p>
                                <button
                                  onClick={() =>
                                    saveLessonCaptureAtSegment(
                                      segment.text,
                                      "sentence",
                                      segment.segmentIndex,
                                      segment.text
                                    )
                                  }
                                  disabled={learningSaving}
                                  className="text-[11px] px-2 py-1 rounded-md border border-slate-300 text-slate-700 hover:bg-white disabled:opacity-40"
                                >
                                  Save sentence
                                </button>
                              </div>
                              <div className="flex flex-wrap gap-1.5">
                                {words.map((word, wordIdx) => {
                                  const selected = hasSelection && wordIdx >= selectedStart && wordIdx <= selectedEnd;
                                  return (
                                    <button
                                      key={`${segment.segmentIndex}-${wordIdx}`}
                                      onClick={(e) => handleScriptWordClick(segIdx, wordIdx, word, e.shiftKey)}
                                      className={clsx(
                                        "rounded-full border px-2 py-1 text-[11px] transition-colors",
                                        selected
                                          ? "border-indigo-300 bg-indigo-50 text-indigo-700"
                                          : "border-slate-300 bg-white text-slate-700 hover:border-indigo-300 hover:bg-indigo-50"
                                      )}
                                    >
                                      {word}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    <div className="rounded-lg border border-slate-200 bg-white p-3 flex flex-col gap-2">
                      <div className="flex flex-wrap gap-2">
                        <button
                          onClick={handleSaveScriptSelection}
                          disabled={
                            learningSaving ||
                            !scriptSelection ||
                            !scriptSelectedText ||
                            !scriptSelectedSegment ||
                            scriptSelectedType !== "phrase"
                          }
                          className="px-3 py-1.5 rounded-lg text-xs font-semibold border border-indigo-300 text-indigo-700 bg-indigo-50 hover:bg-indigo-100 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          Save phrase
                        </button>
                        <button
                          onClick={() => {
                            setScriptSelection(null);
                            setScriptSelectionAnchor(null);
                          }}
                          disabled={!scriptSelection}
                          className="px-3 py-1.5 rounded-lg text-xs font-semibold border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                        >
                          Clear selection
                        </button>
                      </div>
                      <input
                        value={learningNote}
                        onChange={(e) => setLearningNote(e.target.value)}
                        placeholder="Optional note for your next saved item"
                        className="rounded-lg border border-slate-300 px-3 py-2 text-xs focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 outline-none"
                      />
                      {scriptSelectedText && (
                        <p className="text-xs text-slate-600">
                          Selected from script: <span className="font-medium text-slate-800">{scriptSelectedText}</span>
                        </p>
                      )}
                      {learningError && <p className="text-xs text-red-600">{learningError}</p>}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </aside>
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

function SentenceTokenSelector({
  words,
  selection,
  onToggleSelection,
  onSaveWord,
}: {
  words: string[];
  selection: { start: number; end: number } | null;
  onToggleSelection: (index: number) => void;
  onSaveWord: (word: string) => void;
}) {
  return (
    <div className="text-sm text-slate-700 leading-relaxed flex flex-wrap gap-2">
      {words.map((word, idx) => {
        const inSelection =
          selection !== null &&
          idx >= selection.start &&
          idx <= selection.end;
        return (
          <button
            key={idx}
            onClick={() => onToggleSelection(idx)}
            onDoubleClick={() => onSaveWord(word)}
            className={clsx(
              "rounded-full border px-2 py-1 text-xs font-medium transition-colors",
              inSelection
                ? "border-indigo-300 bg-indigo-50 text-indigo-700"
                : "border-slate-200 bg-slate-50 text-slate-700 hover:border-indigo-300 hover:bg-indigo-50"
            )}
            title="Click to select. Double-click to save this word."
          >
            {word}
          </button>
        );
      })}
    </div>
  );
}

function LessonSavedItemsList({
  items,
  compact = false,
}: {
  items: LessonSavedItem[];
  compact?: boolean;
}) {
  return (
    <div className={clsx("flex flex-col gap-2 max-h-52 overflow-y-auto pr-1", compact && "pr-0")}>
      {items.map((item) => (
        <div
          key={item.id}
          className={clsx(
            "rounded-lg border border-slate-200 bg-white p-3 flex flex-col gap-1",
            compact && "p-2 rounded-md"
          )}
        >
          <div className="flex items-center justify-between gap-2">
            <span className={clsx("text-sm text-slate-800", compact && "text-xs font-semibold")}>{item.term}</span>
            <span className="text-[10px] uppercase tracking-wide rounded-full bg-indigo-100 text-indigo-700 px-2 py-0.5">
              {item.type}
            </span>
          </div>
          <span className={clsx("text-xs text-slate-500", compact && "text-[11px]")}>
            Sentence {item.segment_index + 1}
          </span>
          <span className={clsx("text-xs text-slate-600", compact && "text-[11px] line-clamp-2")}>
            {item.sentence_context}
          </span>
          {item.note && (
            <span className={clsx("text-xs text-slate-700", compact && "text-[11px]")}>📝 {item.note}</span>
          )}
        </div>
      ))}
    </div>
  );
}
