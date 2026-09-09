"use client";

import { useCallback, useRef, useState } from "react";
import { parseSrt } from "@/lib/utils/srt";
import { parseVtt } from "@/lib/utils/vtt";
import { mergeIntoSentences, type ManualSegmentInput, type CueItem } from "@/lib/utils/segment";

interface UseSrtTranscriptUploadOptions {
  /** Called with the parsed segments once a valid .srt/.vtt file is selected. */
  onSegmentsParsed: (segments: ManualSegmentInput[], importSource: "srt" | "vtt") => Promise<unknown> | void;
}

/** Picks the parser by file extension when unambiguous, otherwise sniffs the
 *  content itself (a `.vtt` file always starts with a `WEBVTT` header; `.srt`
 *  doesn't) — a mislabeled extension still parses correctly either way. */
function detectSubtitleFormat(fileName: string, content: string): "srt" | "vtt" {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".vtt")) return "vtt";
  if (lower.endsWith(".srt")) return "srt";
  return /^﻿?WEBVTT/i.test(content) ? "vtt" : "srt";
}

/**
 * Handles picking and parsing a .srt or .vtt subtitle file — the caller
 * decides how to save the resulting segments (see handleRegenerateTranscript
 * in useDictationSession, which resets any in-progress session before
 * saving). Unlike the manual-paste fallback, this keeps the file's real
 * per-cue timestamps instead of estimating timing from word count.
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
        const format = detectSubtitleFormat(file.name, content);
        const cues: CueItem[] = format === "vtt" ? parseVtt(content) : parseSrt(content);
        if (cues.length === 0) {
          setSrtUploadError(
            format === "vtt"
              ? "Couldn't find any subtitle cues in that file. Make sure it's a valid .vtt file."
              : "Couldn't find any subtitle cues in that file. Make sure it's a valid .srt file."
          );
          return;
        }

        const merged = mergeIntoSentences(cues);
        const segments: ManualSegmentInput[] = merged.map((seg, i) => ({
          segmentIndex: i,
          start: seg.start,
          end: seg.start + seg.duration,
          text: seg.text,
        }));

        await onSegmentsParsed(segments, format);
      } catch {
        setSrtUploadError("Failed to read that subtitle file. Please try again.");
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
