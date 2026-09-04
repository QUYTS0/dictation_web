import type { DiffToken, VocabularyItem } from "@/lib/types";

export interface MistakeRecord {
  segIdx: number;
  expectedText: string;
  userText: string;
  diff: DiffToken[];
}

export type LessonItemType = "word" | "phrase" | "sentence";
export type RightPanelTab = "script" | "words" | "sentences" | "evaluation";
export type VideoSizeMode = "standard" | "large";
export type PracticeMode = "easy" | "hard";
export type InputMode = "dictation" | "listening" | "shadowing";

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

// ---- Shadowing evaluation — see "Shadowing and Pronunciation Practice
// Plan.md" §11. Each sentence is evaluated individually; accuracy/
// completeness/fluency/prosody are each optional since not every engine
// (e.g. today's Word Match) produces every category.
export interface EvaluationProblemWord {
  word: string;
  score?: number;
  errorType?: string;
}

export interface SentenceEvaluation {
  segmentIndex: number;
  referenceText: string;
  wordCount: number;
  audioDuration: number;

  accuracy?: number;
  completeness?: number;
  fluency?: number;
  prosody?: number;

  problemWords?: EvaluationProblemWord[];
}
