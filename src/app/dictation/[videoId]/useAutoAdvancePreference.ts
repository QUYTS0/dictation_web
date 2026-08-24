import { useEffect, useState } from "react";
import { AUTO_ADVANCE_STORAGE_KEY } from "./constants";

/** Persists the auto-advance (auto-submit on exact match) preference to localStorage. */
export function useAutoAdvancePreference() {
  const [autoAdvance, setAutoAdvance] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = window.localStorage.getItem(AUTO_ADVANCE_STORAGE_KEY);
    if (saved === "true" || saved === "false") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAutoAdvance(saved === "true");
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(AUTO_ADVANCE_STORAGE_KEY, String(autoAdvance));
  }, [autoAdvance]);

  return { autoAdvance, setAutoAdvance };
}
