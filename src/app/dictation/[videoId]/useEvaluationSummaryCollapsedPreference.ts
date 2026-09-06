import { useEffect, useState } from "react";
import { EVALUATION_SUMMARY_COLLAPSED_STORAGE_KEY } from "./constants";

/** Session Summary's collapse state: collapsed by default on every
 *  breakpoint (desktop and mobile alike), so the current sentence stays the
 *  primary content — an explicit user choice, persisted to localStorage, is
 *  read back on mount and overrides the default from then on. */
export function useEvaluationSummaryCollapsedPreference() {
  const [collapsed, setCollapsed] = useState(true);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = window.localStorage.getItem(EVALUATION_SUMMARY_COLLAPSED_STORAGE_KEY);
    if (saved === "true" || saved === "false") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCollapsed(saved === "true");
    }
  }, []);

  const setCollapsedAndPersist = (value: boolean) => {
    setCollapsed(value);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(EVALUATION_SUMMARY_COLLAPSED_STORAGE_KEY, String(value));
    }
  };

  return { collapsed, setCollapsed: setCollapsedAndPersist };
}
