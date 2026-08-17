import { useEffect, useState } from "react";
import { VIDEO_SIZE_MODE_STORAGE_KEY } from "./constants";
import type { VideoSizeMode } from "./types";

/** Persists the video player's size preference (standard/large) to localStorage. */
export function useVideoSizeMode() {
  const [videoSizeMode, setVideoSizeMode] = useState<VideoSizeMode>("standard");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = window.localStorage.getItem(VIDEO_SIZE_MODE_STORAGE_KEY);
    if (saved === "standard" || saved === "large") {
      // Hydrating from localStorage post-mount is intentional here (can't
      // read it during SSR without a hydration mismatch).
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setVideoSizeMode(saved);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(VIDEO_SIZE_MODE_STORAGE_KEY, videoSizeMode);
  }, [videoSizeMode]);

  return { videoSizeMode, setVideoSizeMode };
}
