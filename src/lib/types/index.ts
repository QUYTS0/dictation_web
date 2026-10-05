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
  /** Signed-in callers: whether this call created the Library card (false = it already existed). */
  libraryAdded?: boolean;
}

export interface TranscriptResponse {
  status: "ready" | "processing" | "failed";
  source?: "cache" | "ai" | "manual";
  title?: string | null;
  segments: TranscriptSegment[];
  /** The revision this response actually describes — null only when no
   *  transcript row exists for this video/language at all yet (Phase 0).
   *  When a `transcriptId` was requested (`?transcriptId=`), this always
   *  echoes that exact id; a request for one that doesn't exist or belongs
   *  to a different video/language gets a 404 instead, never a silent
   *  substitution with the current revision. */
  transcriptId?: string | null;
  /** The real `transcripts.version` integer for this revision, when the
   *  row is known (never present for the "processing"/"no transcript yet"
   *  responses) — a genuine identifier, never a fabricated/guessed number.
   *  Used only as secondary display metadata (e.g. transcript export). */
  version?: number | null;
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
  /** Recomputes every segment from scratch instead of reusing cached rows — used by "Regenerate translation". */
  force?: boolean;
}

export interface TranslateTranscriptResponse {
  status: "ready" | "error";
  language: string;
  translations: TranslationSegment[];
  error?: string;
}

// ---- Vocab highlighting (AI-picked difficult words/phrases per segment) ----

export interface VocabHighlightPhrase {
  /** Exact substring of the segment's text worth a learner's attention. */
  phrase: string;
  /**
   * Null when no translation is available for this highlight — the client
   * falls back to /api/vocabulary/preview for those (see
   * useLessonCapture.ts's showPhrasePreview). The deterministic pipeline
   * never produces its own translation; only legacy Gemini-era rows do.
   */
  translation: string | null;
  /** Half-open [start, end) UTF-16 offsets into this segment's text_raw.
   *  Optional: absent on any pre-migration cached row, which still renders
   *  via helpers.ts's substring-search fallback. */
  start?: number;
  end?: number;
  /** Dictionary/normalized form this exact wording is an instance of, e.g.
   *  "pair with" for the surface "paired with" or "give up" for "given up".
   *  Set by lemma-based lexicon matching (candidates.ts) for any recognized
   *  WordNet/EFLLex/supplementary MWE, and by the construction-expansion
   *  stage for its own curated matches — not construction-only. Rendered as
   *  the primary learning title (selection popover, saved-vocabulary lists)
   *  when it differs from the surface phrase. */
  canonicalForm?: string;
  /** Optional reusable usage pattern, e.g. "go a long way toward(s) +
   *  noun/V-ing" — construction-expansion only (plain lexicon matches don't
   *  have reliable pattern data). Rendered in the selection popover/hover
   *  tooltip and, once persisted, in saved-vocabulary lists. */
  learningPattern?: string;
}

export interface VocabHighlightSegment {
  segmentIndex: number;
  phrases: VocabHighlightPhrase[];
}

export interface VocabHighlightsRequest {
  videoId: string;
  transcriptId: string;
  /** Defaults server-side to DEFAULT_LEARNING_LEVEL when omitted. */
  learningLevel?: "A1" | "A2" | "B1" | "B2" | "C1";
  /** Bypasses the cache read for the current (learningLevel, pipelineVersion)
   *  pair and recomputes. Mirrors transcript/translate's `force`. */
  force?: boolean;
}

export interface VocabHighlightsResponse {
  status: "ready" | "error";
  highlights: VocabHighlightSegment[];
  error?: string;
  /** true when one or more requested segments could not be resolved this
   *  request (transient failure/deadline) and should be retried later —
   *  lets the client distinguish "still pending" from "genuinely no
   *  highlights". */
  incomplete?: boolean;
}

export interface CheckAnswerRequest {
  sessionId?: string;
  segmentIndex: number;
  userText: string;
  /** Only used when the answer is NOT recorded (guest / no round). A
   *  recorded answer is always graded against the round's pinned segment,
   *  resolved server-side. */
  expectedText?: string;
  matchMode?: MatchMode;
  /** Phase 3 — all optional for old tabs (see the route for defaults). */
  clientAttemptId?: string;
  hintLevelUsed?: number | null;
  studySessionId?: string | null;
  transcriptId?: string | null;
  youtubeVideoId?: string | null;
}

/** Round progress as computed by the database (Phase 3). */
export interface RoundProgress {
  requiredSentenceCount: number | null;
  coveredSentences: { dictation: number; shadowing: number; overall: number };
  coverage: { dictation: number | null; shadowing: number | null; overall: number | null };
  /** All Dictation submissions recorded for the round (retries included). */
  attemptCount: number;
  /** Correct LATEST Dictation attempt per practiced sentence ÷ practiced sentences. */
  sentenceAccuracy: { correct: number; practiced: number; percent: number | null };
}

