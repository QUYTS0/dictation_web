import { useEffect, useState } from "react";

interface UseKeyboardShortcutsOptions {
  onReplay: () => void;
  onPrevious: () => void;
  onSkip: () => void;
}

/**
 * Wires the dictation page's global keyboard shortcuts (Shift+Space replay,
 * Shift+Arrow prev/next, "/" to focus the answer input). Returns a signal
 * that increments each time "/" is pressed, so the page can focus its input.
 */
export function useKeyboardShortcuts({ onReplay, onPrevious, onSkip }: UseKeyboardShortcutsOptions) {
  const [inputFocusSignal, setInputFocusSignal] = useState(0);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const target = e.target;
      const isTypingTarget =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable);

      if (e.shiftKey && e.code === "Space") {
        e.preventDefault();
        onReplay();
        return;
      }

      if (e.shiftKey && e.key === "ArrowLeft") {
        e.preventDefault();
        onPrevious();
        return;
      }

      if (e.shiftKey && e.key === "ArrowRight") {
        e.preventDefault();
        onSkip();
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
  }, [onReplay, onSkip, onPrevious]);

  return { inputFocusSignal };
}
