// =====================================================
// Shared TypeScript types for English Dictation Trainer
// =====================================================

// ---- Domain models ----

export interface Video {
  id: string;
  youtube_video_id: string;
  title?: string;
  language: string;
  duration_sec?: number;
  created_at: string;
}

export interface Transcript {
  id: string;
  youtube_video_id: string;
  language: string;
  source: "cache" | "ai" | "manual";
  status: "processing" | "ready" | "failed";
  version: number;
  full_text?: string;
  created_at: string;
  updated_at: string;
}

export interface TranscriptSegment {
  id: string;
  transcript_id: string;
  segmentIndex: number;
  start: number;
  end: number;
  duration: number;
  text: string;
  textNormalized: string;
}

export interface LearningSession {
  id: string;
  user_id?: string;
  youtube_video_id: string;
  transcript_id?: string;
  current_segment_index: number;
  accuracy: number;
  total_attempts: number;
  status: "active" | "completed" | "abandoned";
  started_at: string;
  updated_at: string;
}

export interface AttemptLog {
  id: string;
  session_id: string;
  segment_index: number;
  expected_text: string;
  user_text: string;
  is_correct: boolean;
  error_type?: ErrorType;
  created_at: string;
}

export interface AIFeedback {
  id: string;
  attempt_id: string;
  explanation: string;
  corrected_text: string;
  example_text: string;
  created_at: string;
}

// ---- Dictation / answer-check types ----

export type MatchMode = "exact" | "relaxed" | "learning";

export type ErrorType =
  | "spelling"
  | "missing_word"
  | "extra_word"
  | "wrong_form"
  | "punctuation"
  | "capitalization"
  | "none";

export interface DiffToken {
  word: string;
  status: "correct" | "wrong" | "missing" | "extra";
}

export interface CheckResult {
  isCorrect: boolean;
  matchMode: MatchMode;
  errorType: ErrorType;
  diff: DiffToken[];
  normalizedExpected: string;
  normalizedUser: string;
}

// ---- Hint types ----

export type HintLevel = 0 | 1 | 2 | 3 | 4;

export interface HintResult {
  level: HintLevel;
  hint: string;
}

// ---- UX states ----

export type UXState =
  | "idle"
  | "loading_video"
  | "loading_transcript"
  | "transcript_processing"
  | "transcript_ready"
  | "transcript_failed"
  | "playing"
  | "paused_waiting_input"
  | "checking_answer"
  | "ai_explaining"
  | "session_completed"
  | "network_error";

// ---- API request / response types ----

export interface ResolveVideoRequest {
  url: string;
}

export interface ResolveVideoResponse {
  videoId: string;
  status: "ok" | "error";
  message?: string;
}

export interface TranscriptResponse {
  status: "ready" | "processing" | "failed";
  source?: "cache" | "ai" | "manual";
  title?: string | null;
  segments: TranscriptSegment[];
}

export interface CheckAnswerRequest {
  sessionId?: string;
  segmentIndex: number;
  userText: string;
  expectedText: string;
  matchMode?: MatchMode;
}

export interface CheckAnswerResponse extends CheckResult {
  sessionId?: string;
}

export interface AIExplainRequest {
  expectedText: string;
  userText: string;
  attemptId?: string;
}

export interface AIExplainResponse {
  explanation: string;
  correctedText: string;
  example: string;
  tip?: string;
}

export interface SaveProgressRequest {
  sessionId?: string;
  youtubeVideoId: string;
  transcriptId?: string;
  currentSegmentIndex: number;
  videoCurrentTimeSec?: number;
  accuracy: number;
  totalAttempts: number;
  status?: "active" | "completed" | "abandoned";
}

export interface SaveProgressResponse {
  sessionId: string;
  status: string;
}

export interface ResumeSessionResponse {
  session: {
    sessionId: string;
    currentSegmentIndex: number;
    videoCurrentTimeSec: number;
    accuracy: number;
    totalAttempts: number;
    updatedAt: string;
  } | null;
}

export interface VocabularyItem {
  id: string;
  user_id: string;
  video_id: string;
  segment_index: number;
  term: string;
  normalized_term: string;
  sentence_context: string;
  note: string | null;
  created_at: string;
}

export interface VocabularyRequest {
  videoId: string;
  segmentIndex: number;
  term: string;
  sentenceContext: string;
  note?: string;
}
