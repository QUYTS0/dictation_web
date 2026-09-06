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

export interface TrueEvaluationNBestPhoneme {
  phoneme: string;
  score: number;
}

export interface TrueEvaluationSyllable {
  syllable: string;
  accuracyScore: number | null;
  /** The word letters this syllable corresponds to (e.g. "there" for IPA
   *  syllable "ðɛɹ") — absent on evaluations recorded before this field
   *  was added. */
  grapheme?: string;
  /** 100-nanosecond ticks, Azure's native unit — format with
   *  formatAzureDuration() from helpers.ts rather than showing raw ticks. */
  offset?: number;
  duration?: number;
}

export interface TrueEvaluationPhoneme {
  phoneme: string;
  accuracyScore: number | null;
  offset?: number;
  duration?: number;
  /** Azure's ranked alternative phoneme candidates. Absent on older stored
   *  evaluations and whenever Azure has nothing better to suggest. */
  nBestPhonemes?: TrueEvaluationNBestPhoneme[];
}

/** A word's prosody diagnostics (break/intonation), present only when Azure
 *  actually flagged something for this word — see prosodyFeedbackFor() in
 *  lib/azureSpeech.ts. Absent on older stored evaluations. */
export interface ProsodyFeedback {
  breakErrorType?: "UnexpectedBreak" | "MissingBreak";
  breakConfidence?: number;
  intonationErrorType?: "Monotone";
  monotoneConfidence?: number;
}

export interface TrueEvaluationWord {
  word: string;
  accuracyScore: number | null;
  errorType: string;
  offset?: number;
  duration?: number;
  syllables?: TrueEvaluationSyllable[];
  phonemes?: TrueEvaluationPhoneme[];
  prosodyFeedback?: ProsodyFeedback;
}

/** The sanitized per-sentence Azure payload backing the Detailed Report's
 *  "Raw Azure response" section — see AzureRawPronunciationResult in
 *  lib/azureSpeech.ts (kept as a local, loosely-typed alias here so this
 *  client-shared file has no import from the server-only module). Absent on
 *  evaluations recorded before this field was added. */
export type AzureRawPronunciationResult = Record<string, unknown>;

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
  /** Identifies which take this result was scored from — the recorded
   *  clip's own object URL (see useAudioRecorder), unique per take. Lets the
   *  UI detect a "new recording, not yet evaluated" state instead of
   *  silently showing a score that belongs to a discarded take. Only set on
   *  a completed result. */
  clipId?: string;
  /** The full sanitized Azure response for this sentence, powering the
   *  Detailed Report. Absent on evaluations recorded before this field was
   *  added — the report simply omits sections/the raw JSON in that case. */
  rawAzureResult?: AzureRawPronunciationResult;
}

/** A single word's score within one historical attempt — deliberately much
 *  lighter than TrueEvaluationWord (no phonemes/syllables/offsets): kept for
 *  every retained attempt, so it must stay cheap. Full detail is only ever
 *  kept for the latest attempt (see lastSuccessfulTrueEvaluation). */
export interface AttemptWordScore {
  word: string;
  accuracyScore: number | null;
  errorType: string;
}

/** One retained historical evaluation of a sentence — see
 *  "Video-wide learning history" plan. Compact by design (scores + light
 *  per-word scores only, no phonemes/syllables/nBest/rawAzureResult) so
 *  keeping several of these per sentence in sessionStorage stays cheap; the
 *  one full-detail copy of the latest attempt still lives on
 *  lastSuccessfulTrueEvaluation. */
export interface SentenceEvaluationAttempt {
  evaluatedAt: string;
  clipId?: string;
  pronunciationScore?: number;
  accuracyScore?: number;
  fluencyScore?: number;
  completenessScore?: number;
  prosodyScore?: number;
  words: AttemptWordScore[];
}

export interface SentenceEvaluation {
  segmentIndex: number;
  referenceText: string;
  wordCount: number;
  audioDuration: number;

  wordMatch?: WordMatchResult;
  /** The current attempt's status machine (idle/processing/completed/
   *  failed/unavailable) — reset to "processing" the instant a new
   *  evaluation starts, so it can go stale/failed without losing the last
   *  good score (see lastSuccessfulTrueEvaluation below). */
  trueEvaluation?: TrueEvaluationResult;
  /** The most recent *completed* True Evaluation for this sentence, kept
   *  untouched by a subsequent start/failure — this is what session
   *  aggregation and "previous score" UI should read, so a failed retry
   *  never destroys the last good result. Always has status "completed". */
  lastSuccessfulTrueEvaluation?: TrueEvaluationResult;
  /** Every retained completed attempt for this sentence, oldest first,
   *  capped at MAX_ATTEMPTS_PER_SENTENCE (see useShadowingEvaluations.ts) —
   *  its last entry always matches lastSuccessfulTrueEvaluation's scores.
   *  Absent on evaluations recorded before this field was added; readers
   *  should treat that the same as a single-point history containing just
   *  lastSuccessfulTrueEvaluation (see toAttempt() in useShadowingEvaluations.ts). */
  attempts?: SentenceEvaluationAttempt[];
}
