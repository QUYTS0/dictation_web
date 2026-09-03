import type { InputMode, ShortcutEntry, VideoSizeMode } from "./types";

// Let the embedded player seek after the segment playback command settles.
export const RESUME_SEEK_DELAY_MS = 150;
export const SCRIPT_POPOVER_MAX_SIDE_MARGIN_PX = 160;
export const SCRIPT_POPOVER_MIN_SIDE_MARGIN_PX = 24;
export const SCRIPT_POPOVER_VIEWPORT_MARGIN_FACTOR = 0.2;
export const SCRIPT_POPOVER_VERTICAL_OFFSET_PX = 12;
export const SCRIPT_POPOVER_MAX_WIDTH_PX = 320;
export const CORRECT_RESULT_VISIBILITY_DELAY_MS = 650;
export const VIDEO_SIZE_MODE_STORAGE_KEY = "dictation.video-size-mode";
export const SOUND_ENABLED_STORAGE_KEY = "dictation.sound-enabled";
export const PLAYBACK_RATE_STORAGE_KEY = "dictation.playback-rate";
export const AUTO_ADVANCE_STORAGE_KEY = "dictation.auto-advance";
export const PRACTICE_MODE_STORAGE_KEY = "dictation.practice-mode";
export const SUBTITLE_VISIBILITY_STORAGE_KEY = "dictation.subtitle-visibility";
export const REPLAY_HINT_SEEN_KEY = "dictation.seen-replay-hint";
// Every Nth combo tick plays a brighter "milestone" chime instead of the normal tick.
export const COMBO_MILESTONE_INTERVAL = 3;
export const VIDEO_SIZE_MODE_CLASS: Record<VideoSizeMode, string> = {
  standard: "max-w-[94%]",
  large: "max-w-none",
};
export const PLAYBACK_RATE_OPTIONS = [0.75, 1, 1.25, 1.5] as const;

// Short label shown on the mode-switch trigger button in ControlBar.
export const INPUT_MODE_LABELS: Record<InputMode, string> = {
  dictation: "Dictation",
  listening: "Listening",
  shadowing: "Shadowing",
  pronunciation: "Pronunciation",
};

// Shortcuts for typing/answering the current sentence — shown both in the full
// Settings list and in the lightweight quick-access popover on the page itself.
export const DICTATION_SHORTCUTS: ShortcutEntry[] = [
  { keys: "Space", label: "Move to or skip the next word" },
  { keys: "Enter", label: "Submit the current answer" },
  { keys: "← / →", label: "Move between words when the caret reaches a word boundary" },
  { keys: "Ctrl + ←", label: "Jump to the previous editable word" },
  { keys: "Ctrl + →", label: "Jump to the next editable word" },
  { keys: "Home", label: "Jump to the first editable word" },
  { keys: "End", label: "Jump to the last editable word" },
  { keys: "Alt + ←", label: "Jump to the previous incorrect word" },
  { keys: "Alt + →", label: "Jump to the next incorrect word" },
  { keys: "Shift + Space", label: "Replay the current sentence" },
  { keys: "Shift + ←", label: "Previous sentence" },
  { keys: "Shift + →", label: "Next sentence" },
  { keys: "/", label: "Focus the answer input" },
];

// General page/app-level shortcuts, unrelated to answering the current sentence.
export const GENERAL_SHORTCUTS: ShortcutEntry[] = [
  { keys: "Z", label: "Toggle Zen Mode" },
  { keys: "Esc", label: "Exit Zen Mode" },
  { keys: "W", label: "Save selected text as a word (while the selection popover is open)" },
  { keys: "P", label: "Save selected text as a phrase (while the selection popover is open)" },
  { keys: "S", label: "Save selected text as a sentence (while the selection popover is open)" },
];
