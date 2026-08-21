import { useEffect, useState } from "react";
import { SOUND_ENABLED_STORAGE_KEY } from "./constants";

/** Persists the practice sound-effects preference (on/off) to localStorage. */
export function useSoundPreference() {
  const [soundEnabled, setSoundEnabled] = useState(true);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = window.localStorage.getItem(SOUND_ENABLED_STORAGE_KEY);
    if (saved === "true" || saved === "false") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSoundEnabled(saved === "true");
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(SOUND_ENABLED_STORAGE_KEY, String(soundEnabled));
  }, [soundEnabled]);

  return { soundEnabled, setSoundEnabled };
}
