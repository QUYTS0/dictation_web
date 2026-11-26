"use client";

import { useState } from "react";
import clsx from "clsx";
import { RotateCw } from "lucide-react";
import { VocabularyPronunciationButton } from "@/app/vocabulary/components/VocabularyPronunciationButton";
import { clozeParts } from "@/lib/vocabulary/cloze";
import { computeNextReview, formatReviewInterval } from "@/lib/utils/srs";
import type { ReviewGrade, VocabularyItem } from "@/lib/types";
import { REVIEW_GRADES, type ReviewMode } from "./reviewControls";

interface ReviewCardProps {
  item: VocabularyItem;
  mode: ReviewMode;
  revealed: boolean;
  onFlip: () => void;
  /** `compact` for the Dashboard deck, `large` for /vocabulary/review. */
  size?: "compact" | "large";
  /** Small status text on the front, e.g. "Card 2 of 6". */
  caption?: string;
  /** On the root; e.g. `flex-1` lets the card grow to fill a taller deck. */
  className?: string;
}

/**
 * One review flashcard, shared by the Dashboard deck and /vocabulary/review
 * (plan §4.5.4). Front: the learner's own sentence with the word blanked
 * ("Fill the gap"), or the word itself ("Meaning"). No audio on a gap front
 * — it would give the answer away. A word that can't be found in its
 * sentence (e.g. edited after saving) falls back to the Meaning front.
 * Back: word, part of speech, definition (or translation), the sentence
 * with the word marked, and pronunciation. Announced politely on flip.
 * A flip turns the new face into view (a 3D turn, none under reduced
 * motion); a new card, which remounts this component, simply appears.
 */
export function ReviewCard({ item, mode, revealed, onFlip, size = "compact", caption, className }: ReviewCardProps) {
  const word = item.canonical_form ?? item.term;
  const cloze = clozeParts(item.sentence_context, item.term);
  const showGap = mode === "gap" && cloze !== null;
  const large = size === "large";
  const meaning = item.definition ?? item.translation;
  // Turned = this face appeared because of a flip (state adjusted during render).
  const [prevRevealed, setPrevRevealed] = useState(revealed);
  const [turned, setTurned] = useState(false);
  if (revealed !== prevRevealed) {
    setPrevRevealed(revealed);
    setTurned(true);
  }

  return (
    <div data-testid="review-card" data-mode={showGap ? "gap" : "meaning"} data-revealed={revealed} className={clsx("flex flex-col", className)}>
      {!revealed ? (
        <button
          type="button"
          onClick={onFlip}
          aria-label={showGap ? "Show the missing word" : `Show the meaning of ${word}`}
          className={clsx(
            "flex w-full flex-1 flex-col justify-between gap-4 rounded-xl border border-line bg-surface text-left text-ink transition-colors hover:border-primary-500/40",
            large ? "min-h-[240px] p-8" : "min-h-[170px] p-5",
            turned && "animate-card-turn"
          )}
        >
          <span className="flex items-center justify-between text-xs text-muted">
            <span className="font-mono">{caption}</span>
            <span className="font-semibold uppercase tracking-wider">{showGap ? "Fill the gap" : "What does it mean?"}</span>
          </span>
          {showGap ? (
            <span className={clsx("block leading-relaxed", large ? "text-xl sm:text-2xl" : "text-base sm:text-lg")}>
              {cloze.before}
              <span data-testid="review-gap" className="mx-0.5 inline-block min-w-[4.5em] translate-y-0.5 border-b-2 border-primary-600">
                <span className="sr-only">(missing word)</span>&nbsp;
              </span>
              {cloze.after}
            </span>
          ) : (
            <span className="block">
              <span className={clsx("block font-extrabold tracking-tight", large ? "text-4xl" : "text-2xl")}>{word}</span>
              {item.phonetic && <span className="mt-1 block font-mono text-xs text-muted">{item.phonetic}</span>}
            </span>
          )}
          <span className="flex items-center gap-1.5 text-[11px] font-medium text-muted">
            <RotateCw size={12} aria-hidden="true" />
            {/* Touch screens have no Space key. */}
            <span className="pointer-coarse:hidden">Click or press Space to flip</span>
            <span className="hidden pointer-coarse:inline">Tap to flip</span>
          </span>
        </button>
      ) : (
        <div
          aria-live="polite"
          className={clsx(
            "flex w-full flex-1 flex-col gap-3 rounded-xl border border-hero-2 text-white",
            large ? "min-h-[240px] p-8" : "min-h-[170px] p-5",
            turned && "animate-card-turn"
          )}
          style={{ background: "linear-gradient(135deg, #151b35 0%, #25285c 100%)" }}
        >
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h3 className={clsx("font-extrabold tracking-tight", large ? "text-3xl" : "text-xl")}>{word}</h3>
            {item.part_of_speech && <span className="text-xs font-semibold uppercase tracking-wider text-reward">{item.part_of_speech}</span>}
            {item.phonetic && <span className="font-mono text-xs text-slate-300">{item.phonetic}</span>}
            <span className="ml-auto">
              <VocabularyPronunciationButton item={item} />
            </span>
          </div>
          <p className={clsx("leading-relaxed text-slate-100", large ? "text-base" : "text-sm")}>
            {meaning ?? <span className="text-slate-400">No definition saved yet.</span>}
          </p>
          <p className="rounded-lg border border-white/10 bg-white/[0.08] p-2.5 text-xs italic leading-relaxed text-indigo-100">
            &ldquo;
            {cloze ? (
              <>
                {cloze.before}
                <mark className="rounded bg-reward/25 px-0.5 not-italic font-semibold text-white">{cloze.answer}</mark>
                {cloze.after}
              </>
            ) : (
              item.sentence_context
            )}
            &rdquo;
          </p>
          {item.note && <p className="whitespace-pre-wrap text-xs text-slate-300">{item.note}</p>}
          <button type="button" onClick={onFlip} className="self-start text-[11px] font-medium text-slate-400 underline-offset-2 hover:text-white hover:underline">
            Flip back
          </button>
        </div>
      )}
    </div>
  );
}

