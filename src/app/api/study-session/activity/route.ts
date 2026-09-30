import { NextRequest } from "next/server";
import { handleStudyActivityFlush } from "@/lib/practice/studyActivityRoute";

/**
 * Generic activity pulses (plan §6.3b): engaged wall-clock intervals (epoch
 * seconds) merged into the study session's activity_intervals — the basis of
 * estimated active practice time. Retry-safe via flushBatchId.
 */
export async function POST(request: NextRequest) {
  return handleStudyActivityFlush(request, "activity");
}
