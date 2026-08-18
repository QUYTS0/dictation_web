import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { User } from "@supabase/supabase-js";
import type { TranscriptSegment, VocabularyItem } from "@/lib/types";
import {
  SCRIPT_POPOVER_MAX_SIDE_MARGIN_PX,
  SCRIPT_POPOVER_MIN_SIDE_MARGIN_PX,
  SCRIPT_POPOVER_VERTICAL_OFFSET_PX,
  SCRIPT_POPOVER_VIEWPORT_MARGIN_FACTOR,
} from "./constants";
import {
  getSelectedType,
  splitSentenceIntoWords,
  inferSavedItemType,
  buildAiExplainPayload,
} from "./helpers";
import type { LessonItemType, LessonSavedItem, SavedFilter, ScriptSelectionPopoverState } from "./types";

interface UseLessonCaptureOptions {
  videoId: string;
  user: User | null;
  requireAuth: (callback: () => void) => void;
  segments: TranscriptSegment[];
  currentSegIdx: number;
  currentSegmentText: string | undefined;
  showScriptContext: boolean;
  /** Called after any successful save (e.g. to reveal the lesson panel). */
  onAfterSave: () => void;
}

/**
 * Everything related to capturing vocabulary from the transcript script:
 * selecting text to open the save/explain popover, saving words/phrases/
 * sentences (with an optional note) to the vocabulary bank, and managing
 * the saved-items list for the current video. The popover and the saved
 * list are two ends of the same feature (selecting text saves into the
 * list), so they're kept together rather than split further.
 */
