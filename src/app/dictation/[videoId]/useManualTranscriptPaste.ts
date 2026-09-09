import { useCallback, useState } from "react";
import { buildManualSegmentsFromText } from "@/lib/utils/segment";
import { parseTimestampedPaste } from "@/lib/utils/timestampPaste";

interface UseManualTranscriptPasteOptions {
  videoId: string;
  /** Known video duration (seconds), used as the last cue's end time when a
   *  timestamped paste's final cue has no next cue to derive it from. */
  videoDurationSec?: number;
  /** Called after the pasted transcript is saved server-side, with the new transcript id. */
  onTranscriptSaved: (transcriptId: string) => Promise<unknown> | void;
}

/**
 * Handles the "paste a transcript manually" fallback shown when captions
 * can't be fetched automatically (see transcript_failed UX state).
 *
 * Tries to recognize a timestamped YouTube-transcript-panel-style paste
 * first (real per-cue timing); falls back to the original plain-sentence
 * paste (estimated timing) when no timestamp lines are present, so existing
 * plain-paste behavior is unchanged.
 */
export function useManualTranscriptPaste({ videoId, videoDurationSec, onTranscriptSaved }: UseManualTranscriptPasteOptions) {
  const [manualPasteText, setManualPasteText] = useState("");
  const [manualPasteSubmitting, setManualPasteSubmitting] = useState(false);
  const [manualPasteError, setManualPasteError] = useState<string | null>(null);

  const handleManualTranscriptSubmit = useCallback(async () => {
    const timestamped = parseTimestampedPaste(manualPasteText, { videoDurationSec });
    if (timestamped.kind === "error") {
      setManualPasteError(timestamped.message);
      return;
    }
    const segments =
      timestamped.kind === "ok" ? timestamped.segments : buildManualSegmentsFromText(manualPasteText);
    if (segments.length === 0) {
      setManualPasteError("Paste at least one sentence to continue.");
      return;
    }

    setManualPasteSubmitting(true);
    setManualPasteError(null);
    try {
      const res = await fetch("/api/transcript/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId, segments, force: true, importSource: "manual" }),
      });
      const data = await res.json();
      if (!res.ok) {
        setManualPasteError(data.error ?? "Failed to save transcript.");
        return;
      }
      await onTranscriptSaved(data.transcriptId);
    } catch {
      setManualPasteError("Failed to save transcript. Please try again.");
    } finally {
      setManualPasteSubmitting(false);
    }
  }, [manualPasteText, videoDurationSec, videoId, onTranscriptSaved]);

  return {
    manualPasteText,
    setManualPasteText,
    manualPasteSubmitting,
    manualPasteError,
    handleManualTranscriptSubmit,
  };
}
