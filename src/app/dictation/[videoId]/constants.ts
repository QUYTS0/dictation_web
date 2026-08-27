import type { ShortcutEntry, VideoSizeMode } from "./types";

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
export const SOUND_ENABLED_STORAGE_KEY = "dictation.sound-enabled";
export const PLAYBACK_RATE_STORAGE_KEY = "dictation.playback-rate";
export const AUTO_ADVANCE_STORAGE_KEY = "dictation.auto-advance";
export const PRACTICE_MODE_STORAGE_KEY = "dictation.practice-mode";
export const SUBTITLE_VISIBILITY_STORAGE_KEY = "dictation.subtitle-visibility";
// Every Nth combo tick plays a brighter "milestone" chime instead of the normal tick.
export const COMBO_MILESTONE_INTERVAL = 3;
export const VIDEO_SIZE_MODE_CLASS: Record<VideoSizeMode, string> = {
  standard: "max-w-[94%]",
  large: "max-w-none",
};
export const PLAYBACK_RATE_OPTIONS = [0.75, 1, 1.25, 1.5] as const;

export const SHORTCUTS: ShortcutEntry[] = [
  { keys: "Shift + Space", label: "Replay the current sentence" },
  { keys: "Shift + ←", label: "Previous sentence" },
  { keys: "Shift + →", label: "Next sentence" },
  { keys: "/", label: "Focus the answer input" },
  { keys: "Z", label: "Toggle Zen Mode" },
  { keys: "Esc", label: "Exit Zen Mode" },
  { keys: "W", label: "Save selected text as a word (while the selection popover is open)" },
  { keys: "P", label: "Save selected text as a phrase (while the selection popover is open)" },
  { keys: "S", label: "Save selected text as a sentence (while the selection popover is open)" },
];
