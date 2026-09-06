import { useEffect, useState } from "react";
import { EVALUATION_SUMMARY_COLLAPSED_STORAGE_KEY } from "./constants";

/** Session Summary's collapse state: an explicit user choice (persisted to
 *  localStorage, so a manual collapse/expand sticks on that device) takes
 *  priority; absent that, it defaults to expanded on desktop (`lg` and up,
 *  where the sidebar has `lg:h-full` and can absorb the extra content) and
 *  collapsed on mobile (where the per-sentence card should stay the primary
 *  content and coverage is still visible in the collapsed header). Defaults
 *  to expanded during SSR/first paint to avoid a hydration mismatch — the
 *  responsive/stored value is applied in an effect, same convention as
 *  useAutoWordMatchPreference. */
export function useEvaluationSummaryCollapsedPreference() {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = window.localStorage.getItem(EVALUATION_SUMMARY_COLLAPSED_STORAGE_KEY);
    if (saved === "true" || saved === "false") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCollapsed(saved === "true");
      return;
    }
    const isDesktop = window.matchMedia("(min-width: 1024px)").matches;
    setCollapsed(!isDesktop);
  }, []);

  const setCollapsedAndPersist = (value: boolean) => {
    setCollapsed(value);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(EVALUATION_SUMMARY_COLLAPSED_STORAGE_KEY, String(value));
    }
  };

  return { collapsed, setCollapsed: setCollapsedAndPersist };
}
