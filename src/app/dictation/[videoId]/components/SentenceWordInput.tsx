"use client";

import { Fragment, useEffect, useMemo, useState, type ReactNode, type RefObject } from "react";
import { clsx } from "clsx";
import {
  buildFullValue,
  buildWordCharSlots,
  findIncorrectWordIndex,
  findTypableWordIndex,
  isWordAnsweredCorrectly,
  isWordTypable,
  type WordSlots,
} from "../wordSlots";
import type { PersistedInputState } from "../sessionPersistence";

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
  isReached,
  caretPos,
  maskLetters,
  colorClass,
  isIncorrect,
  wordKey,
}: {
  word: WordSlots;
  typedChars: string;
  isActive: boolean;
  /** Has the caret reached or passed this word yet? Gates punctuation reveal
   *  in Hard Mode so nothing about a not-yet-reached word leaks early. */
  isReached: boolean;
  caretPos: number;
  maskLetters: boolean;
  colorClass: string;
  isIncorrect: boolean;
  wordKey: string;
}): ReactNode[] {
  const nodes: ReactNode[] = [];
  let consumed = 0;
  let caretRendered = false;
  // Once we hit an untyped editable slot, any punctuation further along in
  // this word hasn't been "confirmed" yet either — hide it too in Hard Mode.
  let hitPending = false;

  word.slots.forEach((slot, i) => {
    if (isActive && !caretRendered && consumed === caretPos) {
      nodes.push(<Caret key={`${wordKey}-caret`} />);
      caretRendered = true;
    }
    if (slot.editable) {
      if (consumed < typedChars.length) {
        nodes.push(
          <span key={`${wordKey}-c${i}`} className={colorClass}>
            {typedChars[consumed]}
          </span>
        );
        consumed++;
      } else {
        hitPending = true;
        if (maskLetters || isIncorrect) {
          nodes.push(
            <span key={`${wordKey}-c${i}`} className={isIncorrect ? "text-[var(--red)]" : "text-[var(--text-faint)]"}>
              _
            </span>
          );
        }
      }
    } else if (maskLetters || isIncorrect || (isReached && !hitPending)) {
      nodes.push(
        <span key={`${wordKey}-c${i}`} className={colorClass}>
          {slot.char}
        </span>
      );
    }
  });

  for (let k = consumed; k < typedChars.length; k++) {
    if (isActive && !caretRendered && k === caretPos) {
      nodes.push(<Caret key={`${wordKey}-caret-ov${k}`} />);
      caretRendered = true;
    }
    nodes.push(
      <span key={`${wordKey}-ov${k}`} className={colorClass}>
        {typedChars[k]}
      </span>
    );
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
  hasWrongSubmission,
  onValueChange,
  onSubmit,
  initialInputState,
  onRestoreConsumed,
  onInputStateChange,
}: {
  targetText: string;
  resetToken: string;
  inputRef: RefObject<HTMLInputElement | null>;
  showMask: boolean;
  maskBlurred: boolean;
  hasWrongSubmission: boolean;
  onValueChange: (value: string) => void;
  onSubmit: () => void;
  /** A sessionStorage-restored word/caret position to seed this sentence with once, in
   *  place of the usual blank reset — e.g. after a tab switch or accidental remount. */
  initialInputState?: PersistedInputState | null;
  /** Called once initialInputState has been applied, so later resets go back to blank. */
  onRestoreConsumed?: () => void;
  /** Mirrors the live word/caret position up so it can be included in the session snapshot. */
  onInputStateChange?: (state: PersistedInputState) => void;
}) {
  const words = useMemo(() => buildWordCharSlots(targetText), [targetText]);
  const [typedByWord, setTypedByWord] = useState<string[]>([]);
  const [activeWordIndex, setActiveWordIndex] = useState(0);
  const [caretPos, setCaretPos] = useState(0);

  // Reset per-word state whenever a new sentence loads or the answer is reset,
  // so the caret always starts at the first editable character of the first word.
  // A pending restored snapshot seeds it instead, once, for this resetToken.
  useEffect(() => {
    if (initialInputState) {
      const restoredTyped = words.map((_, i) => initialInputState.typedByWord[i] ?? "");
      const firstTypable = findTypableWordIndex(words, 0, 1) ?? 0;
      const restoredActive = Math.min(
        Math.max(initialInputState.activeWordIndex, 0),
        Math.max(words.length - 1, 0)
      );
      setTypedByWord(restoredTyped);
      setActiveWordIndex(Number.isFinite(restoredActive) ? restoredActive : firstTypable);
      setCaretPos(initialInputState.caretPos);
      onRestoreConsumed?.();
    } else {
      setTypedByWord(words.map(() => ""));
      setActiveWordIndex(findTypableWordIndex(words, 0, 1) ?? 0);
      setCaretPos(0);
      inputRef.current?.setSelectionRange(0, 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [words, resetToken]);

  useEffect(() => {
    onValueChange(buildFullValue(words, typedByWord));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [words, typedByWord]);

  useEffect(() => {
    onInputStateChange?.({ typedByWord, activeWordIndex, caretPos });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typedByWord, activeWordIndex, caretPos]);

  // Keeps the real (invisible) input's native cursor in sync with caretPos —
  // essential when jumping between words, since the controlled `value` swaps
  // to the new word's content and the native cursor must move to match.
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const len = typedByWord[activeWordIndex]?.length ?? 0;
    const pos = Math.max(0, Math.min(caretPos, len));
    if (input.selectionStart !== pos || input.selectionEnd !== pos) {
      input.setSelectionRange(pos, pos);
    }
  }, [activeWordIndex, caretPos, typedByWord, inputRef]);

  const jumpToWord = (index: number, position: "start" | "end") => {
    setActiveWordIndex(index);
    setCaretPos(position === "start" ? 0 : typedByWord[index]?.length ?? 0);
  };

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const sanitized = event.target.value.replace(/\s+/g, "");
    const pos = Math.min(event.target.selectionStart ?? sanitized.length, sanitized.length);
    setTypedByWord((prev) => {
      const next = [...prev];
      next[activeWordIndex] = sanitized;
      return next;
    });
    setCaretPos(pos);
  };

  const handleSelect = (event: React.SyntheticEvent<HTMLInputElement>) => {
    setCaretPos(event.currentTarget.selectionStart ?? 0);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const input = event.currentTarget;

    if (event.key === "Enter") {
      event.preventDefault();
      onSubmit();
      return;
    }

    // Plain Space only — Shift+Space (replay), Ctrl/Alt/Meta+Space, etc. are left
    // alone so they keep bubbling up to the page-level shortcut handler untouched.
    if ((event.key === " " || event.code === "Space") && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      const next = findTypableWordIndex(words, activeWordIndex + 1, 1);
      if (next !== null) jumpToWord(next, "start");
      return;
    }

    if (event.key === "Backspace" && (typedByWord[activeWordIndex]?.length ?? 0) === 0) {
      event.preventDefault();
      const prev = findTypableWordIndex(words, activeWordIndex - 1, -1);
      if (prev !== null) jumpToWord(prev, "end");
      return;
    }

    if (hasWrongSubmission && event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      const dir = event.key === "ArrowLeft" ? -1 : 1;
      const target = findIncorrectWordIndex(words, typedByWord, activeWordIndex + dir, dir);
      if (target !== null) jumpToWord(target, "start");
      return;
    }

    if (event.ctrlKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      const dir = event.key === "ArrowLeft" ? -1 : 1;
      const target = findTypableWordIndex(words, activeWordIndex + dir, dir);
      if (target !== null) jumpToWord(target, dir === -1 ? "end" : "start");
      return;
    }

    if (event.key === "Home") {
      event.preventDefault();
      const first = findTypableWordIndex(words, 0, 1);
      if (first !== null) jumpToWord(first, "start");
      return;
    }

    if (event.key === "End") {
      event.preventDefault();
      const last = findTypableWordIndex(words, words.length - 1, -1);
      if (last !== null) jumpToWord(last, "end");
      return;
    }

    if (event.key === "ArrowLeft" && !event.ctrlKey && !event.metaKey && !event.altKey) {
      if (input.selectionStart === 0 && input.selectionEnd === 0) {
        event.preventDefault();
        const prev = findTypableWordIndex(words, activeWordIndex - 1, -1);
        if (prev !== null) jumpToWord(prev, "end");
      }
      return;
    }

    if (event.key === "ArrowRight" && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const len = input.value.length;
      if (input.selectionStart === len && input.selectionEnd === len) {
        event.preventDefault();
        const next = findTypableWordIndex(words, activeWordIndex + 1, 1);
        if (next !== null) jumpToWord(next, "start");
      }
    }
  };

  const handleWordClick = (index: number) => {
    if (!isWordTypable(words[index])) return;
    setActiveWordIndex(index);
    setCaretPos(typedByWord[index]?.length ?? 0);
    inputRef.current?.focus();
  };

  const allEmpty = typedByWord.every((typed) => !typed || typed.length === 0);
  const showPlaceholder = allEmpty && !showMask && !hasWrongSubmission;

  return (
    <>
      <input
        ref={inputRef}
        type="text"
        value={typedByWord[activeWordIndex] ?? ""}
        onChange={handleChange}
        onSelect={handleSelect}
        onKeyDown={handleKeyDown}
        enterKeyHint="done"
        aria-label="Type what you hear"
        className="absolute h-px w-px overflow-hidden opacity-0"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
      />

      <div
        className={clsx(
          "w-full px-4 py-4 text-center text-xl leading-loose md:px-14",
          showMask ? "font-mono tracking-wide" : "font-medium",
          maskBlurred && "blur-sm"
        )}
      >
        {showPlaceholder ? (
          // Nothing has been typed anywhere yet: show only the caret immediately
          // followed by the placeholder, as one centered unit — no per-word
          // scaffolding (and no punctuation from the answer) leaks through.
          <span className="inline-flex whitespace-nowrap align-baseline">
            <Caret />
            <span className="text-[var(--text-faint)]">Type what you hear...</span>
          </span>
        ) : (
          words.map((word, wordIndex) => {
            const typedChars = typedByWord[wordIndex] ?? "";
            const isActive = wordIndex === activeWordIndex;
            const isIncorrect =
              hasWrongSubmission && isWordTypable(word) && !isWordAnsweredCorrectly(word, typedChars);
            const colorClass = isIncorrect ? "text-[var(--red)]" : "text-[var(--text)]";
            return (
              <Fragment key={wordIndex}>
                {wordIndex > 0 && " "}
                <span
                  onClick={() => handleWordClick(wordIndex)}
                  className={clsx(
                    "-mx-1 -my-0.5 inline-block cursor-pointer whitespace-nowrap rounded px-1 py-0.5 transition-colors",
                    isActive && "bg-[var(--accent-soft)]"
                  )}
                >
                  {renderWordNodes({
                    word,
                    typedChars,
                    isActive,
                    isReached: wordIndex <= activeWordIndex,
                    caretPos,
                    maskLetters: showMask,
                    colorClass,
                    isIncorrect,
                    wordKey: `w${wordIndex}`,
                  })}
                </span>
              </Fragment>
            );
          })
        )}
      </div>
    </>
  );
}
