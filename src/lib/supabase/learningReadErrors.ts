import { NextResponse } from "next/server";

/**
 * Maps errors from the Phase 6 read/membership functions (migration 040) to
 * HTTP responses. Every RAISE there uses a stable message code.
 * A missing function (040 not applied yet) is a 503 with a stable code — the
 * app must never be deployed before 040 (supabase/PHASE6_RUNBOOK.md), but if
 * it is, the pages show a retryable error instead of a crash or fake zeros.
 */
export function mapLearningReadError(
  error: { message?: string; code?: string } | null | undefined,
  context: string,
  migration = "040"
): NextResponse {
  const message = error?.message ?? "";
  if (message === "authentication_required") return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  if (message === "invalid_payload") return NextResponse.json({ error: "Invalid request.", code: "invalid_payload" }, { status: 400 });
  if (message === "round_not_found") {
    return NextResponse.json({ error: "Practice round not found.", code: "round_not_found" }, { status: 404 });
  }
  if (error?.code === "PGRST202" || error?.code === "42883") {
    console.error(`[${context}] read function missing — apply migration ${migration} before deploying this app`, error);
    return NextResponse.json({ error: "This feature is not available yet.", code: "learning_data_unavailable" }, { status: 503 });
  }
  console.error(`[${context}] RPC error:`, error);
  return NextResponse.json({ error: "Couldn't load your learning data." }, { status: 500 });
}

export const VIDEO_ID_MAX_LENGTH = 64;

export function isVideoId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= VIDEO_ID_MAX_LENGTH;
}
