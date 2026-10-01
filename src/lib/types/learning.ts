// =====================================================
// Phase 6 read models (migration 040) — Library, Dashboard, History and the
// whole-round report. Every field is computed by the database from the
// authoritative tables; nothing here is derived from user_videos convenience
// columns except lastMode.
// =====================================================

import type { ErrorType, RoundProgress } from "./index";

export type PracticeMode = "dictation" | "listening" | "shadowing";

export type LibraryState = "not_started" | "in_progress" | "completed" | "listening" | "listening_prior_revision";

export type LibraryFilter = "all" | "continue" | "in_progress" | "completed" | "not_started" | "listening";

export const LIBRARY_FILTERS: ReadonlyArray<LibraryFilter> = ["all", "continue", "in_progress", "completed", "not_started", "listening"];

export interface LibraryItem {
  videoId: string;
  title: string | null;
  addedAt: string;
  lastActivityAt: string;
  lastMode: PracticeMode | null;
  state: LibraryState;
  /** A round completed under the verified (Phase 3) rule exists. */
  hasCompletedRound: boolean;
  /** A round completed before the cutover (client-reported) exists. */
  hasLegacyCompletion: boolean;
  completedRoundCount: number;
  /** The active round if there is one, else the latest round; null = no round. */
  round: {
    roundId: string;
    status: "active" | "completed" | "abandoned";
    provenance: "current" | "legacy_unverified";
    roundNumber: number;
    transcriptId: string | null;
    startedAt: string;
    completedAt: string | null;
    currentSegmentIndex: number;
    progress: RoundProgress;
  } | null;
  /** Resolved against the video's CURRENT revision, independently of any round. */
  listening: {
    transcriptId: string | null;
    /** null = no Listening row for the current revision. */
    coverageRatio: number | null;
    listenedThrough: boolean;
    lastPositionSec: number | null;
    /** Listening under ANY revision. */
    hasHistory: boolean;
    /** Only another revision was listened to. */
    historyOnOtherRevision: boolean;
  };
}

export interface LibraryPage {
  items: LibraryItem[];
  total: number;
  limit: number;
  offset: number;
  filter: LibraryFilter;
  hasMore: boolean;
}

export interface SentenceAccuracySummary {
  correct: number;
  practiced: number;
  /** Latest answers from the unverified legacy history — not counted above. */
  excludedUnverified: number;
}

export interface ShadowingSummary {
  takes: number;
  practicedSentences: number;
  attemptedSentences: number;
  azure: {
    evaluatedSentences: number;
    pronunciation: number | null;
    accuracy: number | null;
    completeness: number | null;
    fluency: number | null;
    prosody: number | null;
  };
  wordMatch: {
    evaluatedSentences: number;
    accuracy: number | null;
    completeness: number | null;
  };
}

export interface ActivitySummary {
  /** Estimated engaged wall-clock seconds: union of activity intervals. */
  activeSec: number;
  /** First tracked activity (null = none tracked). No time before it is estimated. */
  trackedSince: string | null;
  sessionCount: number;
}

export interface DashboardSummary {
  completedVideos: number;
  legacyCompletedVideos: number;
  inProgressVideos: number;
  listenedThroughVideos: number;
  libraryVideos: number;
  sentenceAccuracy: SentenceAccuracySummary;
  shadowing: ShadowingSummary;
  activeTime: ActivitySummary;
  vocabularyCount: number;
  /** Consecutive local calendar days with practice (any mode). */
  streakDays: number;
  /** The zone "today" was evaluated in (viewer's, UTC fallback). */
  streakTimeZone: string;
  streakToday: string;
  /** A day of the current streak is known only from a UTC-dated record. */
  streakIncludesUtcFallback: boolean;
  recentVocabulary: Array<{ id: string; term: string; sentence_context: string; created_at: string }>;
}

export interface HistorySession {
  studySessionId: string;
  videoId: string;
  title: string | null;
  roundId: string | null;
  roundNumber: number | null;
  roundStatus: "active" | "completed" | "abandoned" | null;
  roundProvenance: "current" | "legacy_unverified" | null;
  startedAt: string;
  lastActivityAt: string;
  endedAt: string | null;
  modesUsed: PracticeMode[];
  /** last activity − start: bookkeeping span, NOT practice time. */
  elapsedSpanSec: number;
  /** Estimated engaged wall-clock time (union of this session's intervals). */
  activeSec: number;
  /** Replay-inclusive MEDIA seconds (not wall clock at non-1× speeds). */
  listeningObservedSec: number;
  listeningNewlyCoveredSec: number;
  dictationSentences: number;
  shadowingSentences: number;
  overlapSentences: number;
  uniqueSentences: number;
  newlyCoveredInRound: number;
  dictationLatest: { correct: number; practiced: number };
}