export interface CheckAnswerResponse extends CheckResult {
  sessionId?: string;
  /** false when the answer was graded but not persisted (guest / no round). */
  recorded?: boolean;
  attemptId?: string;
  clientAttemptId?: string;
  wasInserted?: boolean;
  roundCompletedByThisRequest?: boolean;
  roundStatus?: "active" | "completed" | "abandoned";
  progress?: RoundProgress;
  coverage?: RoundProgress["coverage"];
  studySessionId?: string | null;
}

export interface AIExplainRequest {
  /** Required (Learning Reports P4): the owned attempt to explain. Its stored texts are used. */
  attemptId: string;
  /** Ignored since P4 — the attempt's own stored reference/answer are authoritative. */
  expectedText?: string;
  userText?: string;
  /** "missing" (default): reuse a saved note when one exists. "reexplain": explicit replacement. */
  intent?: "missing" | "reexplain";
}

export interface AIExplainResponse {
  explanation: string;
  correctedText: string;
  example: string;
  tip?: string;
  /** Learning Reports P4: true only when the note is stored (a reused note is stored). */
  saved?: boolean;
  /** True when a saved note was returned and no provider call was made. */
  reused?: boolean;
}

export interface SaveProgressRequest {
  sessionId?: string;
  youtubeVideoId: string;
  transcriptId?: string;
  currentSegmentIndex: number;
  videoCurrentTimeSec?: number;
  /** @deprecated Sent only by pre-Phase-8 tabs; accepted and ignored. */
  accuracy?: number;
  /** @deprecated Sent only by pre-Phase-8 tabs; accepted and ignored. */
  totalAttempts?: number;
  /** @deprecated Sent only by pre-Phase-8 tabs; accepted and ignored —
   *  "completed" never completes a round (completion is server-owned). */
  status?: "active" | "completed" | "abandoned";
}

export interface SaveProgressResponse {
  sessionId: string;
  status: string;
}

