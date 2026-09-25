import { NextResponse } from "next/server";
import { mapPracticeWriteMessage } from "./practiceWriteErrors";

/**
 * Maps a Postgres error raised by one of the Phase 2 legacy-bridge RPCs
 * (fn_legacy_save_progress / fn_legacy_restart_round /
 * fn_legacy_record_dictation_attempt, migration 035) to the HTTP response
 * the corresponding route should return. Shares its message table with the
 * Phase 3 mapper (practiceWriteErrors.ts) so both write paths answer a
 * maintenance pause identically (503, retryable) — including the Phase 3
 * `legacy_writes_retired` refusal a bridge raises once the cutover retired it.
 *
 * `fallback` is the route's own generic error text for unmatched errors.
 */
export function mapLegacyBridgeError(
  error: { message?: string; code?: string } | null | undefined,
  fallback: string
): NextResponse {
  const mapped = mapPracticeWriteMessage(error);
  if (mapped) return mapped;
  console.error("[legacyBridge] RPC error:", error);
  return NextResponse.json({ error: fallback }, { status: 500 });
}
