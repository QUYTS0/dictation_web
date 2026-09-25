// =====================================================
// Deterministic content fingerprint for a transcript revision
// (Phase 0 — .claude/video-learning-management-plan.md)
// =====================================================
//
// Used by transcript/generate/route.ts to decide whether newly-fetched
// content actually differs from an existing ready revision before
// publishing a new one — see fn_publish_transcript_revision (migration
// 021), which matches on this value.
//
// Rules, stated explicitly (all server-computed; never trust a
// client-supplied fingerprint):
// - Segments are hashed in segment order (the caller must pass them
//   already sorted by segmentIndex — every current caller already
//   guarantees this).
// - Text is normalized with the SAME normalizeText("relaxed") pipeline
//   already used to compute transcript_segments.text_normalized at insert
//   time (src/lib/utils/text.ts) — reusing it here (rather than inventing a
//   second normalization rule) means the fingerprint is computed over
//   exactly the representation that gets stored, and stays in sync with it
//   by construction if that pipeline ever changes.
// - Start/end timestamps are rounded to 0.1s before hashing, so
//   imperceptible floating-point jitter between two generations of
//   essentially the same content doesn't spuriously produce a new
//   revision, while a genuine re-segmentation/re-timing (a change bigger
//   than the rounding step) does change the hash.
// - Only content that describes the transcript itself is included —
//   segmentIndex, rounded start/end, and normalized text. Nothing that
//   describes the *operation* that produced it (generation timestamp,
//   request id, provider name, attempt count) is ever part of the input.

import { createHash } from "crypto";
import { normalizeText } from "@/lib/utils/text";

export interface FingerprintableSegment {
  segmentIndex: number;
  start: number;
  end: number;
  text: string;
}

const TIMING_PRECISION_SEC = 0.1;

function roundTiming(sec: number): string {
  // Fixed-decimal string, not a bare rounded number — avoids "1" vs "1.0"
  // hashing differently for what should be an identical rounded value.
  const rounded = Math.round(sec / TIMING_PRECISION_SEC) * TIMING_PRECISION_SEC;
  return rounded.toFixed(1);
}

/**
 * Computes a deterministic, server-owned fingerprint over a transcript
 * revision's meaningful content. Two calls with equivalent content (same
 * segment order, same normalized text, timing within 0.1s) always produce
 * the same fingerprint; a genuine content or timing change always produces
 * a different one.
 */
export function computeTranscriptFingerprint(segments: FingerprintableSegment[]): string {
  const canonical = segments
    .slice()
    .sort((a, b) => a.segmentIndex - b.segmentIndex)
    .map((seg) => `${seg.segmentIndex}|${roundTiming(seg.start)}|${roundTiming(seg.end)}|${normalizeText(seg.text, "relaxed")}`)
    .join("\n");

  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
