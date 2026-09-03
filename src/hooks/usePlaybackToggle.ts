"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Headless play/pause toggle over a hidden `<audio>` element — the playback
 * half of Shadowing's "Play/Pause My Recording" control-bar button. No seek
 * bar, time display, or volume control (unlike CompactAudioPlayer), since
 * there is no dedicated playback surface for it to live in — see "Shadowing
 * and Pronunciation Practice Plan.md" §5.2/§5.3.
 */
export function usePlaybackToggle(src: string | null) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  useEffect(() => {
    // A new/cleared src always starts paused — this effect owns creating and
    // tearing down the <audio> element itself, so resetting isPlaying here
    // (rather than deriving it some other way) is the correct place for it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsPlaying(false);
    if (!src) {
      audioRef.current = null;
      return;
    }
    const audio = new Audio(src);
    audioRef.current = audio;

    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onPause);

    return () => {
      audio.pause();
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onPause);
      audioRef.current = null;
    };
  }, [src]);

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      void audio.play();
    } else {
      audio.pause();
    }
  };

  return { isPlaying, toggle };
}
