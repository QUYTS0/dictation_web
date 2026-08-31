"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { clsx } from "clsx";
import { Eye } from "lucide-react";
import type { TranscriptSegment, VocabHighlightPhrase } from "@/lib/types";
import { buildScriptRenderItems, formatSegmentTimestamp } from "../helpers";
import type { InputMode } from "../types";

// Keeps the active sentence anchored just below the previous one instead of
// letting it drift to wherever scrollIntoView last landed it.
const SCRIPT_ANCHOR_TOP_PADDING = 8;

function computeAnchoredScrollTop(container: HTMLElement, activeCard: HTMLElement): number {
  const anchorCard = (activeCard.previousElementSibling as HTMLElement | null) ?? activeCard;
  const target = anchorCard.offsetTop - SCRIPT_ANCHOR_TOP_PADDING;
  const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
  return Math.min(Math.max(target, 0), maxScrollTop);
}

export function ScriptTab({
  scriptSegments,
  currentSegIdx,
  inputMode,
  onSeekToSegment,
  translationBySegmentIndex,
  scriptTranslationLoading,
  scriptTranslationError,
  phrasesBySegmentIndex,
  vocabHighlightsError,
  learningError,
  learningErrorRetry,
  scriptTextContainerRef,
  handleScriptMouseUp,
  handleScriptWordMouseUp,
  handlePhraseMouseEnter,
  handlePhraseMouseLeave,
  handlePhraseTap,
}: {
  scriptSegments: TranscriptSegment[];
  currentSegIdx: number;
  inputMode: InputMode;
  onSeekToSegment: (segmentIndex: number) => void;
  translationBySegmentIndex: Map<number, string>;
  scriptTranslationLoading: boolean;
  scriptTranslationError: boolean;
  phrasesBySegmentIndex: Map<number, VocabHighlightPhrase[]>;
  vocabHighlightsError: boolean;
  learningError: string | null;
  learningErrorRetry: (() => void) | null;
  scriptTextContainerRef: React.RefObject<HTMLDivElement | null>;
  handleScriptMouseUp: (event: React.MouseEvent<HTMLDivElement>) => void;
  handleScriptWordMouseUp: (event: React.MouseEvent<HTMLSpanElement>) => void;
  handlePhraseMouseEnter: (event: React.MouseEvent<HTMLSpanElement>, segmentIndex: number, text: string) => void;
  handlePhraseMouseLeave: () => void;
  handlePhraseTap: (event: React.MouseEvent<HTMLButtonElement>, segmentIndex: number, text: string) => void;
}) {
  const isDictationMode = inputMode === "dictation";
  // Dictation Mode only: the currently-active sentence is blurred until
  // tapped, so the answer isn't readable here while it's still meant to be
  // typed from listening. Revealed once, it stays revealed for the session.
  // Listening Mode never blurs — the transcript is meant to be read.
  const [revealedSegmentIndexes, setRevealedSegmentIndexes] = useState<Set<number>>(new Set());
  const revealSegment = (segmentIndex: number) =>
    setRevealedSegmentIndexes((prev) => new Set(prev).add(segmentIndex));

  // First layout after this component (re)mounts — e.g. switching tabs back to
  // Script, or reopening the right panel — snaps to the anchored position with
  // no animation so the user never sees a scroll-from-the-top flash. Every
  // later run (plain sentence navigation while already mounted) animates.
  const hasPositionedRef = useRef(false);
  useLayoutEffect(() => {
    const container = scriptTextContainerRef.current;
    if (!container) return;
    const activeCard = container.querySelector<HTMLElement>(
      `[data-script-segment-index="${currentSegIdx}"]`
    );
    if (!activeCard) return;
    const target = computeAnchoredScrollTop(container, activeCard);
    if (!hasPositionedRef.current) {
      container.scrollTop = target;
      hasPositionedRef.current = true;
    } else {
      container.scrollTo({ top: target, behavior: "smooth" });
    }
  }, [currentSegIdx, scriptSegments.length, scriptTextContainerRef]);

  return (
    <>
      {scriptTranslationLoading && (
        <p className="text-xs text-[var(--text-muted)]">Translating…</p>
      )}
      {scriptTranslationError && (
        <p className="text-xs text-[var(--red)]">Couldn&apos;t load translation.</p>
      )}
      {vocabHighlightsError && (
        <p className="text-xs text-[var(--text-faint)]">Vocab highlighting is unavailable right now.</p>
      )}
      {scriptSegments.length === 0 ? (
        <p className="text-xs text-[var(--text-muted)]">Script is not available yet.</p>
      ) : (
        <div
          ref={scriptTextContainerRef}
          onMouseUp={handleScriptMouseUp}
          className="script-scrollbar relative flex flex-col gap-2 pr-1 text-sm lg:min-h-0 lg:flex-1 lg:overflow-y-auto"
        >
          {scriptSegments.map((segment) => {
            const isCurrentScriptSentence = segment.segmentIndex === currentSegIdx;
            const isPreviousScriptSentence = segment.segmentIndex < currentSegIdx;
            const isBlurred =
              isDictationMode && isCurrentScriptSentence && !revealedSegmentIndexes.has(segment.segmentIndex);
            const scriptRenderItems = buildScriptRenderItems(
              segment.text,
              phrasesBySegmentIndex.get(segment.segmentIndex) ?? []
            );
            return (
              <div
                key={segment.segmentIndex}
                data-script-segment-index={segment.segmentIndex}
                data-selection-sentence-text={segment.text}
                onClick={() => onSeekToSegment(segment.segmentIndex)}
                title={`Play from sentence ${segment.segmentIndex + 1}`}
                className={`relative p-2.5 rounded-xl border transition-colors cursor-pointer ${
                  isCurrentScriptSentence
                    ? "bg-[var(--accent-soft)] border-[var(--accent-border)] ring-2 ring-[var(--accent)]/20 shadow-sm"
                    : "bg-transparent border-transparent hover:bg-white/[0.04] hover:border-[var(--border)]"
                }`}
              >
                {isBlurred && (
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      revealSegment(segment.segmentIndex);
                    }}
                    className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-black/40 backdrop-blur-[1px]"
                    aria-label={`Reveal sentence ${segment.segmentIndex + 1}`}
                  >
                    <span className="flex items-center gap-1.5 rounded-full border border-[var(--border-strong)] bg-[var(--surface)] px-3 py-1 text-[11px] font-semibold text-[var(--text-muted)] shadow-sm">
                      <Eye size={12} /> Tap to reveal
                    </span>
                  </button>
                )}
                <div className={clsx(isBlurred && "select-none blur-sm")}>
                  <div
                    className={`text-xs font-bold mb-0.5 flex items-center justify-between gap-2 ${
                      isCurrentScriptSentence
                        ? "text-[var(--accent)]"
                        : isPreviousScriptSentence
                        ? "text-[var(--green)]"
                        : "text-[var(--text-faint)]"
                    }`}
                  >
                    <span className="flex items-center gap-1.5 uppercase tracking-widest text-[9px]">
                      <span className="tabular-nums">{formatSegmentTimestamp(segment.start)}</span>
                      <span>·</span>
                      <span>Sentence #{segment.segmentIndex + 1}</span>
                    </span>
                    {isCurrentScriptSentence && <div className="w-2 h-2 rounded-full bg-[var(--accent)] animate-pulse shrink-0" />}
                  </div>
                  <p
                    className={`text-sm leading-relaxed select-text ${
                      isCurrentScriptSentence ? "text-[var(--text)] font-medium" : "text-[var(--text-muted)]"
                    }`}
                  >
                    {scriptRenderItems.map((item) => {
                      if (item.kind === "space") return item.text;
                      if (item.kind === "phrase") {
                        return (
                          <span key={item.key} className="whitespace-nowrap">
                            <span
                              onMouseUp={handleScriptWordMouseUp}
                              onMouseEnter={(event) => handlePhraseMouseEnter(event, segment.segmentIndex, item.text)}
                              onMouseLeave={handlePhraseMouseLeave}
                              onClick={(event) => event.stopPropagation()}
                              title="Hover or tap to see the meaning"
                              className="cursor-pointer rounded px-0.5 -mx-0.5 underline decoration-[var(--accent)] decoration-2 underline-offset-2 [text-decoration-skip-ink:none] transition-colors hover:bg-[var(--accent-soft)]"
                            >
                              {item.text}
                            </span>
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                handlePhraseTap(event, segment.segmentIndex, item.text);
                              }}
                              aria-label={`Show meaning of "${item.text}"`}
                              className="sm:hidden ml-0.5 inline-flex h-4 w-4 items-center justify-center align-super text-[10px] leading-none text-[var(--accent)]"
                            >
                              ⓘ
                            </button>
                          </span>
                        );
                      }
                      return (
                        <span
                          key={item.key}
                          onMouseUp={handleScriptWordMouseUp}
                          onClick={(event) => event.stopPropagation()}
                          title="Tap to save this word/phrase"
                          className="cursor-pointer rounded px-0.5 -mx-0.5 transition-colors hover:bg-white/10"
                        >
                          {item.text}
                        </span>
                      );
                    })}
                  </p>
                  <p className="mt-0.5 text-sm leading-relaxed text-[var(--accent-muted)]">
                    {translationBySegmentIndex.get(segment.segmentIndex) ?? "…"}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {learningError && (
        <p role="alert" className="flex items-center gap-2 text-xs text-[var(--red)]">
          {learningError}
          {learningErrorRetry && (
            <button
              type="button"
              onClick={() => learningErrorRetry()}
              className="font-semibold underline text-[var(--red)] hover:brightness-110"
            >
              Retry
            </button>
          )}
        </p>
      )}
    </>
  );
}
