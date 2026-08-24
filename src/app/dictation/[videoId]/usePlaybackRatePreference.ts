import { useEffect, useState } from "react";
import { PLAYBACK_RATE_OPTIONS, PLAYBACK_RATE_STORAGE_KEY } from "./constants";

type PlaybackRate = (typeof PLAYBACK_RATE_OPTIONS)[number];

/** Persists the video playback speed preference to localStorage. */
export function usePlaybackRatePreference() {
  const [playbackRate, setPlaybackRate] = useState<PlaybackRate>(1);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = Number(window.localStorage.getItem(PLAYBACK_RATE_STORAGE_KEY));
    if (PLAYBACK_RATE_OPTIONS.includes(saved as PlaybackRate)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPlaybackRate(saved as PlaybackRate);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(PLAYBACK_RATE_STORAGE_KEY, String(playbackRate));
  }, [playbackRate]);

  return { playbackRate, setPlaybackRate };
}
