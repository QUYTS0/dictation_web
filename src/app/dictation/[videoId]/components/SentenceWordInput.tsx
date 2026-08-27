"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { clsx } from "clsx";
import {
  buildFullValue,
  buildWordCharSlots,
  findTypableWordIndex,
  isWordTypable,
  type WordSlots,
} from "../wordSlots";
import type { ComparedToken } from "../types";

function Caret({ innerRef }: { innerRef?: RefObject<HTMLSpanElement | null> }) {
  return (
    <span
      ref={innerRef}
      aria-hidden="true"
      className="dictation-caret -mb-[0.15em] inline-block h-[1.15em] w-[2px] shrink-0 self-center bg-[var(--accent)] align-middle"
    />
  );
}

function renderWordNodes({
  word,
  typedChars,
  isActive,
  maskLetters,
  wordKey,
  caretRef,
}: {
  word: WordSlots;
  typedChars: string;
  isActive: boolean;
  maskLetters: boolean;
  wordKey: string;
  caretRef?: RefObject<HTMLSpanElement | null>;
}): ReactNode[] {
  const nodes: ReactNode[] = [];
  let consumed = 0;
  let caretRendered = false;

  word.slots.forEach((slot, i) => {
    if (isActive && !caretRendered && slot.editable && consumed >= typedChars.length) {
      nodes.push(<Caret key={`${wordKey}-caret`} innerRef={caretRef} />);
      caretRendered = true;
    }
    if (slot.editable) {
      if (consumed < typedChars.length) {
        nodes.push(
          <span key={`${wordKey}-c${i}`} className="text-[var(--text)]">
            {typedChars[consumed]}
          </span>
        );
        consumed++;
      } else if (maskLetters) {
        nodes.push(
          <span key={`${wordKey}-c${i}`} className="text-[var(--text-faint)]">
            _
          </span>
        );
      }
    } else {
      nodes.push(
        <span key={`${wordKey}-c${i}`} className="text-[var(--text)]">
          {slot.char}
        </span>
      );
    }
  });

  if (consumed < typedChars.length) {
    for (let k = consumed; k < typedChars.length; k++) {
      nodes.push(
        <span key={`${wordKey}-ov${k}`} className="text-[var(--text)]">
          {typedChars[k]}
        </span>
      );
    }
  }

  if (isActive && !caretRendered) {
    nodes.push(<Caret key={`${wordKey}-caret-end`} innerRef={caretRef} />);
  }

  return nodes;
}

