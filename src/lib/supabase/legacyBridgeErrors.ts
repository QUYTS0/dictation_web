import { NextResponse } from "next/server";

/**
 * Maps a Postgres error raised by one of the Phase 2 legacy-bridge RPCs
 * (fn_legacy_save_progress / fn_legacy_restart_round /
 * fn_legacy_record_dictation_attempt, migration 035) to the HTTP response
 * the corresponding route should return. Every RAISE EXCEPTION in those
 * functions uses a plain message string (default SQLSTATE P0001) —
 * PostgREST/supabase-js surface that exact string as `error.message`, so
 * this switches on it directly rather than trying to parse SQLSTATE.
 *
 * `fallback` is the route's own pre-existing generic error text, kept so a
 * caller migrating from a raw `.insert()`/`.update()` to `.rpc()` doesn't
 * change its unmatched-error copy.
 */
export function mapLegacyBridgeError(
  error: { message?: string } | null | undefined,
  fallback: string
): NextResponse {
  const message = error?.message ?? "";

  if (message === "write_gate_paused") {
    // Stable, retryable response — the gate is a brief pause for the
    // future Phase 3 cutover, never a route-level bug. 30s is a
    // reasonable fixed backoff; the gate carries no expected-resume
    // timestamp to compute a tighter one from.
    const res = NextResponse.json(
      {
        error: "Saving is temporarily paused for maintenance. Please try again shortly.",
        code: "write_gate_paused",
      },
      { status: 503 }
    );
    res.headers.set("Retry-After", "30");
    return res;
  }

  if (message === "write_gate_missing") {
    // The singleton app_write_gate row (migration 029) is absent — a
    // deployment/configuration defect, not a normal runtime state. Fails
    // closed (never silently falls back to writing without the gate).
    console.error("[legacyBridge] write_gate_missing — app_write_gate row absent");
    return NextResponse.json({ error: "Server configuration error." }, { status: 500 });
  }

  if (message === "stale_transcript_revision") {
    return NextResponse.json(
      {
        error: "The transcript revision has changed since this page loaded. Please refresh and try again.",
        code: "stale_transcript_revision",
      },
      { status: 409 }
    );
  }

  if (message === "transcript_not_ready") {
    return NextResponse.json(
      { error: "No ready transcript exists for this video yet.", code: "transcript_not_ready" },
      { status: 409 }
    );
  }

  if (message === "authentication_required") {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  console.error("[legacyBridge] RPC error:", error);
  return NextResponse.json({ error: fallback }, { status: 500 });
}
