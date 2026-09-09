// =====================================================
// Privacy-safe, structured reliability events for transcript generation.
// Emitted as a single JSON console.log line per request — matching this
// repo's existing plain-console-log observability convention (no vendor
// added). Deliberately never includes caption/transcript text, full YouTube
// response bodies, headers, cookies, or secrets — only shape/outcome
// metadata, so these lines are safe to ship to any log aggregator.
// =====================================================

import { createHash } from "node:crypto";
import type { TranscriptProviderName } from "./types";

/** Truncated one-way hash — a YouTube video ID isn't secret, but hashing it
 *  anyway keeps logs from doubling as a plain list of exactly which videos
 *  were accessed, and keeps the event shape consistent if this is ever
 *  reused for something more sensitive. */
export function hashVideoId(videoId: string): string {
  return createHash("sha256").update(videoId).digest("hex").slice(0, 16);
}

export type TranscriptFetchOutcome = "success" | "failure" | "fallback_success";

export interface TranscriptFetchEvent {
  videoIdHash: string;
  provider: TranscriptProviderName;
  outcome: TranscriptFetchOutcome;
  errorCode?: string;
  attemptCount: number;
  fallbackUsed: boolean;
  durationMs: number;
  cueCount?: number;
  segmentCount?: number;
  cacheHit: boolean;
  lockContended: boolean;
  cooldownHit: boolean;
}

export function recordTranscriptFetchEvent(event: TranscriptFetchEvent): void {
  console.log(
    JSON.stringify({
      event: "transcript_fetch_completed",
      ...event,
    })
  );
}
