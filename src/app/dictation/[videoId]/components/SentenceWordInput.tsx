"use client";

import { Fragment, useEffect, useMemo, useState, type ReactNode, type RefObject } from "react";
import { clsx } from "clsx";
import {
  buildFullValue,
  buildWordCharSlots,
  findTypableWordIndex,
  isWordTypable,
  type WordSlots,
} from "../wordSlots";
import type { ComparedToken } from "../types";

function Caret() {
  return (
    <span
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
}: {
  word: WordSlots;
  typedChars: string;
  isActive: boolean;
  maskLetters: boolean;
  wordKey: string;
}): ReactNode[] {
  const nodes: ReactNode[] = [];
  let consumed = 0;
  let caretRendered = false;

  word.slots.forEach((slot, i) => {
    if (isActive && !caretRendered && slot.editable && consumed >= typedChars.length) {
      nodes.push(<Caret key={`${wordKey}-caret`} />);
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
    nodes.push(<Caret key={`${wordKey}-caret-end`} />);
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
        <div className="w-full px-16 py-4 text-center text-xl font-medium leading-loose sm:px-14">
          {errorDiffTokens.map((token, index) => (
            <Fragment key={index}>
              {index > 0 && " "}
              <span
                className={clsx(
                  "inline-block whitespace-nowrap",
                  token.status === "correct" ? "text-[var(--text)]" : "text-[var(--red)]"
                )}
              >
                {token.word}
              </span>
            </Fragment>
          ))}
        </div>
      ) : (
        <div
          className={clsx(
            "w-full px-16 py-4 text-center text-xl leading-loose sm:px-14",
            showMask ? "font-mono tracking-wide" : "font-medium",
            maskBlurred && "blur-sm"
          )}
        >
          {words.map((word, wordIndex) => (
            <Fragment key={wordIndex}>
              {wordIndex > 0 && " "}
              <span onClick={() => handleWordClick(wordIndex)} className="inline-block whitespace-nowrap">
                {renderWordNodes({
                  word,
                  typedChars: typedByWord[wordIndex] ?? "",
                  isActive: wordIndex === activeWordIndex,
                  maskLetters: showMask,
                  wordKey: `w${wordIndex}`,
                })}
              </span>
            </Fragment>
          ))}
          {showPlaceholder && <span className="text-[var(--text-faint)]"> Type what you hear...</span>}
        </div>
      )}
    </>
  );
}
