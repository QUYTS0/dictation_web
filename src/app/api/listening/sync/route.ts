import { NextRequest } from "next/server";
import { handleStudyActivityFlush } from "@/lib/practice/studyActivityRoute";

/**
 * Listening coverage sync (plan §6.3 / §9.6). Body: { videoId, transcriptId,
 * flushBatchId, intervals (media seconds, raw — replays included),
 * currentPositionSec, studySessionId?, clientTimezone? }. Coverage is
 * computed by the database against the revision's valid-sentence union; a
 * retried batch is a no-op; `studySessionId` in the response is the session
 * this batch was recorded under.
 */
export async function POST(request: NextRequest) {
  return handleStudyActivityFlush(request, "listening");
}
