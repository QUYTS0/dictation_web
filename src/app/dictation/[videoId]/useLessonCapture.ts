import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { User } from "@supabase/supabase-js";
import type { TranscriptSegment, VocabularyItem, VocabularyPreviewResponse } from "@/lib/types";
import { normalizeVocabularyTerm } from "@/lib/utils/vocabulary";
import {
  SCRIPT_POPOVER_MAX_SIDE_MARGIN_PX,
  SCRIPT_POPOVER_MIN_SIDE_MARGIN_PX,
  SCRIPT_POPOVER_VERTICAL_OFFSET_PX,
  SCRIPT_POPOVER_VIEWPORT_MARGIN_FACTOR,
} from "./constants";
import { getSelectedType, splitSentenceIntoWords, inferSavedItemType } from "./helpers";
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
 * selecting text to open the save popover, saving words/phrases/
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
  const [scriptPopoverPreview, setScriptPopoverPreview] = useState<VocabularyPreviewResponse | null>(null);
  const [scriptPopoverPreviewLoading, setScriptPopoverPreviewLoading] = useState(false);
  // True when the preview request itself failed (network error, rate limit,
  // or the server reporting translationFailed) — distinct from a clean
  // response that simply found nothing to show.
  const [scriptPopoverPreviewError, setScriptPopoverPreviewError] = useState(false);
  const [scriptPopoverNoteMode, setScriptPopoverNoteMode] = useState(false);
  const [scriptPopoverSavedFeedback, setScriptPopoverSavedFeedback] = useState<LessonItemType | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  // Intentionally ref-only: keeps typing smooth without rerendering the
  // entire lesson screen on every note keystroke.
  const learningNoteDraftRef = useRef("");
  const scriptPopoverNoteInputRef = useRef<HTMLInputElement>(null);
  const scriptTextContainerRef = useRef<HTMLDivElement>(null);
  const reviewTextContainerRef = useRef<HTMLDivElement>(null);
  const scriptPopoverRef = useRef<HTMLDivElement>(null);
  const scriptPopoverSavedFeedbackTimeoutRef = useRef<number | null>(null);
  // A pending delete is finalized after a grace period (see
  // requestDeleteLessonCapture); these mirror pendingDeleteId so cleanup
  // effects can read the latest value without depending on the state itself.
  const pendingDeleteTimeoutRef = useRef<number | null>(null);
  const pendingDeleteIdRef = useRef<string | null>(null);
  useEffect(() => {
    pendingDeleteIdRef.current = pendingDeleteId;
  }, [pendingDeleteId]);
  // Latest-callback refs so a failed action's retry closure (built inside the
  // action's own catch block) can call the current implementation without a
  // temporal-dead-zone self-reference.
  const saveLessonCaptureAtSegmentRef = useRef<
    (
      text: string,
      type: LessonItemType,
      segmentIndex: number,
      sentenceContext: string,
      preview?: VocabularyPreviewResponse | null
    ) => void
  >(() => {});
  const deleteLessonCaptureRef = useRef<(itemId: string) => void>(() => {});
  const updateLessonCaptureRef = useRef<
    (
      itemId: string,
      values: {
        term: string;
        sentenceContext: string;
        note: string;
        translation: string;
        phonetic: string;
        partOfSpeech: string;
        definition: string;
      }
    ) => void
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

  // Excludes an item that's either still in its post-delete undo grace
  // period (pendingDeleteId) or whose grace period just ended and whose real
  // DELETE is now in flight (learningDeletingId) — without the second check,
  // the item would flash back into the list for the moment between the
  // grace period ending and the fetch actually resolving.
  const lessonSavedInCurrentVideo = useMemo(
    () =>
      learningItems.filter(
        (item) => item.video_id === videoId && item.id !== pendingDeleteId && item.id !== learningDeletingId
      ),
    [learningItems, videoId, pendingDeleteId, learningDeletingId]
  );
  const filteredSavedItems = useMemo(() => {
    if (savedFilter === "all") return lessonSavedInCurrentVideo;
    return lessonSavedInCurrentVideo.filter((item) => item.type === savedFilter);
  }, [lessonSavedInCurrentVideo, savedFilter]);

  const pendingDeleteItem = useMemo(
    () => (pendingDeleteId ? (learningItems.find((item) => item.id === pendingDeleteId) ?? null) : null),
    [learningItems, pendingDeleteId]
  );

  // Case/punctuation-insensitive match (same normalizeVocabularyTerm the
  // backend dedupes with, see POST /api/vocabulary) against ANY segment in
  // this video, not just the one currently selected — the point is "have I
  // already saved this word", which doesn't depend on which sentence it
  // showed up in this time. Saving again still works normally: the backend
  // dedupes per-segment, so a match in a different segment just creates a
  // second row scoped to that sentence rather than blocking anything.
  const scriptPopoverSavedItem = useMemo(() => {
    if (!scriptPopover) return null;
    const normalized = normalizeVocabularyTerm(scriptPopover.selectedText);
    if (!normalized) return null;
    return lessonSavedInCurrentVideo.find((item) => item.normalized_term === normalized) ?? null;
  }, [lessonSavedInCurrentVideo, scriptPopover]);

  const handleLearningNoteChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    learningNoteDraftRef.current = event.target.value;
  }, []);

  const clearLearningNoteInputs = useCallback(() => {
    learningNoteDraftRef.current = "";
    if (scriptPopoverNoteInputRef.current) scriptPopoverNoteInputRef.current.value = "";
  }, []);

  const clearScriptSelection = useCallback(() => {
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) selection.removeAllRanges();
    setScriptPopover(null);
  }, []);

  const clearScriptPopoverSavedFeedback = useCallback(() => {
    if (scriptPopoverSavedFeedbackTimeoutRef.current !== null) {
      window.clearTimeout(scriptPopoverSavedFeedbackTimeoutRef.current);
      scriptPopoverSavedFeedbackTimeoutRef.current = null;
    }
    setScriptPopoverSavedFeedback(null);
  }, []);

  // Dismissing the popover without saving invalidates any note draft typed
  // for it — otherwise a note started for one selection can silently leak
  // onto a later, unrelated save (the draft lives in a ref so it survives
  // on its own). NOT used from the save action itself: an unauthenticated
  // save defers through the auth modal, and the draft must still be there
  // when that deferred save finally runs.
  const dismissScriptSelection = useCallback(() => {
    clearScriptSelection();
    clearLearningNoteInputs();
    clearScriptPopoverSavedFeedback();
  }, [clearScriptSelection, clearLearningNoteInputs, clearScriptPopoverSavedFeedback]);

  useEffect(() => {
    if (showScriptContext) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    dismissScriptSelection();
    setScriptPopoverNoteMode(false);
  }, [dismissScriptSelection, showScriptContext]);

  const saveLessonCaptureAtSegment = useCallback(
    (
      text: string,
      type: LessonItemType,
      segmentIndex: number,
      sentenceContext: string,
      preview?: VocabularyPreviewResponse | null
    ) => {
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
            translation: preview?.translation?.text,
            translationSource: preview?.translation?.source,
            phonetic: preview?.wordDetails?.phonetic ?? undefined,
            partOfSpeech: preview?.wordDetails?.partOfSpeech ?? undefined,
            definition: preview?.wordDetails?.definition ?? undefined,
            definitionSource: preview?.wordDetails?.source,
            imageUrl: preview?.image?.url,
            imageThumbnailUrl: preview?.image?.thumbnailUrl,
            imageAttribution: preview?.image?.attribution,
            imageSourceUrl: preview?.image?.sourceUrl,
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
            // Show a brief confirmation in the popover instead of vanishing
            // instantly — word/phrase then auto-close; sentence stays open
            // (matches the "keep selecting from here" flow for sentences).
            setScriptPopoverSavedFeedback(type);
            if (scriptPopoverSavedFeedbackTimeoutRef.current !== null) {
              window.clearTimeout(scriptPopoverSavedFeedbackTimeoutRef.current);
            }
            scriptPopoverSavedFeedbackTimeoutRef.current = window.setTimeout(() => {
              scriptPopoverSavedFeedbackTimeoutRef.current = null;
              setScriptPopoverSavedFeedback(null);
              if (type !== "sentence") {
                clearScriptSelection();
              }
            }, 700);
          })
          .catch((err: unknown) => {
            const message =
              err instanceof Error && err.message
                ? err.message
                : "Failed to save learning item. Please try again.";
            setLearningError(message);
            setLearningErrorRetry(
              () => () =>
                saveLessonCaptureAtSegmentRef.current(text, type, segmentIndex, sentenceContext, preview)
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

  // The actual network delete. Not called directly from the UI — reached
  // either after the undo grace period elapses (requestDeleteLessonCapture)
  // or immediately when a second delete supersedes a still-pending one.
  const finalizeDelete = useCallback(
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
    deleteLessonCaptureRef.current = finalizeDelete;
  }, [finalizeDelete]);

  // Optimistically hides the item (via pendingDeleteId, filtered out of
  // lessonSavedInCurrentVideo above) and only calls the real DELETE after a
  // grace period, so "Undo" needs no network round-trip and can't lose data
  // to a partial re-create. Only one delete can be pending at a time; a
  // second delete finalizes whichever was already pending immediately
  // instead of dropping it, keeping the undo toast to a single item.
  const requestDeleteLessonCapture = useCallback((itemId: string) => {
    if (pendingDeleteTimeoutRef.current !== null) {
      window.clearTimeout(pendingDeleteTimeoutRef.current);
      pendingDeleteTimeoutRef.current = null;
    }
    const previousPendingId = pendingDeleteIdRef.current;
    if (previousPendingId && previousPendingId !== itemId) {
      deleteLessonCaptureRef.current(previousPendingId);
    }
    setPendingDeleteId(itemId);
    pendingDeleteTimeoutRef.current = window.setTimeout(() => {
      pendingDeleteTimeoutRef.current = null;
      setPendingDeleteId(null);
      deleteLessonCaptureRef.current(itemId);
    }, 5000);
  }, []);

  const undoDeleteLessonCapture = useCallback(() => {
    if (pendingDeleteTimeoutRef.current !== null) {
      window.clearTimeout(pendingDeleteTimeoutRef.current);
      pendingDeleteTimeoutRef.current = null;
    }
    setPendingDeleteId(null);
  }, []);

  // Navigating away with a delete still pending shouldn't silently undo the
  // user's action — finalize it rather than losing it.
  useEffect(() => {
    return () => {
      if (pendingDeleteTimeoutRef.current !== null) {
        window.clearTimeout(pendingDeleteTimeoutRef.current);
        pendingDeleteTimeoutRef.current = null;
        if (pendingDeleteIdRef.current) deleteLessonCaptureRef.current(pendingDeleteIdRef.current);
      }
    };
  }, []);

  const updateLessonCapture = useCallback(
    (
      itemId: string,
      values: {
        term: string;
        sentenceContext: string;
        note: string;
        translation: string;
        phonetic: string;
        partOfSpeech: string;
        definition: string;
      }
    ) => {
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
            translation: values.translation,
            phonetic: values.phonetic,
            partOfSpeech: values.partOfSpeech,
            definition: values.definition,
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
        clearLearningNoteInputs();
        clearScriptPopoverSavedFeedback();
        return;
      }

      const selectedText = selection.toString().replace(/\s+/g, " ").trim();
      if (!selectedText) {
        setScriptPopover(null);
        clearLearningNoteInputs();
        clearScriptPopoverSavedFeedback();
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

      setScriptPopoverNoteMode(false);
      clearLearningNoteInputs();
      clearScriptPopoverSavedFeedback();
      setScriptPopover({
        segmentIndex,
        selectedText,
        selectedWordCount,
        sentenceText,
        x,
        y,
      });
    },
    [clearLearningNoteInputs, clearScriptPopoverSavedFeedback, segmentsByIndex]
  );

  const handleScriptMouseUp = useCallback(() => {
    handleSelectionMouseUp(scriptTextContainerRef.current);
  }, [handleSelectionMouseUp]);

  const handleReviewMouseUp = useCallback(() => {
    handleSelectionMouseUp(reviewTextContainerRef.current);
  }, [handleSelectionMouseUp]);

  /**
   * A tap (no drag) on a single word should always select just that word,
   * without needing pixel-precise dragging. If the browser already produced
   * a real drag selection by the time this fires (mouseup happens after the
   * selection has already been extended), leave it alone and let the
   * container's own mouseup handler process it normally — this is what
   * keeps multi-word phrase/sentence dragging working unchanged.
   */
  const handleWordMouseUp = useCallback(
    (event: React.MouseEvent<HTMLSpanElement>, container: HTMLDivElement | null) => {
      const selection = window.getSelection();
      const isDragSelection = Boolean(selection && !selection.isCollapsed && selection.toString().trim());
      if (isDragSelection) return;

      event.stopPropagation();
      const span = event.currentTarget;
      const range = document.createRange();
      range.selectNodeContents(span);
      selection?.removeAllRanges();
      selection?.addRange(range);
      handleSelectionMouseUp(container);
    },
    [handleSelectionMouseUp]
  );

  const handleScriptWordMouseUp = useCallback(
    (event: React.MouseEvent<HTMLSpanElement>) => {
      handleWordMouseUp(event, scriptTextContainerRef.current);
    },
    [handleWordMouseUp]
  );

  // Live translation/dictionary preview for whatever's currently selected —
  // shown in the popover before the user decides to save anything. Debounced
  // and abortable so rapidly tapping across several words doesn't pile up
  // stale requests.
  useEffect(() => {
    if (!scriptPopover) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setScriptPopoverPreview(null);
      setScriptPopoverPreviewLoading(false);
      setScriptPopoverPreviewError(false);
      return;
    }

    const controller = new AbortController();
    setScriptPopoverPreview(null);
    setScriptPopoverPreviewLoading(true);
    setScriptPopoverPreviewError(false);

    const timer = window.setTimeout(() => {
      void fetch("/api/vocabulary/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: scriptPopover.selectedText,
          isWord: scriptPopover.selectedWordCount === 1,
        }),
        signal: controller.signal,
      })
        .then((res) => (res.ok ? (res.json() as Promise<VocabularyPreviewResponse>) : Promise.reject(res)))
        .then((data: VocabularyPreviewResponse) => {
          setScriptPopoverPreview(data);
          setScriptPopoverPreviewError(Boolean(data.translationFailed));
        })
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === "AbortError") return;
          setScriptPopoverPreview(null);
          setScriptPopoverPreviewError(true);
        })
        .finally(() => setScriptPopoverPreviewLoading(false));
    }, 150);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [scriptPopover]);

  const handleScriptPopoverAction = useCallback(
    (type: "word" | "phrase" | "sentence" | "note") => {
      if (!scriptPopover) return;
      const segment = segmentsByIndex.get(scriptPopover.segmentIndex);
      if (!segment) return;

      if (type === "note") {
        setScriptPopoverNoteMode(true);
        window.setTimeout(() => scriptPopoverNoteInputRef.current?.focus(), 10);
        return;
      }

      setScriptPopoverNoteMode(false);
      const textToSave = type === "sentence" ? segment.text : scriptPopover.selectedText;
      // Only reuse the preview when it was fetched for exactly this text —
      // "Save sentence" ignores the selection and saves the whole segment,
      // which only matches the preview if the whole segment was selected.
      const previewMatchesSave = textToSave.trim() === scriptPopover.selectedText.trim();
      // Closing (or not, for sentences) is handled by the save's success
      // handler after a brief "Saved" confirmation — see
      // saveLessonCaptureAtSegment.
      void saveLessonCaptureAtSegment(
        textToSave,
        type,
        segment.segmentIndex,
        segment.text,
        previewMatchesSave ? scriptPopoverPreview : null
      );
    },
    [saveLessonCaptureAtSegment, scriptPopover, scriptPopoverPreview, segmentsByIndex]
  );

  useEffect(() => {
    clearLearningNoteInputs();
  }, [clearLearningNoteInputs, currentSegIdx, currentSegmentText]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    dismissScriptSelection();
    setScriptPopoverNoteMode(false);
    // A pending delete belongs to the video being left — finalize it rather
    // than silently dropping it just because the user navigated away during
    // the undo grace period.
    if (pendingDeleteTimeoutRef.current !== null) {
      window.clearTimeout(pendingDeleteTimeoutRef.current);
      pendingDeleteTimeoutRef.current = null;
      if (pendingDeleteIdRef.current) deleteLessonCaptureRef.current(pendingDeleteIdRef.current);
      setPendingDeleteId(null);
    }
  }, [dismissScriptSelection, videoId]);

  useEffect(() => {
    if (!scriptPopover) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        dismissScriptSelection();
        setScriptPopoverNoteMode(false);
      }
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [dismissScriptSelection, scriptPopover]);

  // W/P/S quick-save shortcuts while the popover is open. Guarded against
  // typing targets (the note <input> lives inside this same popover and
  // accepts those letters as text) and against note mode generally, in case
  // focus isn't literally on the input.
  useEffect(() => {
    if (!scriptPopover) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target;
      const isTypingTarget =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable);
      if (isTypingTarget || scriptPopoverNoteMode) return;

      const key = e.key.toLowerCase();
      if (key === "w" && scriptPopover.selectedWordCount === 1) {
        e.preventDefault();
        handleScriptPopoverAction("word");
      } else if (key === "p" && scriptPopover.selectedWordCount >= 2) {
        e.preventDefault();
        handleScriptPopoverAction("phrase");
      } else if (key === "s") {
        e.preventDefault();
        handleScriptPopoverAction("sentence");
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [scriptPopover, scriptPopoverNoteMode, handleScriptPopoverAction]);

  // Otherwise the popover stays open indefinitely once the user clicks
  // anywhere that isn't itself (the video, sidebar, background, etc.).
  useEffect(() => {
    if (!scriptPopover) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (scriptPopoverRef.current?.contains(event.target as Node)) return;
      dismissScriptSelection();
    };
    window.addEventListener("mousedown", handlePointerDown);
    return () => window.removeEventListener("mousedown", handlePointerDown);
  }, [dismissScriptSelection, scriptPopover]);

  // The popover's x/y is captured once from the selection's bounding rect at
  // mouseup time and never recomputed, so scrolling the transcript panel (or
  // the page) leaves it floating over the wrong line. Capture-phase so it
  // also catches scroll on nested scrollable containers, which don't bubble.
  useEffect(() => {
    if (!scriptPopover) return;
    const handleScroll = () => dismissScriptSelection();
    window.addEventListener("scroll", handleScroll, { capture: true, passive: true });
    return () => window.removeEventListener("scroll", handleScroll, { capture: true });
  }, [dismissScriptSelection, scriptPopover]);

  useEffect(() => {
    if (scriptPopover) {
      scriptPopoverRef.current?.focus();
      return;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setScriptPopoverNoteMode(false);
  }, [scriptPopover]);

  const scriptSelectedType = getSelectedType(scriptPopover?.selectedWordCount ?? 0);

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
    scriptPopoverPreview,
    scriptPopoverPreviewLoading,
    scriptPopoverPreviewError,
    scriptPopoverSavedItem,
    scriptPopoverSavedFeedback,
    scriptPopoverNoteMode,
    setScriptPopoverNoteMode,
    scriptSelectedType,
    scriptPopoverNoteInputRef,
    scriptTextContainerRef,
    reviewTextContainerRef,
    scriptPopoverRef,
    clearScriptSelection,
    handleLearningNoteChange,
    saveLessonCaptureAtSegment,
    pendingDeleteItem,
    requestDeleteLessonCapture,
    undoDeleteLessonCapture,
    updateLessonCapture,
    handleScriptMouseUp,
    handleReviewMouseUp,
    handleScriptWordMouseUp,
    handleScriptPopoverAction,
  };
}
