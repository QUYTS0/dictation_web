import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { syncStudyActivity, StudyActivityError, type FlushActivityKind } from "@/lib/supabase/studySession";
import { isUuid } from "./validation";
import type { Interval } from "./listeningTypes";

/**
 * Shared handler for POST /api/listening/sync and POST
 * /api/study-session/activity (plan §9.6). Validates the payload shape, then
 * delegates everything else — replay detection, attribution to a study
 * session, relationship checks, merging — to ONE database transaction
 * (fn_sync_study_activity, 039). The route resolves no round and no session.
 *
 * Status codes tell the client's flush coordinator what to do with a batch:
 * 2xx → done; 400/403/404/409/422 → can never succeed, drop it; 401 → the
 * account is gone, drop it (never re-send under another account); 5xx /
 * network → keep and resend the SAME batch later.
 */

const MAX_INTERVALS = 1000;

function badRequest(message: string) {
  return NextResponse.json({ error: message, code: "invalid_payload" }, { status: 400 });
}

export function parseIntervals(value: unknown, kind: FlushActivityKind): Interval[] | null {
  if (!Array.isArray(value) || value.length > MAX_INTERVALS) return null;
  const out: Interval[] = [];
  for (const v of value) {
    if (!v || typeof v !== "object") return null;
    const { start, end } = v as { start?: unknown; end?: unknown };
    if (typeof start !== "number" || typeof end !== "number" || !Number.isFinite(start) || !Number.isFinite(end)) return null;
    if (end <= start || start < 0) return null;
    if (kind === "listening" && end > 1e7) return null;
    out.push({ start, end });
  }
  return out;
}

const CONFLICTS: Record<string, string> = {
  study_session_mismatch: "This study session doesn't belong to this lesson.",
  transcript_not_found_for_video: "This script isn't available for this video.",
  flush_batch_id_reused_with_different_payload: "This batch was already saved with different content.",
  round_mismatch: "This practice round doesn't belong to this lesson.",
  // Observed under a round that was replaced before any of its activity was
  // recorded: there is no session of that round to credit, and it is never
  // moved into another round's session.
  late_activity_without_session: "This activity belongs to an earlier practice round and can no longer be recorded.",
};

export function mapStudyActivityError(err: unknown): NextResponse {
  const e = err instanceof StudyActivityError ? err : null;
  const message = e?.message ?? "";
  if (message === "authentication_required") return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  if (message === "invalid_interval_payload" || message === "invalid_flush_kind") return badRequest("Invalid activity data.");
  if (message in CONFLICTS) return NextResponse.json({ error: CONFLICTS[message], code: message }, { status: 409 });
  if (e?.code === "PGRST202" || e?.code === "42883") {
    console.error("[study-activity] fn_sync_study_activity missing — is migration 039 applied?", e);
    return NextResponse.json({ error: "Progress saving isn't available yet.", code: "activity_unavailable", retryable: true }, { status: 503 });
  }
  console.error("[study-activity] flush failed:", message || err);
  return NextResponse.json({ error: "Couldn't save progress.", retryable: true }, { status: 500 });
}

export async function handleStudyActivityFlush(request: Request, kind: FlushActivityKind): Promise<NextResponse> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return badRequest("Invalid request body.");
    }
    const { videoId, transcriptId, flushBatchId, currentPositionSec, roundId, observedAgeSec, clientTimezone } = body;
    if (typeof videoId !== "string" || !videoId.trim() || videoId.length > 64) return badRequest("videoId is required.");
    if (!isUuid(flushBatchId)) return badRequest("flushBatchId is required.");
    if (roundId != null && !isUuid(roundId)) return badRequest("Invalid roundId.");
    if (
      observedAgeSec != null &&
      (typeof observedAgeSec !== "number" || !Number.isFinite(observedAgeSec) || observedAgeSec < 0 || observedAgeSec > 7 * 86400)
    ) {
      return badRequest("Invalid observedAgeSec.");
    }
    if (clientTimezone != null && (typeof clientTimezone !== "string" || clientTimezone.length > 64)) return badRequest("Invalid clientTimezone.");
    const intervals = parseIntervals(body.intervals, kind);
    if (!intervals) return badRequest("Invalid intervals.");
    if (kind === "listening") {
      if (transcriptId != null && !isUuid(transcriptId)) return badRequest("Invalid transcriptId.");
      if (
        currentPositionSec != null &&
        (typeof currentPositionSec !== "number" || !Number.isFinite(currentPositionSec) || currentPositionSec < 0 || currentPositionSec > 1e7)
      ) {
        return badRequest("Invalid currentPositionSec.");
      }
    }

    const result = await syncStudyActivity(supabase, {
      kind,
      youtubeVideoId: videoId,
      flushBatchId,
      roundId: (roundId as string | null | undefined) ?? null,
      observedAgeSec: (observedAgeSec as number | null | undefined) ?? null,
      intervals,
      transcriptId: kind === "listening" ? ((transcriptId as string | null | undefined) ?? null) : null,
      currentPositionSec: kind === "listening" ? ((currentPositionSec as number | null | undefined) ?? null) : null,
      clientTimezone: (clientTimezone as string | null | undefined) ?? null,
    });
    return NextResponse.json(result);
  } catch (err) {
    return mapStudyActivityError(err);
  }
}
