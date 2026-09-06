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
// Plan.md" §11. Word Match (free, browser speech recognition) and True
// Evaluation (Azure Pronunciation Assessment, quota-limited) are two
// independent results for the same sentence — each has its own state
// machine so the UI can show processing/failed/unsupported without ever
// conflating "no result yet" with "0%". Updating one must never overwrite
// the other; both are read from the same shared, sessionStorage-backed map
// (see useShadowingEvaluations.ts) so they survive switching right-panel
// tabs, unlike component-local state.
export interface EvaluationProblemWord {
  word: string;
  score?: number;
  errorType?: string;
}

export type WordMatchStatus = "idle" | "processing" | "completed" | "failed" | "unsupported";

export interface WordMatchResult {
  status: WordMatchStatus;
  recognizedText?: string;
  accuracy?: number;
  completeness?: number;
  problemWords?: EvaluationProblemWord[];
  error?: string;
}

export type TrueEvaluationStatus = "idle" | "processing" | "completed" | "failed" | "unavailable";

export interface TrueEvaluationSyllable {
  syllable: string;
  accuracyScore: number | null;
}

export interface TrueEvaluationPhoneme {
  phoneme: string;
  accuracyScore: number | null;
}

export interface TrueEvaluationWord {
  word: string;
  accuracyScore: number | null;
  errorType: string;
  offset?: number;
  duration?: number;
  syllables?: TrueEvaluationSyllable[];
  phonemes?: TrueEvaluationPhoneme[];
}

export interface TrueEvaluationResult {
  status: TrueEvaluationStatus;
  pronunciationScore?: number;
  accuracyScore?: number;
  fluencyScore?: number;
  completenessScore?: number;
  prosodyScore?: number;
  recognizedText?: string;
  words?: TrueEvaluationWord[];
  error?: string;
  evaluatedAt?: string;
}

export interface SentenceEvaluation {
  segmentIndex: number;
  referenceText: string;
  wordCount: number;
  audioDuration: number;

  wordMatch?: WordMatchResult;
  trueEvaluation?: TrueEvaluationResult;
}
