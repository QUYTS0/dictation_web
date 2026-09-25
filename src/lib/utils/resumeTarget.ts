import type { TranscriptSegment } from "@/lib/types";

/**
 * Small safety margin subtracted from a segment's start time before seeking,
 * so YouTube's keyframe-snapping jitter on seekTo() can't clip the first
 * spoken word. Shared by YouTubePlayer (Replay/Next/Previous) and the resume
 * target below so both land on exactly the same point for a sentence start.
 */
export const SEGMENT_START_PRE_ROLL_SEC = 0.2;

// How far a saved playhead may sit outside the selected sentence's own
// [start, end) and still be considered "that sentence's position": a
// correct-answer save parks at the previous sentence's end minus the
// pre-roll (i.e. just before this sentence), and a Listening save can land in
// the silent gap after a sentence before the next one begins.
const SAVED_TIME_LEAD_TOLERANCE_SEC = 1.5;
const SAVED_TIME_TRAIL_TOLERANCE_SEC = 0.5;

export interface ResumeTarget {
  segmentIndex: number;
  timeSec: number;
  /** Where timeSec came from — "saved_time" when the checkpoint's own
   *  playhead is consistent with its sentence, otherwise "sentence_start". */
  source: "saved_time" | "sentence_start";
}

/**
 * The playhead a resumed lesson should start from on its first Play.
 *
 * The only persisted position today is the shared practice checkpoint
 * (learning_sessions.current_segment_index + video_current_time). Rule:
 *   - use the checkpoint's saved time when it is a real (> 0, finite) value
 *     that lies within the checkpoint's own sentence (with the small
 *     tolerances above);
 *   - otherwise fall back to the start of the checkpoint's sentence.
 *
 * The fallback covers rows whose time and sentence disagree — e.g. a time of
 * 0 written by the pre-repair autosave while the sentence index was N, or a
 * navigation save whose time still described the sentence being left. It
 * never invents a position the server doesn't have (e.g. a Listening
 * playhead that was never saved).
 */
export function resolveResumeTarget(
  segments: TranscriptSegment[],
  segmentIndex: number,
  savedTimeSec: number | null | undefined
): ResumeTarget | null {
  if (segments.length === 0) return null;
  const idx = Math.min(Math.max(Math.trunc(segmentIndex), 0), segments.length - 1);
  const seg = segments[idx];
  const sentenceStart = Math.max(0, seg.start - SEGMENT_START_PRE_ROLL_SEC);

  if (typeof savedTimeSec === "number" && Number.isFinite(savedTimeSec) && savedTimeSec > 0) {
    const next = segments[idx + 1];
    const upper = Math.max(seg.end, next?.start ?? seg.end) + SAVED_TIME_TRAIL_TOLERANCE_SEC;
    const lower = seg.start - SAVED_TIME_LEAD_TOLERANCE_SEC;
    if (savedTimeSec >= lower && savedTimeSec <= upper) {
      return { segmentIndex: idx, timeSec: savedTimeSec, source: "saved_time" };
    }
  }
  return { segmentIndex: idx, timeSec: sentenceStart, source: "sentence_start" };
}
