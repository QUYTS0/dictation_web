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

// ---- Listening practice / translation types ----

export type TranslationSource = "youtube_captions" | "free_library" | "gemini";

export interface TranslationSegment {
  segmentIndex: number;
  textTranslated: string;
  source: TranslationSource;
}

export interface TranslateTranscriptRequest {
  videoId: string;
  transcriptId: string;
  language?: string;
}

export interface TranslateTranscriptResponse {
  status: "ready" | "error";
  language: string;
  translations: TranslationSegment[];
  error?: string;
}

// ---- Vocab highlighting (AI-picked difficult words/phrases per segment) ----

export interface VocabHighlightSegment {
  segmentIndex: number;
  /** Exact substrings of the segment's text worth a learner's attention. */
  phrases: string[];
}

export interface VocabHighlightsRequest {
  videoId: string;
  transcriptId: string;
}

export interface VocabHighlightsResponse {
  status: "ready" | "error";
  highlights: VocabHighlightSegment[];
  error?: string;
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
    status: "active" | "completed" | "abandoned";
  } | null;
}

// ---- Session results / report ----

export interface SessionReportMistake {
  segmentIndex: number;
  expectedText: string;
  userText: string;
  errorType: ErrorType | null;
  attempts: number;
  /** The most recent wrong attempt for this segment — used to request/cache an AI explanation. */
  attemptId: string;
  /** Pre-loaded from `ai_feedback` when this attempt was already explained before. */
  aiFeedback: { explanation: string; correctedText: string; example: string } | null;
}

export interface SessionReportResponse {
  session: {
    id: string;
    videoId: string;
    videoTitle: string | null;
    status: "active" | "completed" | "abandoned";
    accuracy: number;
    totalAttempts: number;
    currentSegmentIndex: number;
    totalSegments: number | null;
    startedAt: string;
    updatedAt: string;
    durationSec: number;
    /** Pre-loaded from `learning_sessions.ai_assessment` when this session was already assessed before. */
    assessment: SessionAssessment | null;
    assessmentGeneratedAt: string | null;
  };
  errorBreakdown: Array<{ errorType: ErrorType; count: number; percentage: number }>;
  mistakes: SessionReportMistake[];
}

export type SessionExplainAllItemStatus = "explained" | "duplicate" | "minor";

export interface SessionExplainAllItem {
  attemptId: string;
  status: SessionExplainAllItemStatus;
  /** Populated when status is "explained". */
  explanation: string;
  correctedText: string;
  example: string;
  tip?: string;
  /** Populated when status is "duplicate" — the segment (1-based) carrying the full explanation. */
  duplicateOfSegmentIndex?: number;
  /** Short note shown instead of the full card for "duplicate" / "minor". */
  note?: string;
}

export interface SessionAssessment {
  /** One-sentence overall verdict on the session, e.g. "Solid session with a few recurring slip-ups." */
  verdict: string;
  strengths: string[];
  weaknesses: string[];
  recommendation: string;
}

export interface SessionExplainAllResponse {
  items: SessionExplainAllItem[];
  /** A structured overall performance review — reviews every mistake in the session, uncapped. */
  assessment: SessionAssessment | null;
  /** Total mistakes (not deduped) the assessment was based on. */
  mistakesReviewed: number;
  /** How many distinct mistake patterns were sent to Gemini for a full explanation. */
  uniquePatternsExplained: number;
  /** True when there were more distinct patterns than the per-request cap — only the first batch got a full explanation. */
  truncated: boolean;
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
  translation: string | null;
  translation_language: string;
  translation_source: "free_library" | "gemini" | null;
  phonetic: string | null;
  part_of_speech: string | null;
  definition: string | null;
  definition_source: "free_dictionary" | "gemini" | null;
  image_url: string | null;
  image_thumbnail_url: string | null;
  image_attribution: string | null;
  image_source_url: string | null;
  created_at: string;
  next_review_at: string;
  interval_days: number;
  ease_factor: number;
  repetitions: number;
  last_reviewed_at: string | null;
}

export interface VocabularyRequest {
  videoId: string;
  segmentIndex: number;
  term: string;
  sentenceContext: string;
  note?: string;
  /** Pre-computed by the popover's live preview, to skip a duplicate lookup on save. */
  translation?: string;
  translationSource?: "free_library" | "gemini";
  phonetic?: string;
  partOfSpeech?: string;
  definition?: string;
  definitionSource?: "free_dictionary" | "gemini";
  imageUrl?: string;
  imageThumbnailUrl?: string;
  imageAttribution?: string;
  imageSourceUrl?: string;
}

export interface VocabularyUpdateRequest {
  id: string;
  term?: string;
  sentenceContext?: string;
  note?: string | null;
  translation?: string | null;
  phonetic?: string | null;
  partOfSpeech?: string | null;
  definition?: string | null;
}

export interface VocabularyPreviewRequest {
  text: string;
  isWord: boolean;
}

export interface VocabularyPreviewResponse {
  translation: { text: string; source: "free_library" } | null;
  /**
   * True when a translation was attempted but failed (e.g. the free
   * Google-Translate scraper got rate-limited/blocked), as opposed to
   * `translation` being null because there's genuinely nothing to show.
   * Lets the client tell "temporarily unavailable" apart from "no result".
   */
  translationFailed?: boolean;
  wordDetails: {
    phonetic: string | null;
    partOfSpeech: string | null;
    definition: string | null;
    example: string | null;
    audioUrl: string | null;
    source: "free_dictionary";
  } | null;
  image: {
    url: string;
    thumbnailUrl: string;
    attribution: string;
    sourceUrl: string;
    license: string;
  } | null;
}

export interface Bookmark {
  id: string;
  user_id: string;
  video_id: string;
  segment_index: number;
  start_sec: number;
  sentence_text: string;
  note: string | null;
  created_at: string;
}

export interface BookmarkRequest {
  videoId: string;
  segmentIndex: number;
  startSec: number;
  sentenceText: string;
  note?: string;
}

// ---- Vocabulary spaced-repetition review ----

export type ReviewGrade = "again" | "hard" | "good" | "easy";

export interface VocabularyReviewSubmitRequest {
  itemId: string;
  grade: ReviewGrade;
}

export interface VocabularyReviewSubmitResponse {
  item: VocabularyItem;
}
