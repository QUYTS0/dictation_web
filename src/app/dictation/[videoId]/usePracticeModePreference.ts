import { useEffect, useState } from "react";
import { PRACTICE_MODE_STORAGE_KEY } from "./constants";
import type { PracticeMode } from "./types";

/** Persists the Easy/Hard practice mode preference to localStorage. */
export function usePracticeModePreference() {
  const [practiceMode, setPracticeMode] = useState<PracticeMode>("hard");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = window.localStorage.getItem(PRACTICE_MODE_STORAGE_KEY);
    if (saved === "easy" || saved === "hard") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPracticeMode(saved);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(PRACTICE_MODE_STORAGE_KEY, practiceMode);
  }, [practiceMode]);

  return { practiceMode, setPracticeMode };
}
