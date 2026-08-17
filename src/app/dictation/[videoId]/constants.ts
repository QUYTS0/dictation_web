import type { VideoSizeMode } from "./types";

// Let the embedded player seek after the segment playback command settles.
export const RESUME_SEEK_DELAY_MS = 150;
export const SCRIPT_POPOVER_MAX_SIDE_MARGIN_PX = 160;
export const SCRIPT_POPOVER_MIN_SIDE_MARGIN_PX = 24;
export const SCRIPT_POPOVER_VIEWPORT_MARGIN_FACTOR = 0.2;
export const SCRIPT_POPOVER_VERTICAL_OFFSET_PX = 12;
export const SCRIPT_POPOVER_MAX_WIDTH_PX = 320;
export const SCRIPT_CONTEXT_NEXT_COUNT = 2;
export const SCRIPT_CONTEXT_PREVIOUS_COUNT = 3;
export const CORRECT_RESULT_VISIBILITY_DELAY_MS = 650;
export const VIDEO_SIZE_MODE_STORAGE_KEY = "dictation.video-size-mode";
export const VIDEO_SIZE_MODE_CLASS: Record<VideoSizeMode, string> = {
  standard: "max-w-4xl",
  large: "max-w-none",
};
