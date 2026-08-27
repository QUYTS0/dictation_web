import type { DiffToken, VocabularyItem } from "@/lib/types";

export interface MistakeRecord {
  segIdx: number;
  expectedText: string;
  userText: string;
  diff: DiffToken[];
}

export type LessonItemType = "word" | "phrase" | "sentence";
export type RightPanelTab = "script" | "words" | "sentences";
export type VideoSizeMode = "standard" | "large";
export type PracticeMode = "easy" | "hard";

export interface ShortcutEntry {
  keys: string;
  label: string;
}

export type SubtitleVisibility = "show" | "blur" | "hide";
export interface SubtitleVisibilityState {
  original: SubtitleVisibility;
  translation: SubtitleVisibility;
}

export type LessonSavedItem = VocabularyItem & { type: LessonItemType };

export interface CompletedSentenceReview {
  segmentIndex: number;
  expectedText: string;
  firstUserText: string;
  diff: DiffToken[];
}

export interface ScriptSelectionPopoverState {
  segmentIndex: number;
  selectedText: string;
  selectedWordCount: number;
  sentenceText: string;
  x: number;
  y: number;
}

export type ComparedTokenStatus = "correct" | "missing" | "wrong" | "extra" | "neutral";

export interface ComparedToken {
  word: string;
  status: ComparedTokenStatus;
}

export interface ResumeState {
  sessionId: string;
  currentSegmentIndex: number;
  videoCurrentTimeSec: number;
  status: "active" | "completed" | "abandoned";
  accuracy: number;
  totalAttempts: number;
}
