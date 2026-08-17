import { useCallback, useState } from "react";
import { buildManualSegmentsFromText } from "@/lib/utils/segment";

interface UseManualTranscriptPasteOptions {
  videoId: string;
  /** Called after the pasted transcript is saved server-side, with the new transcript id. */
  onTranscriptSaved: (transcriptId: string) => Promise<unknown> | void;
}

/**
 * Handles the "paste a transcript manually" fallback shown when captions
 * can't be fetched automatically (see transcript_failed UX state).
 */
export function useManualTranscriptPaste({ videoId, onTranscriptSaved }: UseManualTranscriptPasteOptions) {
  const [manualPasteText, setManualPasteText] = useState("");
  const [manualPasteSubmitting, setManualPasteSubmitting] = useState(false);
  const [manualPasteError, setManualPasteError] = useState<string | null>(null);

  const handleManualTranscriptSubmit = useCallback(async () => {
    const segments = buildManualSegmentsFromText(manualPasteText);
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
        body: JSON.stringify({ videoId, segments, force: true }),
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
  }, [manualPasteText, videoId, onTranscriptSaved]);

  return {
    manualPasteText,
    setManualPasteText,
    manualPasteSubmitting,
    manualPasteError,
    handleManualTranscriptSubmit,
  };
}
