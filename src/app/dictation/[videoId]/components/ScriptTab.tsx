"use client";

import { useState } from "react";
import { clsx } from "clsx";
import { Eye } from "lucide-react";
import type { TranscriptSegment, VocabHighlightPhrase } from "@/lib/types";
import { buildScriptRenderItems } from "../helpers";

export function ScriptTab({
  scriptContextSegments,
  currentSegIdx,
  showScriptContext,
  setShowScriptContext,
  showPreviousScriptContext,
  setShowPreviousScriptContext,
  showScriptTranslation,
  setShowScriptTranslation,
  translationBySegmentIndex,
  scriptTranslationLoading,
  scriptTranslationError,
  regenerateTranslation,
  regeneratingTranslation,
  regenerateTranslationError,
  regenerating,
  regenerateError,
  onRegenerateScript,
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
  scriptContextSegments: TranscriptSegment[];
  currentSegIdx: number;
  showScriptContext: boolean;
  setShowScriptContext: (updater: (prev: boolean) => boolean) => void;
  showPreviousScriptContext: boolean;
  setShowPreviousScriptContext: (updater: (prev: boolean) => boolean) => void;
  showScriptTranslation: boolean;
  setShowScriptTranslation: (updater: (prev: boolean) => boolean) => void;
  translationBySegmentIndex: Map<number, string>;
  scriptTranslationLoading: boolean;
  scriptTranslationError: boolean;
  regenerateTranslation: () => void;
  regeneratingTranslation: boolean;
  regenerateTranslationError: string | null;
  regenerating: boolean;
  regenerateError: string | null;
  onRegenerateScript: () => void;
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
  // The currently-active sentence is blurred until tapped, so the answer
  // isn't readable here while it's still meant to be typed from listening.
  // Revealed once, it stays revealed for the rest of the session.
  const [revealedSegmentIndexes, setRevealedSegmentIndexes] = useState<Set<number>>(new Set());
  const revealSegment = (segmentIndex: number) =>
    setRevealedSegmentIndexes((prev) => new Set(prev).add(segmentIndex));

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => setShowScriptContext((prev) => !prev)}
          className="rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-muted)] hover:bg-white/10"
        >
          {showScriptContext ? "Hide script" : "Show script"}
        </button>
        {currentSegIdx > 0 && (
          <button
            onClick={() => setShowPreviousScriptContext((prev) => !prev)}
            className="rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-muted)] hover:bg-white/10"
          >
            {showPreviousScriptContext ? "Hide previous" : "Show previous"}
          </button>
        )}
        <button
          onClick={() => setShowScriptTranslation((prev) => !prev)}
          className={clsx(
            "rounded-md border px-2.5 py-1 text-[11px] font-medium",
            showScriptTranslation
              ? "border-[var(--accent-border)] bg-[var(--accent-soft)] text-[var(--accent)]"
              : "border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-muted)] hover:bg-white/10"
          )}
        >
          {showScriptTranslation ? "Hide translation" : "Show translation"}
        </button>
        {showScriptTranslation && (
          <button
            onClick={() => regenerateTranslation()}
            disabled={regeneratingTranslation}
            title="Re-translate this video's script if the Vietnamese doesn't match the English"
            className="rounded-md border border-[var(--accent-border)] bg-[var(--accent-soft)] px-2.5 py-1 text-[11px] font-medium text-[var(--accent)] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {regeneratingTranslation ? "Regenerating translation…" : "Regenerate translation"}
          </button>
        )}
        <button
          onClick={onRegenerateScript}
          disabled={regenerating}
          title="Re-fetch this video's script from YouTube's captions if it doesn't match the audio"
          className="rounded-md border border-[var(--accent-border)] bg-[var(--accent-soft)] px-2.5 py-1 text-[11px] font-medium text-[var(--accent)] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {regenerating ? "Regenerating…" : "Regenerate script"}
        </button>
      </div>
      {regenerateError && <p className="text-xs text-[var(--red)]">{regenerateError}</p>}
      {regenerateTranslationError && <p className="text-xs text-[var(--red)]">{regenerateTranslationError}</p>}
      {showScriptTranslation && scriptTranslationLoading && (
        <p className="text-xs text-[var(--text-muted)]">Translating…</p>
      )}
      {showScriptTranslation && scriptTranslationError && (
        <p className="text-xs text-[var(--red)]">Couldn&apos;t load translation.</p>
      )}
      {vocabHighlightsError && (
        <p className="text-xs text-[var(--text-faint)]">Vocab highlighting is unavailable right now.</p>
      )}
      {scriptContextSegments.length === 0 ? (
        <p className="text-xs text-[var(--text-muted)]">Script is not available yet.</p>
      ) : !showScriptContext ? (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3 text-xs text-[var(--text-muted)]">
          Script context is hidden. Use Show script when you want to reveal it.
        </div>
      ) : (
        <div
          ref={scriptTextContainerRef}
          onMouseUp={handleScriptMouseUp}
          className="relative flex flex-col gap-3 pr-1 text-sm lg:min-h-0 lg:flex-1 lg:overflow-y-auto"
        >
          {scriptContextSegments.map((segment) => {
            const isCurrentScriptSentence = segment.segmentIndex === currentSegIdx;
            const isPreviousScriptSentence = segment.segmentIndex < currentSegIdx;
            const isBlurred = isCurrentScriptSentence && !revealedSegmentIndexes.has(segment.segmentIndex);
            const scriptRenderItems = buildScriptRenderItems(
              segment.text,
              phrasesBySegmentIndex.get(segment.segmentIndex) ?? []
            );
            return (
              <div
                key={segment.segmentIndex}
                data-script-segment-index={segment.segmentIndex}
                data-selection-sentence-text={segment.text}
                className={`relative p-4 rounded-xl border transition-colors shadow-sm ${
                  isCurrentScriptSentence
                    ? "bg-[var(--accent-soft)] border-[var(--accent-border)] ring-2 ring-[var(--accent)]/20"
                    : "bg-[var(--surface-glass)] border-[var(--border)] opacity-80 hover:opacity-100"
                }`}
              >
                {isBlurred && (
                  <button
                    type="button"
                    onClick={() => revealSegment(segment.segmentIndex)}
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
                    className={`text-xs font-bold mb-1 flex items-center justify-between ${
                      isCurrentScriptSentence
                        ? "text-[var(--accent)]"
                        : isPreviousScriptSentence
                        ? "text-[var(--green)]"
                        : "text-[var(--text-faint)]"
                    }`}
                  >
                    <span className="uppercase tracking-widest text-[9px]">Sentence #{segment.segmentIndex + 1}</span>
                    {isCurrentScriptSentence && <div className="w-2 h-2 rounded-full bg-[var(--accent)] animate-pulse" />}
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
                              title="Hover or tap to see the meaning"
                              className="cursor-pointer rounded px-0.5 -mx-0.5 underline decoration-[var(--accent)] decoration-2 underline-offset-2 transition-colors hover:bg-[var(--accent-soft)]"
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
                          title="Tap to save this word/phrase"
                          className="cursor-pointer rounded px-0.5 -mx-0.5 transition-colors hover:bg-white/10"
                        >
                          {item.text}
                        </span>
                      );
                    })}
                  </p>
                  {showScriptTranslation && (
                    <p className="mt-1 text-sm leading-relaxed text-[var(--accent)]">
                      {translationBySegmentIndex.get(segment.segmentIndex) ?? "…"}
                    </p>
                  )}
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
