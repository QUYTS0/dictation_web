"use client";

import { use, useState, useCallback, useEffect, useRef, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { clsx } from "clsx";
import {
  ArrowLeft,
  PanelRightClose,
  PanelRightOpen,
  SkipBack,
  SkipForward,
  Repeat,
  HelpCircle,
  Check,
  X,
  FileText,
  Bookmark,
  CheckCircle2,
  Sparkles,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

import YouTubePlayer, { type YouTubePlayerHandle } from "@/components/YouTubePlayer";
import HintDisplay from "@/components/HintDisplay";
import AIExplainer from "@/components/AIExplainer";
import ProgressBar from "@/components/ProgressBar";
import UserButton from "@/components/UserButton";
import VocabularySaveButton from "@/components/VocabularySaveButton";

import { usePlayerStore } from "@/store/playerStore";
import { useSessionStore, selectAccuracy } from "@/store/sessionStore";
import { useAuth, useRequireAuth } from "@/context/auth";
import { checkAnswer as evaluateAnswer } from "@/lib/utils/text";
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
type VideoSizeMode = "standard" | "large";

type LessonSavedItem = VocabularyItem & { type: LessonItemType };

interface CompletedSentenceReview {
  segmentIndex: number;
  expectedText: string;
  firstUserText: string;
  diff: DiffToken[];
}

interface ScriptSelectionPopoverState {
  segmentIndex: number;
  selectedText: string;
  selectedWordCount: number;
  sentenceText: string;
  x: number;
  y: number;
}

type ComparedTokenStatus = "correct" | "missing" | "wrong" | "extra" | "neutral";

interface ComparedToken {
  word: string;
  status: ComparedTokenStatus;
}

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

function normalizeComparableText(text: string) {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function inferSavedItemType(item: VocabularyItem): LessonItemType {
  const normalizedTerm = normalizeComparableText(item.term);
  const normalizedSentence = normalizeComparableText(item.sentence_context);
  if (normalizedTerm && normalizedTerm === normalizedSentence) return "sentence";
  return splitSentenceIntoWords(item.term).length <= 1 ? "word" : "phrase";
}

function buildComparedTokens({
  diff,
  expectedText,
  userText,
}: {
  diff: DiffToken[];
  expectedText: string;
  userText: string;
}) {
  const expectedTokens: ComparedToken[] = [];
  const userTokens: ComparedToken[] = [];

  for (const token of diff) {
    if (token.status === "correct") {
      expectedTokens.push({ word: token.word, status: "correct" });
      userTokens.push({ word: token.word, status: "correct" });
      continue;
    }
    if (token.status === "missing") {
      expectedTokens.push({ word: token.word, status: "missing" });
      continue;
    }
    if (token.status === "wrong") {
      userTokens.push({ word: token.word, status: "wrong" });
      continue;
    }
    userTokens.push({ word: token.word, status: "extra" });
  }

  if (expectedTokens.length === 0) {
    expectedTokens.push(
      ...splitSentenceIntoWords(expectedText).map((word) => ({
        word,
        status: "neutral" as const,
      }))
    );
  }
  if (userTokens.length === 0) {
    userTokens.push(
      ...splitSentenceIntoWords(userText).map((word) => ({
        word,
        status: "neutral" as const,
      }))
    );
  }

  return { expectedTokens, userTokens };
}

// ---- Data fetching ----

async function fetchTranscript(videoId: string): Promise<TranscriptResponse> {
  const res = await fetch(`/api/transcript/${videoId}?lang=en`);
  if (!res.ok) throw new Error("Failed to fetch transcript");
  return res.json();
}

async function checkAnswerApi(
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
const SCRIPT_POPOVER_MAX_SIDE_MARGIN_PX = 160;
const SCRIPT_POPOVER_MIN_SIDE_MARGIN_PX = 24;
const SCRIPT_POPOVER_VIEWPORT_MARGIN_FACTOR = 0.2;
const SCRIPT_POPOVER_VERTICAL_OFFSET_PX = 12;
const SCRIPT_POPOVER_MAX_WIDTH_PX = 320;
const SCRIPT_CONTEXT_NEXT_COUNT = 2;
const SCRIPT_CONTEXT_PREVIOUS_COUNT = 3;
const CORRECT_RESULT_VISIBILITY_DELAY_MS = 650;
const VIDEO_SIZE_MODE_STORAGE_KEY = "dictation.video-size-mode";
const VIDEO_SIZE_MODE_CLASS: Record<VideoSizeMode, string> = {
  standard: "max-w-4xl",
  large: "max-w-none",
};

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
  // Local state
  const [currentSegIdx, setCurrentSegIdx] = useState(0);
  const [uxState, setUxState] = useState<UXState>("loading_transcript");
  const [checkResult, setCheckResult] = useState<CheckAnswerResponse | null>(null);
  const [wrongAttempts, setWrongAttempts] = useState(0);
  const [hintLevel, setHintLevel] = useState<HintLevel>(0);
  const [transcriptId, setTranscriptId] = useState<string | undefined>();
  // In-memory mistake tracking for the session-review panel at completion
  const [mistakes, setMistakes] = useState<MistakeRecord[]>([]);
  const [resumeState, setResumeState] = useState<ResumeState | null>(null);
  const [resumeLoading, setResumeLoading] = useState(false);
  const [inputFocusSignal, setInputFocusSignal] = useState(0);
  const [learningItems, setLearningItems] = useState<LessonSavedItem[]>([]);
  const [learningError, setLearningError] = useState<string | null>(null);
  const [learningSaving, setLearningSaving] = useState(false);
  const [learningDeletingId, setLearningDeletingId] = useState<string | null>(null);
  const [learningUpdatingId, setLearningUpdatingId] = useState<string | null>(null);
  const [showLearningPanel, setShowLearningPanel] = useState(true);
  const [rightPanelTab, setRightPanelTab] = useState<RightPanelTab>("saved");
  const [savedFilter, setSavedFilter] = useState<SavedFilter>("all");
  const [videoSizeMode, setVideoSizeMode] = useState<VideoSizeMode>("standard");
  const [scriptPopover, setScriptPopover] = useState<ScriptSelectionPopoverState | null>(null);
  const [scriptShowAI, setScriptShowAI] = useState(false);
  const [scriptAiReady, setScriptAiReady] = useState(false);
  const [scriptPopoverNoteMode, setScriptPopoverNoteMode] = useState(false);
  const [previousReview, setPreviousReview] = useState<CompletedSentenceReview | null>(null);
  const [showPreviousScriptContext, setShowPreviousScriptContext] = useState(false);
  const [showScriptContext, setShowScriptContext] = useState(true);
  const [showVideo, setShowVideo] = useState(true);
  const [workspaceInputValue, setWorkspaceInputValue] = useState("");
  const [isZenMode, setIsZenMode] = useState(false);
  const [showHintPanel, setShowHintPanel] = useState(false);

  const ytPlayerRef = useRef<YouTubePlayerHandle>(null);
  const workspaceInputRef = useRef<HTMLInputElement>(null);
  // Keep lesson note draft in a ref (not state) so typing in note inputs
  // does not trigger full-page rerenders and input lag on heavy lesson UI.
  const learningNoteDraftRef = useRef("");
  const scriptPopoverNoteInputRef = useRef<HTMLInputElement>(null);
  const scriptTextContainerRef = useRef<HTMLDivElement>(null);
  const reviewTextContainerRef = useRef<HTMLDivElement>(null);
  const scriptPopoverRef = useRef<HTMLDivElement>(null);
  // Tracks whether the user manually triggered a replay while already paused
  // (keyboard shortcut / Replay button while input is visible). In this case we keep the
  // input and its typed words intact when the segment ends.
  const isManualReplayWhilePaused = useRef(false);
  // Ref mirror of currentSegIdx — lets handleSegmentEnd guard against stale
  // callbacks that fire after the user has already submitted early and advanced.
  const currentSegIdxRef = useRef(0);
  const resumeLoadedRef = useRef(false);
  const previousShowVideoRef = useRef(showVideo);
  const firstAttemptBySegmentRef = useRef<Record<number, string>>({});

  useEffect(() => {
    resumeLoadedRef.current = false;
    setResumeState(null);
    firstAttemptBySegmentRef.current = {};
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
      if (firstAttemptBySegmentRef.current[currentSegIdx] === undefined) {
        firstAttemptBySegmentRef.current[currentSegIdx] = userText;
      }
      setUxState("checking_answer");

      try {
        const result = await checkAnswerApi(
          currentSegIdx,
          userText,
          segments[currentSegIdx].text,
          "relaxed",
          sessionStore.sessionId ?? undefined
        );

        setCheckResult(result);
        sessionStore.incrementAttempt(result.isCorrect);

        if (result.isCorrect) {
          const firstAttemptText = (firstAttemptBySegmentRef.current[currentSegIdx] ?? userText).trim();
          const firstAttemptReview = evaluateAnswer(
            segments[currentSegIdx].text,
            firstAttemptText,
            result.matchMode
          );
          setPreviousReview({
            segmentIndex: currentSegIdx,
            expectedText: segments[currentSegIdx].text,
            firstUserText: firstAttemptText,
            diff: firstAttemptReview.diff ?? [],
          });
          setWrongAttempts(0);
          setHintLevel(0);

          const nextIdx = currentSegIdx + 1;
          triggerAutoSave(nextIdx, "active");
          window.setTimeout(() => {
            setCheckResult(null);
            if (nextIdx < segments.length) {
              currentSegIdxRef.current = nextIdx;
              setCurrentSegIdx(nextIdx);
              setUxState("playing");
              ytPlayerRef.current?.playSegment(nextIdx);
            } else {
              setUxState("session_completed");
              triggerAutoSave(nextIdx, "completed");
            }
          }, CORRECT_RESULT_VISIBILITY_DELAY_MS);
        } else {
          const newWrong = wrongAttempts + 1;
          setWrongAttempts(newWrong);
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
          setUxState("paused_waiting_input");
        }
      } catch {
        setUxState("paused_waiting_input");
      }
    },
    [currentSegIdx, segments, sessionStore, triggerAutoSave, wrongAttempts]
  );

  const handleWorkspaceCheck = useCallback(() => {
    const trimmed = workspaceInputValue.trim();
    if (!trimmed) return;
    void handleAnswerSubmit(trimmed);
  }, [handleAnswerSubmit, workspaceInputValue]);

  const handleWorkspaceInputKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        handleWorkspaceCheck();
      }
    },
    [handleWorkspaceCheck]
  );

  // ---- Start session (seek to segment 0 and play) ----
  const handleStart = useCallback(() => {
    firstAttemptBySegmentRef.current = {};
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
      setUxState("playing");
      triggerAutoSave(prevIdx, "active");
    }
  }, [currentSegIdx, triggerAutoSave]);

  // ---- Keyboard shortcuts ----
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const target = e.target;
      const isTypingTarget =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable);

      if (e.shiftKey && e.code === "Space") {
        e.preventDefault();
        handleReplay();
        return;
      }

      if (e.shiftKey && e.key === "ArrowLeft") {
        e.preventDefault();
        handlePrevious();
        return;
      }

      if (e.shiftKey && e.key === "ArrowRight") {
        e.preventDefault();
        handleSkip();
        return;
      }

      if (!isTypingTarget && e.key === "/") {
        e.preventDefault();
        setInputFocusSignal((v) => v + 1);
        return;
      }

      if (isTypingTarget) return;
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

  // ---- Load saved vocabulary for this video ----
  useEffect(() => {
    if (!user) {
      setLearningItems([]);
      return;
    }

    let isCancelled = false;
    setLearningError(null);

    void fetch(`/api/vocabulary?videoId=${encodeURIComponent(videoId)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error("Failed to fetch saved items");
        const data = (await res.json()) as { items?: VocabularyItem[] };
        if (isCancelled) return;
        const items = (data.items ?? []).map((item) => ({
          ...item,
          type: inferSavedItemType(item),
          note: item.note ?? "",
        }));
        setLearningItems(items);
      })
      .catch((err: unknown) => {
        if (isCancelled) return;
        const message =
          err instanceof Error && err.message
            ? err.message
            : "Failed to load saved items for this video.";
        setLearningError(message);
      });

    return () => {
      isCancelled = true;
    };
  }, [user, videoId]);

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
        firstAttemptBySegmentRef.current = {};
        setResumeState(null);
        sessionStore.setSessionId(null);
      })
      .catch(() => {});
  }, [resumeState?.sessionId, sessionStore, user, videoId]);

  const currentSegment = segments[currentSegIdx];

  // Derived flag: show dictation input during playback and while paused/checking
  const shouldShowInput =
    (uxState === "paused_waiting_input" ||
      uxState === "checking_answer" ||
      uxState === "playing") &&
    !!currentSegment;

  useEffect(() => {
    setWorkspaceInputValue("");
    setShowHintPanel(false);
  }, [currentSegIdx]);

  useEffect(() => {
    if (!shouldShowInput) return;
    const t = window.setTimeout(() => workspaceInputRef.current?.focus(), 30);
    return () => window.clearTimeout(t);
  }, [inputFocusSignal, shouldShowInput]);

  const lessonSavedInCurrentVideo = useMemo(
    () => learningItems.filter((item) => item.video_id === videoId),
    [learningItems, videoId]
  );
  const filteredSavedItems = useMemo(() => {
    if (savedFilter === "all") return lessonSavedInCurrentVideo;
    return lessonSavedInCurrentVideo.filter((item) => item.type === savedFilter);
  }, [lessonSavedInCurrentVideo, savedFilter]);
  const shouldShowPreviousReview =
    !!previousReview &&
    previousReview.segmentIndex === currentSegIdx - 1 &&
    uxState !== "session_completed";
  const scriptSelectedType = getSelectedType(scriptPopover?.selectedWordCount ?? 0);
  const scriptAiPayload = buildAiExplainPayload({
    selectedType: scriptSelectedType,
    selectedText: scriptPopover?.selectedText ?? "",
    sentenceText: scriptPopover?.sentenceText ?? "",
    userText: scriptPopover?.selectedText ?? "",
  });
  const segmentsByIndex = useMemo(
    () => new Map(segments.map((segment) => [segment.segmentIndex, segment])),
    [segments]
  );
  const scriptContextStartIndex = showPreviousScriptContext
    ? Math.max(0, currentSegIdx - SCRIPT_CONTEXT_PREVIOUS_COUNT)
    : currentSegIdx;
  const scriptContextSegments = useMemo(
    () =>
      segments.filter(
        (segment) =>
          segment.segmentIndex >= scriptContextStartIndex &&
          segment.segmentIndex <= currentSegIdx + SCRIPT_CONTEXT_NEXT_COUNT
      ),
    [currentSegIdx, scriptContextStartIndex, segments]
  );
  const shouldRenderVideoPlayer =
    uxState !== "loading_transcript" &&
    uxState !== "transcript_processing" &&
    uxState !== "transcript_failed";
  const videoBlock = shouldRenderVideoPlayer && (
    <div className={clsx("mx-auto flex h-full w-full transition-all duration-200", VIDEO_SIZE_MODE_CLASS[videoSizeMode])}>
      <div className="h-full w-full">
        <YouTubePlayer
          ref={ytPlayerRef}
          videoId={videoId}
          segments={segments}
          onSegmentEnd={handleSegmentEnd}
        />
      </div>
    </div>
  );

  useEffect(() => {
    const wasShowingVideo = previousShowVideoRef.current;
    if (!wasShowingVideo && showVideo) {
      ytPlayerRef.current?.seekTo(playerStore.currentTimeSec, uxState === "playing");
    }
    previousShowVideoRef.current = showVideo;
  }, [showVideo, playerStore.currentTimeSec, uxState]);

  useEffect(() => {
    if (!showLearningPanel || rightPanelTab !== "script") return;
    const container = scriptTextContainerRef.current;
    if (!container) return;
    const currentCard = container.querySelector<HTMLElement>(
      `[data-script-segment-index="${currentSegIdx}"]`
    );
    currentCard?.scrollIntoView({ block: "nearest" });
  }, [currentSegIdx, rightPanelTab, showLearningPanel]);

  const clearScriptSelection = useCallback(() => {
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) selection.removeAllRanges();
    setScriptPopover(null);
  }, []);

  useEffect(() => {
    if (showScriptContext) return;
    clearScriptSelection();
    setScriptPopoverNoteMode(false);
    setScriptShowAI(false);
    setScriptAiReady(false);
  }, [clearScriptSelection, showScriptContext]);

  // Intentionally ref-only updates: keep typing smooth without rerendering
  // the entire lesson screen on every note keystroke.
  const handleLearningNoteChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    learningNoteDraftRef.current = event.target.value;
  }, []);

  const clearLearningNoteInputs = useCallback(() => {
    learningNoteDraftRef.current = "";
    if (scriptPopoverNoteInputRef.current) scriptPopoverNoteInputRef.current.value = "";
  }, []);

  const saveLessonCaptureAtSegment = useCallback(
    (text: string, type: LessonItemType, segmentIndex: number, sentenceContext: string) => {
      const trimmedText = text.trim();
      if (!trimmedText) return;

      const saveNote = learningNoteDraftRef.current.trim();
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
            clearLearningNoteInputs();
            setShowLearningPanel(true);
            if (type !== "sentence") {
              clearScriptSelection();
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
    [clearLearningNoteInputs, clearScriptSelection, requireAuth, videoId]
  );

  const deleteLessonCapture = useCallback(
    (itemId: string) => {
      requireAuth(() => {
        setLearningDeletingId(itemId);
        setLearningError(null);
        void fetch(`/api/vocabulary?id=${encodeURIComponent(itemId)}`, {
          method: "DELETE",
        })
          .then(async (res) => {
            if (!res.ok) {
              const data = (await res.json().catch(() => ({}))) as { error?: string };
              throw new Error(data.error || "Failed to delete saved item");
            }
            setLearningItems((prev) => prev.filter((item) => item.id !== itemId));
          })
          .catch((err: unknown) => {
            const message =
              err instanceof Error && err.message
                ? err.message
                : "Failed to delete saved item. Please try again.";
            setLearningError(message);
          })
          .finally(() => {
            setLearningDeletingId(null);
          });
      });
    },
    [requireAuth]
  );

  const updateLessonCapture = useCallback(
    (itemId: string, values: { term: string; sentenceContext: string; note: string }) => {
      const nextTerm = values.term.trim();
      const nextSentenceContext = values.sentenceContext.trim();
      requireAuth(() => {
        setLearningUpdatingId(itemId);
        setLearningError(null);
        void fetch("/api/vocabulary", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: itemId,
            term: nextTerm,
            sentenceContext: nextSentenceContext,
            note: values.note,
          }),
        })
          .then(async (res) => {
            const data = (await res.json().catch(() => ({}))) as {
              error?: string;
              item?: VocabularyItem;
            };
            if (!res.ok || !data.item) {
              throw new Error(data.error || "Failed to update saved item");
            }
            const updatedItem = data.item;
            setLearningItems((prev) =>
              prev.map((item) =>
                item.id === itemId
                  ? {
                      ...item,
                      ...updatedItem,
                      note: updatedItem.note ?? "",
                    }
                  : item
              )
            );
          })
          .catch((err: unknown) => {
            const message =
              err instanceof Error && err.message
                ? err.message
                : "Failed to update saved item. Please try again.";
            setLearningError(message);
          })
          .finally(() => {
            setLearningUpdatingId(null);
          });
      });
    },
    [requireAuth]
  );

  const handleSelectionMouseUp = useCallback((container: HTMLDivElement | null) => {
    if (typeof window === "undefined") return;
    if (!container) return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      setScriptPopover(null);
      return;
    }

    const selectedText = selection.toString().replace(/\s+/g, " ").trim();
    if (!selectedText) {
      setScriptPopover(null);
      return;
    }

    const range = selection.getRangeAt(0);
    if (!container.contains(range.commonAncestorContainer)) {
      return;
    }

    const anchorElement =
      range.commonAncestorContainer instanceof HTMLElement
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;
    const segmentElement = anchorElement?.closest<HTMLElement>("[data-script-segment-index]");
    if (!segmentElement) return;

    const segmentIndexValue = segmentElement.dataset.scriptSegmentIndex;
    if (!segmentIndexValue || segmentIndexValue.trim() === "") return;
    const segmentIndex = parseInt(segmentIndexValue, 10);
    const segment = segmentsByIndex.get(segmentIndex);
    if (!Number.isFinite(segmentIndex) || !segment) return;
    const sentenceText = segmentElement.dataset.selectionSentenceText?.trim() || segment.text;

    const selectedWordCount = splitSentenceIntoWords(selectedText).length;
    const rect = range.getBoundingClientRect();
    const popoverHorizontalMargin = Math.min(
      SCRIPT_POPOVER_MAX_SIDE_MARGIN_PX,
      Math.max(SCRIPT_POPOVER_MIN_SIDE_MARGIN_PX, window.innerWidth * SCRIPT_POPOVER_VIEWPORT_MARGIN_FACTOR)
    );
    const x = Math.min(
      Math.max(rect.left + rect.width / 2, popoverHorizontalMargin),
      window.innerWidth - popoverHorizontalMargin
    );
    const y = Math.max(rect.top - SCRIPT_POPOVER_VERTICAL_OFFSET_PX, SCRIPT_POPOVER_VERTICAL_OFFSET_PX);

    setScriptShowAI(false);
    setScriptAiReady(false);
    setScriptPopoverNoteMode(false);
    setScriptPopover({
      segmentIndex,
      selectedText,
      selectedWordCount,
      sentenceText,
      x,
      y,
    });
  }, [segmentsByIndex]);

  const handleScriptMouseUp = useCallback(() => {
    handleSelectionMouseUp(scriptTextContainerRef.current);
  }, [handleSelectionMouseUp]);

  const handleReviewMouseUp = useCallback(() => {
    handleSelectionMouseUp(reviewTextContainerRef.current);
  }, [handleSelectionMouseUp]);

  const handleScriptPopoverAction = useCallback(
    (type: "word" | "phrase" | "sentence" | "explain" | "note") => {
      if (!scriptPopover) return;
      const segment = segmentsByIndex.get(scriptPopover.segmentIndex);
      if (!segment) return;

      if (type === "explain") {
        setScriptPopoverNoteMode(false);
        setScriptShowAI(true);
        return;
      }
      if (type === "note") {
        setScriptPopoverNoteMode(true);
        window.setTimeout(() => scriptPopoverNoteInputRef.current?.focus(), 10);
        return;
      }

      setScriptPopoverNoteMode(false);
      const textToSave =
        type === "sentence" ? segment.text : scriptPopover.selectedText;
      void saveLessonCaptureAtSegment(textToSave, type, segment.segmentIndex, segment.text);
      clearScriptSelection();
      setScriptShowAI(false);
    },
    [clearScriptSelection, saveLessonCaptureAtSegment, scriptPopover, segmentsByIndex]
  );

  useEffect(() => {
    clearLearningNoteInputs();
  }, [clearLearningNoteInputs, currentSegIdx, currentSegment?.text]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = window.localStorage.getItem(VIDEO_SIZE_MODE_STORAGE_KEY);
    if (saved === "standard" || saved === "large") {
      setVideoSizeMode(saved);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(VIDEO_SIZE_MODE_STORAGE_KEY, videoSizeMode);
  }, [videoSizeMode]);

  useEffect(() => {
    clearScriptSelection();
    setScriptShowAI(false);
    setScriptAiReady(false);
    setScriptPopoverNoteMode(false);
    setShowPreviousScriptContext(false);
    setShowScriptContext(true);
  }, [clearScriptSelection, videoId]);

  useEffect(() => {
    if (!scriptShowAI) setScriptAiReady(false);
  }, [scriptShowAI]);

  useEffect(() => {
    if (!scriptPopover) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        clearScriptSelection();
        setScriptPopoverNoteMode(false);
      }
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [clearScriptSelection, scriptPopover]);

  useEffect(() => {
    if (scriptPopover) {
      scriptPopoverRef.current?.focus();
      return;
    }
    setScriptPopoverNoteMode(false);
  }, [scriptPopover]);

  const workspaceTitle =
    transcriptQuery.data?.title ?? `Video ${videoId}`;
  const sentenceProgressLabel =
    segments.length > 0
      ? `Sentence ${Math.min(currentSegIdx + 1, segments.length)} of ${segments.length}`
      : "Preparing transcript…";

  const isCheckingWorkspace = uxState === "checking_answer" && checkResult === null;
  const workspaceStatus: "idle" | "success" | "error" = checkResult
    ? checkResult.isCorrect
      ? "success"
      : "error"
    : "idle";

  // ---- Render ----
  return (
    <div className="relative flex min-h-screen w-full flex-1 flex-col overflow-hidden bg-[#f4f7ff] font-sans text-slate-900 antialiased">
      <div className="pointer-events-none absolute -left-[10%] -top-[10%] z-0 h-[40%] w-[40%] rounded-full bg-purple-200 opacity-60 blur-[120px]" />
      <div className="pointer-events-none absolute bottom-[10%] right-[0%] z-0 h-[40%] w-[40%] rounded-full bg-blue-200 opacity-60 blur-[120px]" />
      <AnimatePresence>
        {isZenMode && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 bg-slate-950/90 backdrop-blur-2xl z-0 transition-all pointer-events-none"
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {!isZenMode && (
          <motion.header
            initial={{ y: -64, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -64, opacity: 0 }}
            className="sticky top-0 z-10 w-full border-b border-white/40 bg-white/30 px-6 py-4 backdrop-blur-md"
          >
            <div className="mx-auto flex w-full max-w-6xl items-center justify-between">
              <div className="flex min-w-0 items-center gap-4">
                <Link href="/" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100" aria-label="Back to dashboard">
                  <ArrowLeft size={18} />
                </Link>
                <div className="min-w-0">
                  <h1 className="truncate text-sm font-semibold leading-tight text-slate-900">{workspaceTitle}</h1>
                  <span className="text-xs text-slate-500">{sentenceProgressLabel}</span>
                </div>
              </div>
              <UserButton />
            </div>
          </motion.header>
        )}
      </AnimatePresence>

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-4 py-6 lg:flex-row lg:items-start">
        <motion.div
          layout
          transition={{ type: "tween", ease: "linear", duration: 0.25 }}
          className={clsx(
            "min-w-0 flex-1 flex flex-col gap-6",
            isZenMode && "z-50"
          )}
        >
          <div className="flex flex-wrap items-center justify-start gap-2">
            <button
              onClick={() => setShowVideo((v) => !v)}
              className="text-xs font-bold px-3 py-1.5 rounded-lg border border-white/60 bg-white/40 text-slate-600 hover:bg-white/80 transition-colors flex items-center gap-2"
            >
              <Sparkles size={14} className="text-indigo-500" />
              {showVideo ? "Audio Mode" : "Exit Audio Mode"}
            </button>
            <button
              onClick={() => setIsZenMode(true)}
              className="text-xs font-bold px-3 py-1.5 rounded-lg border border-white/60 bg-white/40 text-slate-600 hover:bg-white/80 transition-colors flex items-center gap-2"
            >
              <Sparkles size={14} className="text-indigo-500" />
              Zen Mode
            </button>

            <div className="flex items-center rounded-full border border-white/70 bg-white/60 p-1 shadow-sm backdrop-blur-md">
              <button
                onClick={() => setVideoSizeMode("standard")}
                className={clsx(
                  "rounded-full px-3 py-1 text-xs font-semibold transition-colors",
                  videoSizeMode === "standard"
                    ? "bg-indigo-600 text-white"
                    : "text-slate-600 hover:bg-white/80"
                )}
              >
                Standard
              </button>
              <button
                onClick={() => setVideoSizeMode("large")}
                className={clsx(
                  "rounded-full px-3 py-1 text-xs font-semibold transition-colors",
                  videoSizeMode === "large"
                    ? "bg-indigo-600 text-white"
                    : "text-slate-600 hover:bg-white/80"
                )}
              >
                Large
              </button>
            </div>

          </div>

          <div className={clsx("relative w-full aspect-video rounded-3xl overflow-hidden shadow-2xl border border-white/20 shrink-0 transition-transform bg-black", isZenMode && "scale-105")}>
            <div className={clsx("absolute inset-0", !showVideo && "opacity-0 pointer-events-none")} aria-hidden={!showVideo}>
              {videoBlock}
            </div>
            {!showVideo && (
              <div className="absolute inset-0 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm">
                <div className="rounded-xl border border-white/20 bg-white/10 px-4 py-3 text-center text-xs text-white/85">
                  Audio focus mode is enabled. Video is hidden.
                </div>
              </div>
            )}
          </div>

          <div className={`flex-1 bg-white/40 dark:bg-slate-800/40 backdrop-blur-xl border border-white/60 dark:border-white/10 rounded-3xl p-6 sm:p-8 flex flex-col shadow-xl transition-all ${isZenMode ? "bg-slate-900/40 border-white/5" : ""}`}>
            

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
                <p className="text-sm text-slate-500">Could not generate a transcript for this video.</p>
              </div>
            )}

            {uxState === "transcript_ready" && segments.length > 0 && (
              <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-4 flex flex-col gap-3 mb-4">
                <p className="text-emerald-700 font-semibold">Transcript ready - {segments.length} sentences</p>
                <p className="text-sm text-slate-600">Press the button below to start. The video will play each sentence one at a time and pause so you can type what you heard.</p>
                <div className="flex items-center gap-3 mt-1">
                  {resumeState ? (
                    <>
                      <button onClick={handleResume} className="px-6 py-2 rounded-xl bg-indigo-600 text-white font-semibold text-sm hover:bg-indigo-700 transition-colors">
                        Resume at sentence {resumeState.currentSegmentIndex + 1}
                      </button>
                      <button onClick={handleRestart} className="px-4 py-2 rounded-xl border border-slate-300 text-slate-700 font-semibold text-sm hover:bg-slate-50 transition-colors">
                        Restart
                      </button>
                    </>
                  ) : (
                    <button onClick={handleStart} className="px-6 py-2 rounded-xl bg-indigo-600 text-white font-semibold text-sm hover:bg-indigo-700 transition-colors">
                      Start Dictation
                    </button>
                  )}
                </div>
                {resumeLoading && <p className="text-xs text-slate-500">Checking for saved progress...</p>}
              </div>
            )}

            {(uxState === "paused_waiting_input" || uxState === "playing" || uxState === "checking_answer") && (
              <>
                <div className="flex items-center justify-between px-2 mb-2">
                  <div className="flex items-center gap-3">
                    <ControlButton icon={<SkipBack size={18} />} shortcut="Shift + <-" label="Prev" onClick={handlePrevious} disabled={currentSegIdx === 0} />
                    <ControlButton icon={<Repeat size={18} />} shortcut="Shift + Space" label="Replay" primary onClick={handleReplay} />
                    <ControlButton icon={<SkipForward size={18} />} shortcut="Shift + ->" label="Next" onClick={handleSkip} disabled={currentSegIdx >= segments.length - 1} />
                  </div>
                  <div className="flex items-center gap-2 text-sm font-medium text-slate-500 dark:text-slate-400">
                    <CheckCircle2 size={16} className="text-emerald-500" />
                    <span>Accuracy: {accuracy}%</span>
                  </div>
                </div>

                <div className="relative mt-4">
                  <div className={`relative rounded-2xl overflow-hidden border-2 transition-all ${
                    workspaceStatus === "success"
                      ? "border-emerald-500 bg-emerald-50/30"
                      : workspaceStatus === "error"
                      ? "border-red-500 bg-red-50/30"
                      : `border-slate-200 dark:border-white/10 bg-white dark:bg-slate-900 focus-within:border-indigo-500 focus-within:ring-4 focus-within:ring-indigo-500/10 ${isZenMode ? "shadow-2xl" : ""}`
                  }`}>
                    <input
                      ref={workspaceInputRef}
                      type="text"
                      value={workspaceInputValue}
                      onChange={(e) => {
                        setWorkspaceInputValue(e.target.value);
                        setCheckResult(null);
                      }}
                      onKeyDown={handleWorkspaceInputKeyDown}
                      placeholder="Type what you hear..."
                      className="w-full bg-transparent p-6 pr-24 text-xl font-medium text-slate-900 dark:text-white placeholder:text-slate-400 outline-none"
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                    />

                    <div className="absolute right-4 top-1/2 -translate-y-1/2 flex items-center">
                      <AnimatePresence mode="wait">
                        {isCheckingWorkspace ? (
                          <motion.div
                            key="loading"
                            initial={{ opacity: 0, scale: 0.8 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.8 }}
                            className="w-8 h-8 border-3 border-indigo-500 border-t-transparent rounded-full animate-spin"
                          />
                        ) : workspaceStatus === "success" ? (
                          <motion.div
                            key="success"
                            initial={{ opacity: 0, scale: 0.8 }}
                            animate={{ opacity: 1, scale: 1 }}
                            className="bg-emerald-500 text-white p-2 rounded-xl flex items-center shadow-lg"
                          >
                            <Check size={20} strokeWidth={3} />
                          </motion.div>
                        ) : workspaceStatus === "error" ? (
                          <motion.button
                            key="error"
                            onClick={() => setCheckResult(null)}
                            initial={{ opacity: 0, scale: 0.8 }}
                            animate={{ opacity: 1, scale: 1 }}
                            className="bg-red-500 text-white px-4 py-2 rounded-xl font-bold text-sm shadow-lg active:scale-95 transition-all"
                          >
                            Try Again
                          </motion.button>
                        ) : (
                          <motion.button
                            key="idle"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            onClick={handleWorkspaceCheck}
                            disabled={!workspaceInputValue.trim()}
                            className="bg-indigo-600 text-white px-6 py-2.5 rounded-xl font-bold text-sm hover:bg-indigo-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-indigo-500/20 active:scale-95"
                          >
                            Check
                          </motion.button>
                        )}
                      </AnimatePresence>
                    </div>
                  </div>
                </div>

                <AnimatePresence>
                  {workspaceStatus === "error" && checkResult && (
                    <motion.div
                      initial={{ height: 0, opacity: 0, scale: 0.95 }}
                      animate={{ height: "auto", opacity: 1, scale: 1 }}
                      exit={{ height: 0, opacity: 0, scale: 0.95 }}
                      className="overflow-hidden"
                    >
                      <div className="bg-red-500/10 border border-red-500/30 rounded-2xl p-5 mt-4">
                        <h4 className="text-[10px] font-black text-red-500 uppercase tracking-[0.2em] mb-3">Correction Needed</h4>
                        <div className="font-mono text-sm leading-relaxed p-4 bg-white/20 dark:bg-black/20 rounded-xl border border-red-500/20 shadow-inner">
                          <p className="text-red-500 line-through opacity-60 decoration-2">{checkResult.normalizedUser || "(No answer provided)"}</p>
                          <p className="text-slate-900 dark:text-white bg-red-500/20 px-2 py-0.5 rounded font-bold underline decoration-red-500/50 decoration-offset-4 mt-2">{checkResult.normalizedExpected}</p>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                <div className="flex justify-center mt-6">
                  <button
                    onClick={() => setShowHintPanel((prev) => !prev)}
                    className="flex items-center gap-2 text-sm font-bold text-indigo-600 dark:text-indigo-400 hover:text-indigo-700 bg-white/60 dark:bg-white/5 hover:bg-white/90 px-6 py-3 rounded-2xl transition-all border border-white/80 dark:border-white/10 shadow-sm active:scale-95"
                  >
                    <HelpCircle size={18} /> {showHintPanel ? "Hide hint" : "Need a hint?"}
                  </button>
                </div>

                {showHintPanel && currentSegment && !checkResult?.isCorrect && (
                  <div className="mt-4">
                    <HintDisplay text={currentSegment.text} level={hintLevel} onLevelChange={(l) => setHintLevel(l)} />
                  </div>
                )}

                {segments.length > 0 && (
                  <div className="mt-5">
                    <ProgressBar currentIndex={currentSegIdx} totalSegments={segments.length} accuracy={accuracy} />
                  </div>
                )}

                {shouldShowPreviousReview && previousReview && (
                  <div ref={reviewTextContainerRef} onMouseUp={handleReviewMouseUp} className="rounded-xl border border-slate-200 bg-white p-3 flex flex-col gap-2 mt-4">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-600">Review previous sentence</p>
                      <span className="rounded-full border border-slate-300 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-600">#{previousReview.segmentIndex + 1}</span>
                    </div>
                    <div data-script-segment-index={previousReview.segmentIndex} data-selection-sentence-text={previousReview.expectedText} className="rounded-lg border border-emerald-200 bg-emerald-50/60 p-2 text-xs text-slate-700">
                      <p className="text-[11px] font-semibold text-slate-500">Correct sentence</p>
                      <ComparedSentenceText
                        tokens={buildComparedTokens({ diff: previousReview.diff, expectedText: previousReview.expectedText, userText: previousReview.firstUserText }).expectedTokens}
                        tone="expected"
                      />
                    </div>
                    <div data-script-segment-index={previousReview.segmentIndex} data-selection-sentence-text={previousReview.expectedText} className="rounded-lg border border-slate-200 bg-slate-100 p-2 text-xs text-slate-700">
                      <p className="text-[11px] font-semibold text-slate-500">Your answer</p>
                      <ComparedSentenceText
                        tokens={buildComparedTokens({ diff: previousReview.diff, expectedText: previousReview.expectedText, userText: previousReview.firstUserText }).userTokens}
                        tone="user"
                        emptyFallback="(No answer provided)"
                      />
                    </div>
                  </div>
                )}
              </>
            )}

            <AnimatePresence>
              {isZenMode && (
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 20 }}
                  className="mt-8 flex justify-center"
                >
                  <button onClick={() => setIsZenMode(false)} className="group flex flex-col items-center gap-2">
                    <div className="w-12 h-12 rounded-full bg-white/10 border border-white/20 backdrop-blur-md flex items-center justify-center text-white/50 group-hover:text-white group-hover:bg-white/20 transition-all group-hover:scale-110">
                      <X size={24} />
                    </div>
                    <span className="text-[10px] uppercase font-black tracking-widest text-white/30 group-hover:text-white/60 transition-colors">Exit Zen Mode</span>
                  </button>
                </motion.div>
              )}
            </AnimatePresence>

            {uxState === "session_completed" && (
              <div className="rounded-xl border border-indigo-300 bg-indigo-50 p-6 flex flex-col gap-4 mt-6">
                <div className="text-center">
                  <p className="text-3xl">🎉</p>
                  <p className="text-indigo-700 font-bold text-xl">Session Complete!</p>
                  <p className="text-slate-600 text-sm mt-1">Final accuracy: <span className="font-bold">{accuracy}%</span> over {sessionStore.totalAttempts} attempts.</p>
                </div>
                {mistakes.length > 0 ? (
                  <div className="flex flex-col gap-2">
                    <p className="text-slate-700 font-semibold text-sm">Mistakes ({mistakes.length} sentence{mistakes.length !== 1 ? "s" : ""}):</p>
                    <div className="flex flex-col gap-2 max-h-72 overflow-y-auto pr-1">
                      {mistakes.map((m) => (
                        <div key={m.segIdx} className="bg-white rounded-lg border border-slate-200 p-3 flex flex-col gap-1">
                          <span className="text-xs text-slate-400 font-medium">Sentence {m.segIdx + 1}</span>
                          <span className="text-sm text-slate-800">{m.expectedText}</span>
                          <span className="text-xs text-red-500">You typed: {m.userText || <span className="italic text-slate-400">nothing</span>}</span>
                          <VocabularySaveButton videoId={videoId} segmentIndex={m.segIdx} sentenceContext={m.expectedText} />
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p className="text-emerald-600 text-sm font-medium text-center">Perfect session - no mistakes!</p>
                )}
                <Link href="/" className="mt-2 inline-block rounded-xl bg-indigo-600 text-white px-6 py-2 font-semibold hover:bg-indigo-700 transition-colors text-center">
                  Try another video
                </Link>
              </div>
            )}
          </div>
        </motion.div>

        {!isZenMode && (
          <AnimatePresence initial={false}>
            {showLearningPanel && (
              <motion.div
                key="learning-panel"
                initial={{ width: 0 }}
                animate={{ width: 360 }}
                exit={{ width: 0 }}
                transition={{ type: "tween", ease: "linear", duration: 0.25 }}
                className="overflow-hidden flex-shrink-0 lg:sticky lg:top-4 lg:h-[calc(100vh-2rem)] lg:max-h-[calc(100vh-2rem)]"
              >
                <div className="w-[360px] h-full flex flex-col bg-white/60 dark:bg-slate-800/60 backdrop-blur-xl border border-white/80 dark:border-white/10 rounded-3xl shadow-lg overflow-hidden">
              <div className="p-4 border-b border-white/40 dark:border-white/10 bg-white/30 dark:bg-slate-900/40 backdrop-blur-md">
                <div className="mb-4 flex items-center justify-between gap-2">
                  <h2 className="font-semibold text-slate-900 dark:text-white">Lesson panel</h2>
                  <button
                    onClick={() => setShowLearningPanel(false)}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/70 bg-white/60 text-slate-700 shadow-sm backdrop-blur-md transition-all hover:bg-white"
                    aria-label="Hide lesson panel"
                  >
                    <PanelRightClose size={16} />
                  </button>
                </div>
                <div className="flex bg-white/40 dark:bg-slate-900/40 border border-white/60 dark:border-white/10 p-1 rounded-xl shadow-inner text-slate-900 dark:text-white">
                <button
                  onClick={() => setRightPanelTab("script")}
                  className={`flex-1 flex items-center justify-center gap-2 py-2 text-sm font-bold rounded-lg transition-all ${rightPanelTab === "script" ? "bg-white dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 shadow-sm border border-white/60 dark:border-white/10" : "text-slate-500 dark:text-slate-400 hover:text-indigo-600"}`}
                >
                  <FileText size={16} /> Script
                </button>
                <button
                  onClick={() => setRightPanelTab("saved")}
                  className={`flex-1 flex items-center justify-center gap-2 py-2 text-sm font-bold rounded-lg transition-all ${rightPanelTab === "saved" ? "bg-white dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 shadow-sm border border-white/60 dark:border-white/10" : "text-slate-500 dark:text-slate-400 hover:text-indigo-600"}`}
                >
                  <Bookmark size={16} /> Saved
                </button>
              </div>
                </div>

              <div className="min-h-0 flex-1 overflow-y-auto p-4 flex flex-col gap-4">
              {rightPanelTab === "saved" ? (
                <>
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
                    <div className="flex flex-col items-center justify-center h-full text-center px-4">
                      <Bookmark size={32} className="text-slate-300 dark:text-slate-600 mb-3" />
                      <p className="text-slate-500 dark:text-slate-400 text-xs font-medium">
                        {savedFilter === "all"
                          ? "No saved vocabulary yet."
                          : `No ${getSavedFilterLabel(savedFilter).toLowerCase()} saved yet.`}
                      </p>
                    </div>
                  ) : (
                    <LessonSavedItemsList
                      items={filteredSavedItems}
                      compact
                      scrollClassName="h-full"
                      deletingId={learningDeletingId}
                      updatingId={learningUpdatingId}
                      onDelete={deleteLessonCapture}
                      onUpdate={updateLessonCapture}
                    />
                  )}
                </>
              ) : (
                <>
                  <div className="flex items-center gap-2">
                    <button onClick={() => setShowScriptContext((prev) => !prev)} className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50">
                      {showScriptContext ? "Hide script" : "Show script"}
                    </button>
                    {currentSegIdx > 0 && (
                      <button onClick={() => setShowPreviousScriptContext((prev) => !prev)} className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50">
                        {showPreviousScriptContext ? "Hide previous" : "Show previous"}
                      </button>
                    )}
                  </div>
                  {scriptContextSegments.length === 0 ? (
                    <p className="text-xs text-slate-500">Script is not available yet.</p>
                  ) : !showScriptContext ? (
                    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-500">Script context is hidden. Use Show script when you want to reveal it.</div>
                  ) : (
                    <div ref={scriptTextContainerRef} onMouseUp={handleScriptMouseUp} className="relative min-h-0 flex-1 overflow-y-auto pr-1 flex flex-col gap-3 text-sm">
                      {scriptContextSegments.map((segment) => {
                        const isCurrentScriptSentence = segment.segmentIndex === currentSegIdx;
                        const isPreviousScriptSentence = segment.segmentIndex < currentSegIdx;
                        return (
                          <div
                            key={segment.segmentIndex}
                            data-script-segment-index={segment.segmentIndex}
                            data-selection-sentence-text={segment.text}
                            className={`p-4 rounded-xl border transition-colors shadow-sm ${
                              isCurrentScriptSentence
                                ? "bg-white/80 dark:bg-slate-700/60 border-indigo-200 dark:border-indigo-500/40 ring-2 ring-indigo-500/20"
                                : isPreviousScriptSentence
                                ? "bg-white/40 dark:bg-white/5 border-white/60 dark:border-white/10 opacity-80 hover:opacity-100"
                                : "bg-white/40 dark:bg-white/5 border-white/60 dark:border-white/10 opacity-80 hover:opacity-100"
                            }`}
                          >
                            <div className={`text-xs font-bold mb-1 flex items-center justify-between ${isCurrentScriptSentence ? "text-indigo-600 dark:text-indigo-400" : isPreviousScriptSentence ? "text-emerald-600" : "text-slate-500"}`}>
                              <span className="uppercase tracking-widest text-[9px]">Sentence #{segment.segmentIndex + 1}</span>
                              {isCurrentScriptSentence && <div className="w-2 h-2 rounded-full bg-indigo-500 animate-pulse" />}
                            </div>
                            <p className={`text-sm leading-relaxed select-text ${isCurrentScriptSentence ? "text-slate-900 dark:text-white font-medium" : "text-slate-600 dark:text-slate-400"}`}>{segment.text}</p>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {learningError && <p className="text-xs text-red-600">{learningError}</p>}
                </>
              )}
                </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        )}

        {!isZenMode && !showLearningPanel && (
          <div className="hidden lg:flex lg:sticky lg:top-4 self-start">
            <button
              onClick={() => setShowLearningPanel(true)}
              className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-white/80 bg-white/60 text-slate-700 shadow-sm backdrop-blur-md transition-colors hover:bg-white"
              aria-label="Show lesson panel"
            >
              <PanelRightOpen size={16} />
            </button>
          </div>
        )}

        {!isZenMode && !showLearningPanel && (
          <div className="flex w-full justify-end lg:hidden">
            <button
              onClick={() => setShowLearningPanel(true)}
              className="h-10 w-10 rounded-xl border border-white/80 bg-white/60 text-slate-700 shadow-sm backdrop-blur-md transition-colors hover:bg-white"
              aria-label="Show lesson panel"
            >
              <PanelRightOpen size={16} className="mx-auto" />
            </button>
          </div>
        )}

        {scriptPopover && (
          <div
            ref={scriptPopoverRef}
            className="fixed z-30 -translate-x-1/2 -translate-y-full rounded-lg border border-slate-200 bg-white shadow-lg p-2 flex flex-wrap gap-1.5"
            style={{ left: scriptPopover.x, top: scriptPopover.y, maxWidth: `${SCRIPT_POPOVER_MAX_WIDTH_PX}px` }}
            tabIndex={0}
            role="dialog"
            aria-modal="false"
            aria-label="Script selection actions"
            aria-describedby="script-selection-actions-help"
          >
            <button
              onClick={() => handleScriptPopoverAction("word")}
              disabled={scriptPopover.selectedWordCount !== 1 || learningSaving}
              className="px-2 py-1 text-[11px] rounded border border-slate-300 disabled:opacity-40"
            >
              Save word
            </button>
            <button
              onClick={() => handleScriptPopoverAction("phrase")}
              disabled={scriptPopover.selectedWordCount < 2 || learningSaving}
              className="px-2 py-1 text-[11px] rounded border border-slate-300 disabled:opacity-40"
            >
              Save phrase
            </button>
            <button
              onClick={() => handleScriptPopoverAction("sentence")}
              disabled={learningSaving}
              className="px-2 py-1 text-[11px] rounded border border-slate-300"
            >
              Save sentence
            </button>
            <button
              onClick={() => handleScriptPopoverAction("explain")}
              className="px-2 py-1 text-[11px] rounded border border-violet-300 text-violet-700 bg-violet-50"
            >
              Explain
            </button>
            <button
              onClick={() => handleScriptPopoverAction("note")}
              className="px-2 py-1 text-[11px] rounded border border-slate-300"
            >
              Add note
            </button>
            {scriptPopoverNoteMode && (
              <div className="w-full pt-1 flex items-center gap-1.5">
                <input
                  ref={scriptPopoverNoteInputRef}
                  onChange={handleLearningNoteChange}
                  placeholder="Optional note"
                  className="flex-1 min-w-0 rounded border border-slate-300 px-2 py-1 text-[11px] outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                />
                <button
                  onClick={() => setScriptPopoverNoteMode(false)}
                  className="px-2 py-1 text-[11px] rounded border border-slate-300 text-slate-600"
                >
                  Done
                </button>
              </div>
            )}
            <span id="script-selection-actions-help" className="sr-only">
              Actions for selected script text: save word, phrase, sentence, explain, or add note.
            </span>
          </div>
        )}
      </main>

      {scriptShowAI && scriptPopover && (
        <div className="mx-auto w-full max-w-7xl px-4 lg:px-6 pb-4">
          <AIExplainer
            expectedText={scriptAiPayload.expectedText}
            userText={scriptAiPayload.userText}
            buttonLabel={scriptAiPayload.buttonLabel}
            onExplanationReady={setScriptAiReady}
          />
          {scriptAiReady && (
            <p className="mt-2 text-xs text-slate-500">
              Selection: <span className="font-medium text-slate-700">{scriptPopover.selectedText}</span>
            </p>
          )}
        </div>
      )}
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

function ControlButton({
  icon,
  shortcut,
  label,
  primary,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  shortcut: string;
  label: string;
  primary?: boolean;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col items-center gap-1 group">
      <button
        onClick={onClick}
        disabled={disabled}
        title={shortcut}
        className={`w-12 h-12 rounded-2xl flex items-center justify-center transition-all shadow-sm border border-white/60 dark:border-white/10 disabled:opacity-40 disabled:cursor-not-allowed ${primary ? "bg-indigo-600 text-white hover:bg-indigo-700 hover:shadow-md hover:-translate-y-0.5" : "bg-white/60 dark:bg-white/5 text-slate-700 dark:text-slate-300 hover:bg-white dark:hover:bg-white/10 hover:border-slate-300 dark:hover:border-slate-600"}`}
      >
        {icon}
      </button>
      <div className="opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center">
        <span className="text-[10px] font-semibold text-slate-400 dark:text-slate-500">{label}</span>
      </div>
    </div>
  );
}

function LessonSavedItemsList({
  items,
  compact = false,
  scrollClassName,
  deletingId,
  updatingId,
  onDelete,
  onUpdate,
}: {
  items: LessonSavedItem[];
  compact?: boolean;
  scrollClassName?: string;
  deletingId: string | null;
  updatingId: string | null;
  onDelete: (itemId: string) => void;
  onUpdate: (itemId: string, values: { term: string; sentenceContext: string; note: string }) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTerm, setEditingTerm] = useState("");
  const [editingSentenceContext, setEditingSentenceContext] = useState("");
  const [editingNote, setEditingNote] = useState("");

  const beginEdit = (item: LessonSavedItem) => {
    setEditingId(item.id);
    setEditingTerm(item.term);
    setEditingSentenceContext(item.sentence_context);
    setEditingNote(item.note ?? "");
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditingTerm("");
    setEditingSentenceContext("");
    setEditingNote("");
  };

  return (
    <div
      className={clsx(
        "flex flex-col gap-2 overflow-y-auto pr-1",
        compact && "pr-0",
        scrollClassName ?? "max-h-52"
      )}
    >
      {items.map((item) => (
        <div
          key={item.id}
          className={clsx(
            "rounded-lg border border-slate-200 bg-white p-3 flex flex-col gap-1",
            compact && "p-2 rounded-md"
          )}
        >
          <div className="flex items-center justify-between gap-2">
            <span className={clsx("text-sm text-slate-800", compact && "text-xs font-semibold")}>
              {item.term}
            </span>
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] uppercase tracking-wide rounded-full bg-indigo-100 text-indigo-700 px-2 py-0.5">
                {item.type}
              </span>
              {item.type === "word" && (
                <button
                  onClick={() => beginEdit(item)}
                  disabled={updatingId === item.id || deletingId === item.id}
                  className="h-5 px-1.5 rounded border border-slate-300 text-[10px] text-slate-600 hover:border-indigo-300 hover:text-indigo-700 disabled:opacity-40"
                  title="Edit saved word"
                  aria-label={`Edit saved word ${item.term}`}
                >
                  Edit
                </button>
              )}
              <button
                onClick={() => onDelete(item.id)}
                disabled={deletingId === item.id || updatingId === item.id}
                className="h-5 w-5 rounded-full border border-slate-300 text-slate-500 hover:text-red-600 hover:border-red-300 focus:text-red-600 focus:border-red-300 focus:outline-none focus:ring-2 focus:ring-red-200 disabled:opacity-40"
                aria-label={
                  deletingId === item.id
                    ? `Removing saved item ${item.term}`
                    : `Remove saved item ${item.term}`
                }
                aria-live="polite"
                title="Remove saved item"
              >
                {deletingId === item.id ? (
                  <svg
                    viewBox="0 0 20 20"
                    aria-hidden="true"
                    className="h-3.5 w-3.5 mx-auto animate-spin"
                  >
                    <circle
                      cx="10"
                      cy="10"
                      r="7"
                      fill="none"
                      stroke="currentColor"
                      strokeOpacity="0.25"
                      strokeWidth="2"
                    />
                    <path d="M10 3a7 7 0 0 1 7 7" fill="none" stroke="currentColor" strokeWidth="2" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 20 20" aria-hidden="true" className="h-3.5 w-3.5 mx-auto">
                    <path
                      d="M6 6l8 8M14 6l-8 8"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                    />
                  </svg>
                )}
              </button>
            </div>
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
          {editingId === item.id && (
            <div className="mt-1 flex flex-col gap-1.5">
              <input
                value={editingTerm}
                onChange={(e) => setEditingTerm(e.target.value)}
                className="rounded border border-slate-300 px-2 py-1 text-[11px]"
                placeholder="Saved text"
                aria-label="Edit saved text"
                autoFocus
              />
              <input
                value={editingSentenceContext}
                onChange={(e) => setEditingSentenceContext(e.target.value)}
                className="rounded border border-slate-300 px-2 py-1 text-[11px]"
                placeholder="Sentence context"
                aria-label="Edit sentence context"
              />
              <input
                value={editingNote}
                onChange={(e) => setEditingNote(e.target.value)}
                className="rounded border border-slate-300 px-2 py-1 text-[11px]"
                placeholder="Optional note"
                aria-label="Edit note"
              />
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => {
                    onUpdate(item.id, {
                      term: editingTerm,
                      sentenceContext: editingSentenceContext,
                      note: editingNote,
                    });
                  }}
                  disabled={updatingId === item.id}
                  className="rounded bg-indigo-600 px-2 py-1 text-[11px] font-medium text-white disabled:opacity-40"
                >
                  {updatingId === item.id ? "Saving…" : "Save"}
                </button>
                <button
                  onClick={cancelEdit}
                  disabled={updatingId === item.id}
                  className="rounded border border-slate-300 px-2 py-1 text-[11px] text-slate-600 disabled:opacity-40"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function ComparedSentenceText({
  tokens,
  tone,
  emptyFallback,
}: {
  tokens: ComparedToken[];
  tone: "expected" | "user";
  emptyFallback?: string;
}) {
  if (tokens.length === 0) {
    return <p className="mt-0.5 text-sm text-slate-500">{emptyFallback ?? ""}</p>;
  }

  return (
    <p
      className={clsx(
        "mt-0.5 text-sm select-text cursor-text rounded px-1 -mx-1",
        tone === "expected"
          ? "text-slate-900 hover:bg-emerald-100/60 focus:bg-emerald-100/60"
          : "text-slate-800 hover:bg-slate-200/70 focus:bg-slate-200/70"
      )}
    >
      {tokens.map((token, index) => (
        <span
          key={`${token.word}-${index}`}
          className={clsx(
            token.status === "missing" && "rounded bg-rose-100 px-0.5 text-rose-700",
            token.status === "wrong" && "rounded bg-amber-100 px-0.5 text-amber-700",
            token.status === "extra" && "rounded bg-violet-100 px-0.5 text-violet-700"
          )}
        >
          {token.word}
          {index < tokens.length - 1 ? " " : ""}
        </span>
      ))}
    </p>
  );
}
