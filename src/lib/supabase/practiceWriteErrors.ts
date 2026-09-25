import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Maps errors from the practice write RPCs — Phase 2 bridges and Phase 3
 * authoritative functions alike — to HTTP responses. Every RAISE in those
 * functions uses a plain, stable message (SQLSTATE P0001), surfaced by
 * PostgREST as `error.message`.
 *
 * The maintenance response (503 + Retry-After, code "write_gate_paused",
 * retryable: true) is what a client sees while the cutover pauses writes.
 * It is never shown for a genuine permission problem: an insufficient-
 * privilege error (42501) is only reported as maintenance when the database
 * itself confirms authoritative writes are not available yet
 * (fn_practice_write_status) — see mapPracticeWriteError.
 */
export interface PracticeRpcError {
  message?: string;
  code?: string;
}

export function maintenanceResponse(): NextResponse {
  const res = NextResponse.json(
    {
      error: "Saving is temporarily paused for maintenance. Your answer was not saved yet — please try again shortly.",
      code: "write_gate_paused",
      retryable: true,
    },
    { status: 503 }
  );
  res.headers.set("Retry-After", "30");
  return res;
}

const CONFLICTS: Record<string, string> = {
  stale_transcript_revision: "The transcript revision has changed since this page loaded. Please refresh and try again.",
  transcript_not_ready: "No ready transcript exists for this video yet.",
  segment_not_found: "That sentence does not exist in this lesson's script.",
  study_session_mismatch: "This practice session no longer matches the lesson. Please refresh.",
  idempotency_key_reused_with_different_payload: "This submission id was already used for a different answer.",
  round_transcript_unknown:
    "This saved lesson predates script versioning, so new answers can't be recorded against it. Restart the lesson to continue.",
};

/** Synchronous mapping of the stable message codes. Returns null if unmatched. */
export function mapPracticeWriteMessage(error: PracticeRpcError | null | undefined): NextResponse | null {
  const message = error?.message ?? "";
  if (message === "write_gate_paused" || message === "legacy_writes_retired") return maintenanceResponse();
  if (message === "write_gate_missing") {
    console.error("[practiceWrite] write_gate_missing — app_write_gate row absent");
    return NextResponse.json({ error: "Server configuration error." }, { status: 500 });
  }
  if (message === "authentication_required") {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  if (message === "round_not_found") {
    return NextResponse.json({ error: "Practice round not found.", code: "round_not_found" }, { status: 404 });
  }
  if (message === "invalid_payload") {
    return NextResponse.json({ error: "Invalid request.", code: "invalid_payload" }, { status: 400 });
  }
  if (message in CONFLICTS) {
    return NextResponse.json({ error: CONFLICTS[message], code: message }, { status: 409 });
  }
  return null;
}

/**
 * Full mapping, including the permission case. `supabase` must be the
 * caller's own (authenticated) client — the same one that made the failing
 * call.
 */
export async function mapPracticeWriteError(
  supabase: Pick<SupabaseClient, "rpc">,
  error: PracticeRpcError | null | undefined,
  fallback: string
): Promise<NextResponse> {
  const mapped = mapPracticeWriteMessage(error);
  if (mapped) return mapped;

  if (error?.code === "42501") {
    const { data } = await supabase.rpc("fn_practice_write_status");
    if ((data as { available?: boolean } | null)?.available === false) {
      // Phase 3 code deployed while the cutover is still paused/not
      // activated — expected during the maintenance window.
      return maintenanceResponse();
    }
    console.error("[practiceWrite] permission denied although writes are available — check the Phase 3 grants", error);
    return NextResponse.json({ error: fallback }, { status: 500 });
  }

  if (error?.code === "PGRST202" || error?.code === "42883") {
    console.error(
      "[practiceWrite] write function missing — is PRACTICE_WRITE_PATH set to the path this database supports?",
      error
    );
    return NextResponse.json({ error: fallback }, { status: 500 });
  }

  console.error("[practiceWrite] RPC error:", error);
  return NextResponse.json({ error: fallback }, { status: 500 });
}