export interface HistorySessionsPage {
  items: HistorySession[];
  hasMore: boolean;
  /** First page only. */
  unattributed: { legacyRounds: number; unattributedAnswers: number; unattributedTakes: number } | null;
}

export type ReportSentenceCategory = "needs_review" | "corrected" | "first_try" | "correct" | "shadowing_only";

export interface ReportSentence {
  segmentIndex: number;
  text: string | null;
  eligible: boolean;
  category: ReportSentenceCategory;
  dictation: {
    submissions: number;
    practiceSubmissions: number;
    /** null when the round's history is incomplete (never a guessed first attempt). */
    first: { correct: boolean; hintLevel: number | null; userText: string } | null;
    latest: {
      correct: boolean;
      userText: string;
      errorType: ErrorType | null;
      attemptId: string;
      createdAt: string;
    } | null;
    everIncorrect: boolean;
  } | null;
  shadowing: {
    takes: number;
    validTakes: number;
    latestAzure: { pronunciationScore: number | null; evaluatedAt: string | null; attemptId: string } | null;
    latestWordMatch: { accuracy: number | null; completeness: number | null; attemptId: string } | null;
  } | null;
}

export interface RoundReport {
  round: {
    roundId: string;
    videoId: string;
    title: string | null;
    transcriptId: string | null;
    status: "active" | "completed" | "abandoned";
    provenance: "current" | "legacy_unverified";
    roundNumber: number;
    requiredSentenceCount: number | null;
    startedAt: string;
    updatedAt: string;
    completedAt: string | null;
    completedAtApproximate: boolean;
    currentSegmentIndex: number;
  };
  /** Verified round with no unverified legacy answers: first-try and streak are provable. */
  historyComplete: boolean;
  progress: RoundProgress;
  dictation: {
    practicedSentences: number;
    latestCorrect: number;
    needsReview: number;
    corrected: number;
    submissions: number;
    invalidSubmissions: number;
    bestStreak: number | null;
    firstTry: {
      available: boolean;
      correct: number | null;
      correctWithHint: number | null;
      correctHintUnknown: number | null;
    };
    accuracy: SentenceAccuracySummary;
  };
  shadowing: ShadowingSummary;
  activity: ActivitySummary & { unattributedAnswers: number; unattributedTakes: number };
  sentences: ReportSentence[];
}

// ---- Script Versions (Phase 9, migration 041) ----

/** Why a revision is kept (plan §6.9). Generic labels — never counts or owners. */
export type RetentionReason =
  | "current"
  | "processing"
  | "practice_round"
  | "attempts"
  | "legacy_history"
  | "listening"
  | "legacy_listening"
  | "saved_words";

export interface TranscriptVersion {
  transcriptId: string;
  version: number;
  source: "cache" | "ai" | "manual";
  status: "processing" | "ready" | "failed";
  createdAt: string;
  supersededAt: string | null;
  isCurrent: boolean;
  sentenceCount: number;
  /** The VIEWER's own round pinned to this revision (never another user's). */
  yourRound: { roundId: string; status: "active" | "completed" | "abandoned"; roundNumber: number } | null;
  /** Logical row-storage estimate (not index overhead or compression; never "bytes freed"). */
  size: {
    textBytes: number | null;
    segmentsBytes: number | null;
    translationsBytes: number | null;
    highlightsBytes: number | null;
    /** No revision-owned file storage exists — always 0. */
    filesBytes: number;
    totalBytes: number | null;
    estimatedAt: string | null;
  };
  retention: {
    reasons: RetentionReason[];
    protected: boolean;
    /** When the grace period ends — only when nothing protects the revision. */
    eligibleAt: string | null;
    inGracePeriod: boolean;
    /** A classification under the retention rules, NOT "deletable now". */
    cleanupCandidate: boolean;
  };
  /** The size estimate for a cleanup candidate, else 0 (derived, never stored). */
  eligibleForRemovalBytes: number;
}

export interface TranscriptVersionsResponse {
  videoId: string;
  language: string;
  /** Always false in v1 — no role can execute revision deletion. */
  deletionEnabled: boolean;
  retentionGraceDays: number;
  revisions: TranscriptVersion[];
}

export interface TranscriptVersionPreview {
  transcriptId: string;
  videoId: string;
  version: number;
  status: "ready" | "failed";
  isCurrent: boolean;
  segments: Array<{ segmentIndex: number; start: number; end: number; text: string }>;
}
