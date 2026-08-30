"use client";

import { useCallback, useRef, useState } from "react";
import { parseSrt } from "@/lib/utils/srt";
import { mergeIntoSentences, type ManualSegmentInput } from "@/lib/utils/segment";

interface UseSrtTranscriptUploadOptions {
  /** Called with the parsed segments once a valid .srt file is selected. */
  onSegmentsParsed: (segments: ManualSegmentInput[]) => Promise<unknown> | void;
}

/**
 * Handles picking and parsing a .srt file — the caller decides how to save
 * the resulting segments (see handleRegenerateTranscript in
 * useDictationSession, which resets any in-progress session before saving).
 * Unlike the manual-paste fallback, this keeps the file's real per-cue
 * timestamps instead of estimating timing from word count.
 */
export function useSrtTranscriptUpload({ onSegmentsParsed }: UseSrtTranscriptUploadOptions) {
  const [srtParsing, setSrtParsing] = useState(false);
  const [srtUploadError, setSrtUploadError] = useState<string | null>(null);
  const srtFileInputRef = useRef<HTMLInputElement>(null);

  const openSrtFilePicker = useCallback(() => {
    srtFileInputRef.current?.click();
  }, []);

  const handleSrtFileSelected = useCallback(
    async (file: File) => {
      setSrtUploadError(null);
      setSrtParsing(true);
      try {
        const content = await file.text();
        const cues = parseSrt(content);
        if (cues.length === 0) {
          setSrtUploadError("Couldn't find any subtitle cues in that file. Make sure it's a valid .srt file.");
          return;
        }

        const merged = mergeIntoSentences(cues);
        const segments: ManualSegmentInput[] = merged.map((seg, i) => ({
          segmentIndex: i,
          start: seg.start,
          end: seg.start + seg.duration,
          text: seg.text,
        }));

        await onSegmentsParsed(segments);
      } catch {
        setSrtUploadError("Failed to read that .srt file. Please try again.");
      } finally {
        setSrtParsing(false);
      }
    },
    [onSegmentsParsed]
  );

  const handleSrtFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (file) void handleSrtFileSelected(file);
    },
    [handleSrtFileSelected]
  );

  return {
    srtFileInputRef,
    srtParsing,
    srtUploadError,
    openSrtFilePicker,
    handleSrtFileInputChange,
  };
}