export function useLessonCapture({
  videoId,
  user,
  requireAuth,
  segments,
  currentSegIdx,
  currentSegmentText,
  showScriptContext,
  onAfterSave,
}: UseLessonCaptureOptions) {
  const [learningItems, setLearningItems] = useState<LessonSavedItem[]>([]);
  const [learningError, setLearningError] = useState<string | null>(null);
  const [learningErrorRetry, setLearningErrorRetry] = useState<(() => void) | null>(null);
  const [learningSaving, setLearningSaving] = useState(false);
  const [learningDeletingId, setLearningDeletingId] = useState<string | null>(null);
  const [learningUpdatingId, setLearningUpdatingId] = useState<string | null>(null);
  const [savedFilter, setSavedFilter] = useState<SavedFilter>("all");
  const [scriptPopover, setScriptPopover] = useState<ScriptSelectionPopoverState | null>(null);
  const [scriptShowAI, setScriptShowAI] = useState(false);
  const [scriptAiReady, setScriptAiReady] = useState(false);
  const [scriptPopoverNoteMode, setScriptPopoverNoteMode] = useState(false);

  // Intentionally ref-only: keeps typing smooth without rerendering the
  // entire lesson screen on every note keystroke.
  const learningNoteDraftRef = useRef("");
  const scriptPopoverNoteInputRef = useRef<HTMLInputElement>(null);
  const scriptTextContainerRef = useRef<HTMLDivElement>(null);
  const reviewTextContainerRef = useRef<HTMLDivElement>(null);
  const scriptPopoverRef = useRef<HTMLDivElement>(null);
  // Latest-callback refs so a failed action's retry closure (built inside the
  // action's own catch block) can call the current implementation without a
  // temporal-dead-zone self-reference.
  const saveLessonCaptureAtSegmentRef = useRef<
    (text: string, type: LessonItemType, segmentIndex: number, sentenceContext: string) => void
  >(() => {});
  const deleteLessonCaptureRef = useRef<(itemId: string) => void>(() => {});
  const updateLessonCaptureRef = useRef<
    (itemId: string, values: { term: string; sentenceContext: string; note: string }) => void
  >(() => {});
  const fetchSavedItemsRef = useRef<() => void>(() => {});

  const segmentsByIndex = useMemo(
    () => new Map(segments.map((segment) => [segment.segmentIndex, segment])),
    [segments]
  );

  // ---- Load saved vocabulary for this video ----
  const fetchSavedItems = useCallback(() => {
    let isCancelled = false;
    setLearningError(null);
    setLearningErrorRetry(null);

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
        setLearningErrorRetry(() => () => fetchSavedItemsRef.current());
      });

    return () => {
      isCancelled = true;
    };
  }, [videoId]);
  useEffect(() => {
    fetchSavedItemsRef.current = fetchSavedItems;
  }, [fetchSavedItems]);

  useEffect(() => {
    if (!user) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLearningItems([]);
      return;
    }
    return fetchSavedItems();
  }, [user, videoId, fetchSavedItems]);

  const lessonSavedInCurrentVideo = useMemo(
    () => learningItems.filter((item) => item.video_id === videoId),
    [learningItems, videoId]
  );
  const filteredSavedItems = useMemo(() => {
    if (savedFilter === "all") return lessonSavedInCurrentVideo;
    return lessonSavedInCurrentVideo.filter((item) => item.type === savedFilter);
  }, [lessonSavedInCurrentVideo, savedFilter]);

  const clearScriptSelection = useCallback(() => {
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) selection.removeAllRanges();
    setScriptPopover(null);
  }, []);

  useEffect(() => {
    if (showScriptContext) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    clearScriptSelection();
    setScriptPopoverNoteMode(false);
    setScriptShowAI(false);
    setScriptAiReady(false);
  }, [clearScriptSelection, showScriptContext]);

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
        setLearningErrorRetry(null);
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
            onAfterSave();
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
            setLearningErrorRetry(
              () => () => saveLessonCaptureAtSegmentRef.current(text, type, segmentIndex, sentenceContext)
            );
          })
          .finally(() => {
            setLearningSaving(false);
          });
      });
    },
    [clearLearningNoteInputs, clearScriptSelection, onAfterSave, requireAuth, videoId]
  );
  useEffect(() => {
    saveLessonCaptureAtSegmentRef.current = saveLessonCaptureAtSegment;
  }, [saveLessonCaptureAtSegment]);

  const deleteLessonCapture = useCallback(
    (itemId: string) => {
      requireAuth(() => {
        setLearningDeletingId(itemId);
        setLearningError(null);
        setLearningErrorRetry(null);
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
            setLearningErrorRetry(() => () => deleteLessonCaptureRef.current(itemId));
          })
          .finally(() => {
            setLearningDeletingId(null);
          });
      });
    },
    [requireAuth]
  );
  useEffect(() => {
    deleteLessonCaptureRef.current = deleteLessonCapture;
  }, [deleteLessonCapture]);

  const updateLessonCapture = useCallback(
    (itemId: string, values: { term: string; sentenceContext: string; note: string }) => {
      const nextTerm = values.term.trim();
      const nextSentenceContext = values.sentenceContext.trim();
      requireAuth(() => {
        setLearningUpdatingId(itemId);
        setLearningError(null);
        setLearningErrorRetry(null);
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
            setLearningErrorRetry(() => () => updateLessonCaptureRef.current(itemId, values));
          })
          .finally(() => {
            setLearningUpdatingId(null);
          });
      });
    },
    [requireAuth]
  );
  useEffect(() => {
    updateLessonCaptureRef.current = updateLessonCapture;
  }, [updateLessonCapture]);

  const handleSelectionMouseUp = useCallback(
    (container: HTMLDivElement | null) => {
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
    },
    [segmentsByIndex]
  );

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
      const textToSave = type === "sentence" ? segment.text : scriptPopover.selectedText;
      void saveLessonCaptureAtSegment(textToSave, type, segment.segmentIndex, segment.text);
      clearScriptSelection();
      setScriptShowAI(false);
    },
    [clearScriptSelection, saveLessonCaptureAtSegment, scriptPopover, segmentsByIndex]
  );

  useEffect(() => {
    clearLearningNoteInputs();
  }, [clearLearningNoteInputs, currentSegIdx, currentSegmentText]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    clearScriptSelection();
    setScriptShowAI(false);
    setScriptAiReady(false);
    setScriptPopoverNoteMode(false);
  }, [clearScriptSelection, videoId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setScriptPopoverNoteMode(false);
  }, [scriptPopover]);

  const scriptSelectedType = getSelectedType(scriptPopover?.selectedWordCount ?? 0);
  const scriptAiPayload = buildAiExplainPayload({
    selectedType: scriptSelectedType,
    selectedText: scriptPopover?.selectedText ?? "",
    sentenceText: scriptPopover?.sentenceText ?? "",
    userText: scriptPopover?.selectedText ?? "",
  });

  return {
    learningItems,
    learningError,
    learningErrorRetry,
    learningSaving,
    learningDeletingId,
    learningUpdatingId,
    savedFilter,
    setSavedFilter,
    lessonSavedInCurrentVideo,
    filteredSavedItems,
    scriptPopover,
    scriptShowAI,
    scriptAiReady,
    setScriptAiReady,
    scriptPopoverNoteMode,
    setScriptPopoverNoteMode,
    scriptSelectedType,
    scriptAiPayload,
    scriptPopoverNoteInputRef,
    scriptTextContainerRef,
    reviewTextContainerRef,
    scriptPopoverRef,
    clearScriptSelection,
    handleLearningNoteChange,
    saveLessonCaptureAtSegment,
    deleteLessonCapture,
    updateLessonCapture,
    handleScriptMouseUp,
    handleReviewMouseUp,
    handleScriptPopoverAction,
  };
}
