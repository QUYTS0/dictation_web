import { useEffect, useState } from "react";
import { SUBTITLE_VISIBILITY_STORAGE_KEY } from "./constants";
import type { SubtitleVisibility, SubtitleVisibilityState } from "./types";

const DEFAULT_STATE: SubtitleVisibilityState = { original: "show", translation: "show" };
const VALID_VALUES: SubtitleVisibility[] = ["show", "blur", "hide"];

function isValid(value: unknown): value is SubtitleVisibility {
  return typeof value === "string" && (VALID_VALUES as string[]).includes(value);
}

/** Persists the Original/Translation subtitle Show/Blur/Hide preference to localStorage. */
export function useSubtitleVisibilityPreference() {
  const [subtitleVisibility, setSubtitleVisibility] = useState<SubtitleVisibilityState>(DEFAULT_STATE);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = window.localStorage.getItem(SUBTITLE_VISIBILITY_STORAGE_KEY);
    if (!saved) return;
    try {
      const parsed = JSON.parse(saved) as Partial<SubtitleVisibilityState>;
      if (isValid(parsed.original) && isValid(parsed.translation)) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setSubtitleVisibility({ original: parsed.original, translation: parsed.translation });
      }
    } catch {
      // Ignore malformed stored value, fall back to defaults.
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(SUBTITLE_VISIBILITY_STORAGE_KEY, JSON.stringify(subtitleVisibility));
  }, [subtitleVisibility]);

  const setOriginalVisibility = (value: SubtitleVisibility) =>
    setSubtitleVisibility((prev) => ({ ...prev, original: value }));
  const setTranslationVisibility = (value: SubtitleVisibility) =>
    setSubtitleVisibility((prev) => ({ ...prev, translation: value }));

  return { subtitleVisibility, setOriginalVisibility, setTranslationVisibility };
}
