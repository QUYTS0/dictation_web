"use client";

import { useEffect, useRef, useState } from "react";
import { Pause, Play, Volume2, VolumeX } from "lucide-react";

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

interface CompactAudioPlayerProps {
  src: string;
  /** Shown for current/duration before the browser has loaded the file's own metadata. */
  durationHint?: number;
  className?: string;
}

/**
 * Minimal custom playback bar (Play/Pause, seek, time, mute) built on a
 * hidden native <audio> element — deliberately not the browser's own
 * <audio controls> UI, which is too tall/inconsistent across browsers for a
 * compact layout.
 */
export function CompactAudioPlayer({ src, durationHint, className }: CompactAudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(durationHint ?? 0);
  const [muted, setMuted] = useState(false);

  // A new clip (different src) always starts paused, at 0 — reset local
  // display state rather than carrying over the previous clip's position.
  useEffect(() => {
    setCurrentTime(0);
    setIsPlaying(false);
    setDuration(durationHint ?? 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTimeUpdate = () => setCurrentTime(audio.currentTime);
    const onLoadedMetadata = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) setDuration(audio.duration);
    };
    const onEnded = () => {
      setIsPlaying(false);
      setCurrentTime(0);
    };
    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("loadedmetadata", onLoadedMetadata);
    audio.addEventListener("ended", onEnded);
    return () => {
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("loadedmetadata", onLoadedMetadata);
      audio.removeEventListener("ended", onEnded);
    };
  }, [src]);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      void audio.play();
      setIsPlaying(true);
    } else {
      audio.pause();
      setIsPlaying(false);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const audio = audioRef.current;
    if (!audio) return;
    const time = Number(e.target.value);
    audio.currentTime = time;
    setCurrentTime(time);
  };

  const toggleMute = () => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.muted = !audio.muted;
    setMuted(audio.muted);
  };

  return (
    <div className={`flex w-full max-w-[230px] items-center gap-1.5 ${className ?? ""}`}>
      <audio ref={audioRef} src={src} preload="metadata" className="hidden" />
      <button
        type="button"
        onClick={togglePlay}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-[#1a1206] transition-transform hover:scale-105"
        aria-label={isPlaying ? "Pause" : "Play"}
      >
        {isPlaying ? <Pause size={12} /> : <Play size={12} className="ml-0.5" />}
      </button>
      <input
        type="range"
        min={0}
        max={duration || 0.01}
        step={0.01}
        value={Math.min(currentTime, duration || 0)}
        onChange={handleSeek}
        className="h-1 flex-1 accent-[var(--accent)]"
        aria-label="Seek"
      />
      <span className="shrink-0 text-[10px] tabular-nums text-[var(--text-faint)]">
        {formatTime(currentTime)}/{formatTime(duration)}
      </span>
      <button
        type="button"
        onClick={toggleMute}
        className="flex h-5 w-5 shrink-0 items-center justify-center text-[var(--text-faint)] transition-colors hover:text-[var(--text-muted)]"
        aria-label={muted ? "Unmute" : "Mute"}
      >
        {muted ? <VolumeX size={12} /> : <Volume2 size={12} />}
      </button>
    </div>
  );
}
