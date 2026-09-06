import { useEffect, useState } from "react";
import { AUTO_WORD_MATCH_STORAGE_KEY } from "./constants";

/** Persists the "run Word Match automatically after recording" preference
 *  (on/off) to localStorage. Defaults to on — browser speech recognition has
 *  no per-request cost and gives immediate feedback, but some users may want
 *  to opt out since it relies on a browser-vendor speech service. */
export function useAutoWordMatchPreference() {
  const [autoWordMatch, setAutoWordMatch] = useState(true);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = window.localStorage.getItem(AUTO_WORD_MATCH_STORAGE_KEY);
    if (saved === "true" || saved === "false") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAutoWordMatch(saved === "true");
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(AUTO_WORD_MATCH_STORAGE_KEY, String(autoWordMatch));
  }, [autoWordMatch]);

  return { autoWordMatch, setAutoWordMatch };
}
