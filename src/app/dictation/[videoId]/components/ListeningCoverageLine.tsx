"use client";

import { Check, Headphones } from "lucide-react";
import type { ListeningProgressResponse } from "@/lib/practice/listeningTypes";

function formatSeconds(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

/**
 * One compact line under the Listening transcript: how much of the script's
 * spoken sentences this account has played back (plan §6.3). Honest about
 * what it measures — playback of the script, not attention — and shows no
 * percentage when there is no script to measure against.
 */
export function ListeningCoverageLine({
  signedIn,
  hasTranscript,
  progress,
}: {
  signedIn: boolean;
  hasTranscript: boolean;
  progress: ListeningProgressResponse | null;
}) {
  const title = "Counts the parts of the script's sentences you've played back — not whether you were paying attention.";
  if (!signedIn) {
    return <p className="text-center text-xs text-[var(--text-faint)]">Sign in to keep track of how much you&apos;ve listened to.</p>;
  }
  if (!hasTranscript) {
    return (
      <p className="flex items-center justify-center gap-1.5 text-xs text-[var(--text-faint)]" title={title}>
        <Headphones size={12} className="shrink-0" />
        {progress?.coveredSec ? `Listened ${formatSeconds(progress.coveredSec)}` : "Listening progress is tracked once the script is ready."}
      </p>
    );
  }
  const pct = Math.min(100, Math.round((progress?.coverageRatio ?? 0) * 100));
  return (
    <p
      className="flex flex-wrap items-center justify-center gap-x-1.5 gap-y-0.5 text-xs text-[var(--text-muted)]"
      title={title}
      aria-live="polite"
    >
      <Headphones size={12} className="shrink-0 text-[var(--text-faint)]" />
      <span className="tabular-nums">Listened to {pct}% of the script</span>
      {progress?.listenedThrough && (
        <span className="flex items-center gap-1 rounded-full border border-[var(--green)]/30 bg-[var(--green)]/15 px-2 py-0.5 font-semibold text-[var(--green)]">
          <Check size={11} /> Listened through
        </span>
      )}
    </p>
  );
}
