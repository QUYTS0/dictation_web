import type { ResumableSession } from "@/lib/types";

/** Where clicking a resumable session (dictation or listening) in Dashboard/History should go. */
export function resumableSessionHref(session: ResumableSession): string {
  if (session.mode === "dictation" && session.status === "completed") {
    return `/results/${session.sessionId}`;
  }
  return `/${session.mode}/${session.videoId}`;
}
