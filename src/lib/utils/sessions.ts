import type { ResumableSession } from "@/lib/types";

/**
 * Where clicking a resumable session (dictation or listening) in
 * Dashboard/History should go. Both modes open the same shared practice page
 * — listening sessions carry `?mode=listening` so it opens in Listening Mode
 * instead of routing to a separate page.
 */
export function resumableSessionHref(session: ResumableSession): string {
  if (session.mode === "dictation" && session.status === "completed") {
    return `/results/${session.sessionId}`;
  }
  return session.mode === "listening" ? `/dictation/${session.videoId}?mode=listening` : `/dictation/${session.videoId}`;
}
