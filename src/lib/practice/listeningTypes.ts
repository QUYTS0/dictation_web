// Wire types for Phase 5 Listening coverage and activity pulses (client-safe).

/** Tuning constants (plan §4 table / §6.3 / §6.3b). Product defaults. */
export const LISTENING = {
  /** Client-side continuity only: a position jump larger than this vs. the
   *  rate-aware expectation starts a new interval (a seek). */
  SEEK_DETECTION_TOLERANCE_SEC: 2,
  /** A wall-clock gap longer than this between ticks (suspended/throttled
   *  tab) also starts a new interval, however small the position delta. */
  MAX_TICK_GAP_SEC: 5,
  /** Periodic flush after this much PLAYING time. */
  SYNC_FLUSH_INTERVAL_SEC: 15,
  /** Worst-case retained unsent data under sustained failure; beyond it the
   *  oldest buffered data is dropped. */
  MAX_PENDING_BUFFER_SEC: 300,
  /** listened_through threshold — mirrors the SQL (0.90). */
  LISTENED_THROUGH_THRESHOLD: 0.9,
} as const;

export const ACTIVITY = {
  /** A pulse credits [t - LOOKBACK, t] of engaged wall-clock time. */
  PULSE_LOOKBACK_SEC: 15,
  /** Pulses only while real interaction happened within this window. */
  PULSE_ENGAGEMENT_WINDOW_SEC: 45,
  /** Periodic activity flush cadence (wall clock). */
  FLUSH_INTERVAL_SEC: 20,
} as const;

export interface Interval {
  start: number;
  end: number;
}

export interface StudyFlushResult {
  processed: boolean;
  coverageRatio?: number;
  listenedThrough?: boolean;
  coveredSec?: number;
  /** The checkpoint actually stored for the revision (not an echo). */
  lastPositionSec?: number;
  hasHistory?: boolean;
  /** Length of the revision's valid-sentence union (null without a revision). */
  transcriptCoveredSec?: number | null;
  /** The study session this batch is recorded under. */
  studySessionId: string;
  /** current = ordinary session rule; late = applied to the observed
   *  round's last session without touching it; replay = already recorded. */
  attribution: "current" | "late" | "replay";
}

/** POST /api/listening/sync */
export interface ListeningSyncRequest {
  videoId: string;
  transcriptId: string | null;
  flushBatchId: string;
  intervals: Interval[];
  currentPositionSec: number | null;
  /** The round the observations were made under (null = no round then). */
  roundId: string | null;
  /** Seconds since the newest observation in this batch, by the client's
   *  own clock at send time (a difference — immune to clock skew). */
  observedAgeSec?: number | null;
  clientTimezone?: string | null;
}

export type ListeningSyncResponse = StudyFlushResult;

/** POST /api/study-session/activity */
export interface ActivityFlushRequest {
  videoId: string;
  flushBatchId: string;
  /** Wall-clock epoch seconds. */
  intervals: Interval[];
  roundId: string | null;
  observedAgeSec?: number | null;
  clientTimezone?: string | null;
}

/** GET /api/listening/progress?videoId=&transcriptId= */
export interface ListeningProgressResponse {
  videoId: string;
  transcriptId: string | null;
  coveredSec: number;
  /** Length of the revision's valid-sentence union; null until first synced. */
  transcriptCoveredSec: number | null;
  coverageRatio: number;
  listenedThrough: boolean;
  listenedThroughAt: string | null;
  lastPositionSec: number;
  hasHistory: boolean;
}