export interface ResumeSessionResponse {
  /** Phase 6: the last EXPLICIT mode switch for this video (any device); null = never switched. */
  lastMode?: "dictation" | "listening" | "shadowing" | null;
  /** Phase 6: Listening for the video's current revision, independent of any round. */
  listening?: {
    transcriptId: string | null;
    coverageRatio: number | null;
    listenedThrough: boolean;
    lastPositionSec: number | null;
    /** Listening exists under ANY revision (possibly not the current one). */
    hasHistory: boolean;
  };
  session: {
    sessionId: string;
    currentSegmentIndex: number;
    videoCurrentTimeSec: number;
    accuracy: number;
    totalAttempts: number;
    updatedAt: string;
    status: "active" | "completed" | "abandoned";
    /** The transcript revision this session is pinned to — null only for a
     *  session created before this column was ever populated (Phase 0). A
     *  client must fetch this exact revision to resume/practice against,
     *  never "whatever is current now". */
    transcriptId: string | null;
    /** Phase 3 additions (optional for compatibility). */
    roundNumber?: number;
    provenance?: "current" | "legacy_unverified";
    requiredSentenceCount?: number | null;
    /** Latest Dictation result per practiced sentence of this round — seeds
     *  the client's sentence-accuracy map on resume. */
    latestDictationResults?: Array<{ segmentIndex: number; isCorrect: boolean }>;
    /** Phase 6: the round's server-side progress (null if unavailable). */
    progress?: RoundProgress | null;
    /** Learning Reports P2: the video's active round when this one isn't it (null otherwise). */
    newerActiveRound?: { roundId: string; roundNumber: number } | null;
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
  /**
   * Learning Reports P4: the saved explanation shown for this sentence
   * (attempt_explanations, incl. copies of legacy ai_feedback rows). See
   * `ExplanationContext` for how it relates to this answer.
   */
  aiFeedback: ({ explanation: string; correctedText: string; example: string; tip?: string } & Partial<ExplanationContext>) | null;
}

/** Learning Reports P4: how a saved explanation relates to the answer it is shown for. */
export interface ExplanationContext {
  /** "attempt": this answer's own; "pattern": the same mistake in another sentence of the round; "earlier_answer": an earlier wrong answer to this sentence. */
  via: "attempt" | "pattern" | "earlier_answer";
  /** 0-based sentence carrying the note (for "pattern"). */
  viaSegmentIndex?: number;
  /** The explained answer is no longer the sentence's latest answer. */
  historical: boolean;
  /** Copied from the pre-P4 table: generation rules/version unknown ("earlier explanation"). */
  legacy: boolean;
  /** P5: "minor" / "duplicate" notes carry a short note instead of a full explanation. */
  kind?: "explanation" | "minor" | "duplicate";
  /** P5 duplicate: the 0-based sentence whose explanation it refers to. */
  refSegmentIndex?: number;
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
  /** Phase 6: the whole-round report (every metric, all study sessions of this round). */
  round: import("./learning").RoundReport;
  /**
   * Learning Reports P1: the stored, practice-valid Dictation answers each
   * sentence's deterministic analysis needs (latest answer, last mistake,
   * matching rule). Optional: absent from older responses.
   */
  dictationEvidence?: import("@/lib/practice/dictationAnalysis").DictationEvidence;
  /** Learning Reports P2: the video's active round when it isn't this one (continuation is then refused). */
  newerActiveRound?: { roundId: string; roundNumber: number } | null;
  /** Learning Reports P4: saved explanations couldn't be loaded (the rest of the report is unaffected). */
  explanationsUnavailable?: boolean;
  /** Learning Reports P5: the AI assessment block (null when unavailable; read-only). */
  ai?: import("@/lib/ai/types").ReportAiView | null;
  /** Learning Reports P3: the version number of the round's pinned script (null if unknown). */
  transcriptVersion?: number | null;
  /**
   * Learning Reports P3: Listening is stored per video + SCRIPT VERSION, not
   * per round — `coverageRatio`/`listenedThrough`/`lastPositionSec` cover every
   * sitting on this script version. Only the two `roundSittings…` figures come
   * from this round's own study sessions. Media time, never attention.
   */
  listening?: {
    coverageRatio: number | null;
    listenedThrough: boolean;
    lastPositionSec: number | null;
    roundSittingsNewlyCoveredSec: number;
    roundSittingsObservedSec: number;
  } | null;
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
  /** Learning Reports P4: relation of a saved note to this answer (from the report). */
  context?: ExplanationContext;
  /** Learning Reports P4: generated this visit but NOT stored — gone after a reload. */
  unsaved?: boolean;
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
  /** Whether the assessment was persisted (it is still returned for display
   *  when saving failed — it just won't be there after a reload). */
  assessmentSaved?: boolean;
  /** Learning Reports P4: what happened to the per-mistake explanations. */
  explanations?: ExplainAllExplanationsOutcome;
}

/**
 * Learning Reports P4 — the explanation half of explain-all, reported apart
 * from the (unchanged) overview:
 *   saved       — new notes stored (`saved` of `requested`)
 *   reused      — every target already had a saved note: no explanation was requested
 *   not_saved   — generated but storing failed: shown this visit only
 *   none_usable — the response had no usable note: nothing stored
 *   no_targets  — no explainable mistakes (e.g. only spacing slips)
 */
export interface ExplainAllExplanationsOutcome {
  status: "saved" | "reused" | "not_saved" | "none_usable" | "no_targets";
  requested: number;
  saved: number;
  /** Targets skipped because a saved note already covers them. */
  alreadySaved: number;
  /** Missing targets left for a later request (past the per-request cap). */
  remaining: number;
}

export interface VocabularyItem {
  id: string;
  user_id: string;
  video_id: string;
  segment_index: number;
  term: string;
  normalized_term: string;
  /** Dictionary/normalized learning form, e.g. "give up" for a saved term
   *  of "given up" — set only when the item was captured from a recognized
   *  highlight (see VocabHighlightPhrase.canonicalForm). Null for manual
   *  selections and for every row saved before this column existed;
   *  rendering must fall back to `term` (`canonical_form ?? term`), never
   *  assume it's present. */
  canonical_form: string | null;
  /** Reusable usage pattern, e.g. "go a long way toward(s) + noun/V-ing" —
   *  same optional, construction-expansion-only origin as
   *  VocabHighlightPhrase.learningPattern. Null unless the source highlight
   *  had one; never displayed as an empty heading when absent. */
  learning_pattern: string | null;
  sentence_context: string;
  note: string | null;
  translation: string | null;
  translation_language: string;
  translation_source: "azure" | "free_library" | "gemini" | null;
  phonetic: string | null;
  part_of_speech: string | null;
  definition: string | null;
  definition_source: "free_dictionary" | "gemini" | null;
  /** Pronunciation-audio URL from the free dictionary API's phonetics[].audio
   *  field (see lookupWordDetails, src/lib/dictionary.ts) — single words
   *  only, since that lookup never runs for multi-word phrases. Null for
   *  every row saved before this column existed and for any word the
   *  dictionary had no audio for. */
  audio_url: string | null;
  /** FK into vocabulary_audio_assets — an on-demand Azure TTS clip resolved
   *  by POST /api/vocabulary/pronounce for a word with no dictionary audio,
   *  or for any phrase (dictionary lookup never applies to phrases). Null
   *  until the first successful pronunciation tap for this item; nulled
   *  again by PATCH whenever `term` changes (see the route's
   *  invalidation-on-term-change rule). The client never reads
   *  storage_path directly from this id — resolving it to a playable URL
   *  always goes through the pronounce route. */
  pronunciation_audio_asset_id: string | null;
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

/** Server-computed, exact-count aggregate stats for the Vocabulary Bank
 *  page (GET /api/vocabulary/stats) — deliberately separate from the
 *  GET /api/vocabulary item list so these numbers stay correct regardless
 *  of any row cap the list fetch might be subject to, and so the two can
 *  load/error independently. `new`/`learning`/`due` are computed via
 *  getVocabularyLearningStatus's SQL equivalent (src/lib/utils/vocabulary.ts)
 *  and are mutually exclusive and exhaustive: new + learning + due === total. */
export interface VocabularyStatsResponse {
  total: number;
  new: number;
  learning: number;
  due: number;
  /** Count of items currently admissible into the review queue
   *  (next_review_at <= now(), regardless of last_reviewed_at) — the exact
   *  same predicate GET /api/vocabulary/review uses to admit items, kept as
   *  its own field rather than derived client-side from new+due so the two
   *  can never drift apart (see isVocabularyItemReviewable). */
  reviewable: number;
}

export interface VocabularyRequest {
  videoId: string;
  segmentIndex: number;
  term: string;
  sentenceContext: string;
  note?: string;
  /** From the current highlight's canonicalForm/learningPattern, when the
   *  saved text was a recognized highlight — omitted (not sent) for a
   *  manual selection with no match. Omitted means "unknown", never treated
   *  as "clear this field": see the route's update-preserves-on-omit
   *  semantics, which matters when re-saving over an existing row. */
  canonicalForm?: string;
  learningPattern?: string;
  /** Pre-computed by the popover's live preview, to skip a duplicate lookup on save. */
  translation?: string;
  translationSource?: "azure" | "free_library" | "gemini";
  phonetic?: string;
  partOfSpeech?: string;
  definition?: string;
  definitionSource?: "free_dictionary" | "gemini";
  audioUrl?: string;
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
  /** Backfill-only, not a general edit field: applied server-side ONLY when
   *  `term` is not changing in this same request AND the item's persisted
   *  canonical_form/learning_pattern is currently null — never overwrites
   *  an existing verified value. Lets the client silently persist a
   *  canonical form it already resolved from the live highlight cache for
   *  a legacy row (see resolveVocabularyHighlightMeta in helpers.ts), so
   *  future reads — and pronunciation, which only ever trusts the
   *  persisted column — resolve identically without needing that cache. */
  canonicalForm?: string;
  learningPattern?: string;
}

export interface VocabularyPreviewRequest {
  text: string;
  isWord: boolean;
}

export type TranslationErrorCode =
  | "TRANSLATION_CONFIG_ERROR"
  | "TRANSLATION_AUTH_ERROR"
  | "TRANSLATION_RATE_LIMITED"
  | "TRANSLATION_TIMEOUT"
  | "TRANSLATION_INVALID_RESPONSE"
  | "TRANSLATION_SERVICE_ERROR"
  | "TRANSLATION_INVALID_INPUT";

export interface VocabularyPreviewResponse {
  translation: {
    text: string;
    source: "azure" | "gemini";
    /** Other dictionary senses for a single word, most-relevant first. */
    alternatives?: { text: string; partOfSpeech?: string | null }[];
  } | null;
  /**
   * True when a translation was attempted but failed (Azure error, timeout,
   * rate limit, etc.), as opposed to `translation` being null because
   * there's genuinely nothing to show. Lets the client tell "temporarily
   * unavailable" apart from "no result". Mirrors `!!translationError`.
   */
  translationFailed?: boolean;
  /** Stable code + human-readable message for the failure, when translationFailed is true. */
  translationError?: { code: TranslationErrorCode; message: string } | null;
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

// ---- Vocabulary pronunciation (Azure TTS on-demand synthesis) ----

export type VocabularyAudioSource = "dictionary" | "cached" | "synthesized";

export type TtsErrorCode =
  | "TTS_NOT_CONFIGURED"
  | "TTS_RATE_LIMITED"
  | "TTS_QUOTA_EXCEEDED"
  | "TTS_UPSTREAM_ERROR"
  | "TTS_STORAGE_ERROR"
  | "NOT_FOUND";

export interface VocabularyPronounceRequest {
  itemId: string;
  /** Explicit, user-initiated recovery only (see the "Use generated
   *  pronunciation" action) — skips the dictionary-audio shortcut for this
   *  one request so the server resolves/synthesizes an Azure alternative
   *  instead. Never set automatically by a normal tap. */
  preferGenerated?: boolean;
}

export interface VocabularyPronounceResponse {
  audioUrl: string;
  source: VocabularyAudioSource;
}

export interface VocabularyPronounceErrorResponse {
  error: string;
  code: TtsErrorCode;
}
