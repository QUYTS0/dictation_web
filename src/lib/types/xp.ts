/** First-occurrence event counts of one local day (fn_my_xp, migration 048). */
export interface XpDayActivity {
  dictationSentences: number;
  shadowingSentences: number;
  /** Distinct words reviewed that day (incl. reviews past the daily XP cap). */
  wordsReviewed: number;
  /** Whole minutes of newly covered Listening, dated at the session start. */
  listeningMin: number;
}

export interface XpDay {
  /** YYYY-MM-DD in the viewer's timezone. */
  date: string;
  xp: number;
  activity: XpDayActivity;
}

/** GET /api/xp: the caller's XP (rules v1) plus the derived level. */
export interface XpSummary {
  rulesVersion: number;
  /** The viewer's zone (dates of `today` and `days`). */
  timeZone: string;
  /** The learner's XP zone (the local-day rules). */
  xpTimeZone: string;
  today: string;
  totalXp: number;
  todayXp: number;
  level: number;
  levelStartXp: number;
  nextLevelXp: number;
  /** ISO instant: Monday 00:00 UTC of the current league week. */
  leagueWeekStart: string;
  leagueWeekXp: number;
  /** The previous league week — the Monday recap. */
  lastLeagueWeek: { weekStart: string; xp: number; activeSec: number; wordsReviewed: number };
  /** 14 local days ending today, oldest first. */
  days: XpDay[];
}