/** The four grades with their key and the next interval each would schedule. */
export function ReviewGradeButtons({
  item,
  onGrade,
  busyGrade,
  size = "compact",
}: {
  item: VocabularyItem;
  onGrade: (grade: ReviewGrade) => void;
  busyGrade?: ReviewGrade | null;
  size?: "compact" | "large";
}) {
  const state = { intervalDays: item.interval_days, easeFactor: item.ease_factor, repetitions: item.repetitions };
  const tone: Record<ReviewGrade, string> = {
    again: "border-red-200 bg-red-50 text-red-700 hover:bg-red-100",
    hard: "border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100",
    good: "border-primary-100 bg-primary-50 text-primary-700 hover:bg-primary-100",
    easy: "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100",
  };
  return (
    <div role="group" aria-label="Rate your recall" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {REVIEW_GRADES.map(({ grade, label, key }) => {
        const interval = formatReviewInterval(computeNextReview(state, grade).intervalDays);
        return (
          <button
            key={grade}
            type="button"
            onClick={() => onGrade(grade)}
            disabled={!!busyGrade}
            aria-keyshortcuts={key}
            aria-label={`${label}, next review ${interval === "today" ? "today" : `in ${interval}`}`}
            className={clsx(
              "flex items-center justify-center gap-2 rounded-lg border font-semibold transition-colors disabled:opacity-50",
              size === "large" ? "px-4 py-3 text-sm" : "px-2.5 py-2 text-xs",
              tone[grade]
            )}
          >
            <kbd className="rounded border border-current/30 px-1 font-mono text-[10px] opacity-70">{key}</kbd>
            {busyGrade === grade ? "Saving…" : label}
            <span className="font-mono text-[10px] font-medium opacity-70">{interval}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Fill the gap / Meaning switch. */
export function ReviewModeToggle({ mode, onChange }: { mode: ReviewMode; onChange: (mode: ReviewMode) => void }) {
  const options: Array<{ value: ReviewMode; label: string }> = [
    { value: "gap", label: "Fill the gap" },
    { value: "meaning", label: "Meaning" },
  ];
  return (
    <div role="radiogroup" aria-label="Card type" className="flex items-center rounded-lg border border-line bg-surface p-0.5 text-xs font-medium">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={mode === o.value}
          onClick={() => onChange(o.value)}
          className={clsx(
            "rounded-md px-2.5 py-1 transition-colors",
            mode === o.value ? "bg-white font-bold text-ink shadow-xs" : "text-muted hover:text-ink"
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