export function SentenceWordInput({
  targetText,
  resetToken,
  inputRef,
  showMask,
  maskBlurred,
  showErrorDiff,
  errorDiffTokens,
  onValueChange,
  onSubmit,
}: {
  targetText: string;
  resetToken: string;
  inputRef: RefObject<HTMLInputElement | null>;
  showMask: boolean;
  maskBlurred: boolean;
  showErrorDiff: boolean;
  errorDiffTokens: ComparedToken[];
  onValueChange: (value: string) => void;
  onSubmit: () => void;
}) {
  const words = useMemo(() => buildWordCharSlots(targetText), [targetText]);
  const [typedByWord, setTypedByWord] = useState<string[]>([]);
  const [activeWordIndex, setActiveWordIndex] = useState(0);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const caretRef = useRef<HTMLSpanElement>(null);

  // Reset per-word state whenever a new sentence loads or the answer is reset,
  // so the caret always starts at the first editable character of the first word.
  useEffect(() => {
    setTypedByWord(words.map(() => ""));
    setActiveWordIndex(findTypableWordIndex(words, 0, 1) ?? 0);
    inputRef.current?.setSelectionRange(0, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [words, resetToken]);

  useEffect(() => {
    onValueChange(buildFullValue(words, typedByWord));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [words, typedByWord]);

  useEffect(() => {
    caretRef.current?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [activeWordIndex, typedByWord]);

  useEffect(() => {
    const len = typedByWord[activeWordIndex]?.length ?? 0;
    inputRef.current?.setSelectionRange(len, len);
  }, [activeWordIndex, typedByWord, inputRef]);

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const sanitized = event.target.value.replace(/\s+/g, "");
    setTypedByWord((prev) => {
      const next = [...prev];
      next[activeWordIndex] = sanitized;
      return next;
    });
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      onSubmit();
      return;
    }
    if (event.key === " " || event.code === "Space") {
      event.preventDefault();
      setActiveWordIndex((current) => findTypableWordIndex(words, current + 1, 1) ?? current);
      return;
    }
    if (event.key === "Backspace" && (typedByWord[activeWordIndex]?.length ?? 0) === 0) {
      event.preventDefault();
      setActiveWordIndex((current) => findTypableWordIndex(words, current - 1, -1) ?? current);
    }
  };

  const handleWordClick = (index: number) => {
    if (!isWordTypable(words[index])) return;
    setActiveWordIndex(index);
    inputRef.current?.focus();
  };

  // Lets the user swipe horizontally to pan overflowed text (long sentences
  // that don't fit on one line) instead of only relying on the caret.
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;

    const DRAG_THRESHOLD = 8;
    let startX = 0;
    let startScrollLeft = 0;
    let isDragging = false;

    const handleTouchStart = (e: TouchEvent) => {
      startX = e.touches[0].clientX;
      startScrollLeft = el.scrollLeft;
      isDragging = false;
    };
    const handleTouchMove = (e: TouchEvent) => {
      const deltaX = e.touches[0].clientX - startX;
      if (!isDragging && Math.abs(deltaX) < DRAG_THRESHOLD) return;
      isDragging = true;
      e.preventDefault();
      el.scrollLeft = startScrollLeft - deltaX;
    };
    const handleTouchEnd = (e: TouchEvent) => {
      if (isDragging) e.preventDefault();
      isDragging = false;
    };

    el.addEventListener("touchstart", handleTouchStart, { passive: true });
    el.addEventListener("touchmove", handleTouchMove, { passive: false });
    el.addEventListener("touchend", handleTouchEnd);
    return () => {
      el.removeEventListener("touchstart", handleTouchStart);
      el.removeEventListener("touchmove", handleTouchMove);
      el.removeEventListener("touchend", handleTouchEnd);
    };
  }, []);

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollWidth <= el.clientWidth) return;
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (delta === 0) return;
    e.preventDefault();
    el.scrollLeft += delta;
  };

  const allEmpty = typedByWord.every((typed) => !typed || typed.length === 0);
  const showPlaceholder = allEmpty && !showMask && !showErrorDiff;

  return (
    <>
      <input
        ref={inputRef}
        type="text"
        value={typedByWord[activeWordIndex] ?? ""}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        enterKeyHint="done"
        aria-label="Type what you hear"
        className="absolute h-px w-px overflow-hidden opacity-0"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
      />

      {showErrorDiff ? (
        <div className="w-full overflow-x-auto whitespace-nowrap px-16 py-4 text-center text-xl font-medium sm:px-14">
          {errorDiffTokens.map((token, index) => (
            <span key={index} className={token.status === "correct" ? "text-[var(--text)]" : "text-[var(--red)]"}>
              {token.word}
              {index < errorDiffTokens.length - 1 ? " " : ""}
            </span>
          ))}
        </div>
      ) : (
        <div
          ref={scrollContainerRef}
          onWheel={handleWheel}
          className={clsx(
            "w-full overflow-x-auto whitespace-nowrap px-16 py-4 text-center text-xl sm:px-14",
            showMask ? "font-mono tracking-wide" : "font-medium",
            maskBlurred && "blur-sm"
          )}
        >
          {words.map((word, wordIndex) => (
            <span key={wordIndex} onClick={() => handleWordClick(wordIndex)}>
              {wordIndex > 0 && " "}
              {renderWordNodes({
                word,
                typedChars: typedByWord[wordIndex] ?? "",
                isActive: wordIndex === activeWordIndex,
                maskLetters: showMask,
                wordKey: `w${wordIndex}`,
                caretRef: wordIndex === activeWordIndex ? caretRef : undefined,
              })}
            </span>
          ))}
          {showPlaceholder && <span className="text-[var(--text-faint)]"> Type what you hear...</span>}
        </div>
      )}
    </>
  );
}
