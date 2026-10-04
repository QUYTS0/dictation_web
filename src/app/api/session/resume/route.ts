import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { ResumeSessionResponse, RoundProgress } from "@/lib/types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROUND_COLUMNS =
  "id, current_segment_index, video_current_time, accuracy, total_attempts, updated_at, status, transcript_id, round_number, provenance, required_sentence_count";

export async function GET(request: NextRequest) {
  try {
    const videoId = request.nextUrl.searchParams.get("videoId");
    if (!videoId) {
      return NextResponse.json({ error: "videoId is required" }, { status: 400 });
    }
    // Learning Reports P2: an explicit continuation names its round. Without
    // it, the round to resume is the ACTIVE one, else the most recently
    // started — never "whatever was written last" (a late write to an old
    // round bumps its updated_at and must not make it win).
    const requestedRoundId = request.nextUrl.searchParams.get("roundId");
    if (requestedRoundId !== null && !UUID.test(requestedRoundId)) {
      return NextResponse.json({ error: "Invalid roundId." }, { status: 400 });
    }

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    // Fetch the latest session regardless of status (not just "active") so a
    // finished video reports its completed session back to the caller instead
    // of looking like a brand-new video — see resumeState.status handling in
    // useDictationSession, which is what stops a stale "in progress" row
    // from being spawned every time a completed video is reopened.
    //
    // Phase 6: Listening and the last explicit mode are resolved alongside,
    // INDEPENDENTLY of the round (a Listening-only video has no round).
    const rounds = () => supabase.from("learning_sessions").select(ROUND_COLUMNS).eq("user_id", user.id).eq("youtube_video_id", videoId);
    const loadRound = async () => {
      if (requestedRoundId) return rounds().eq("id", requestedRoundId).maybeSingle();
      const active = await rounds().eq("status", "active").limit(1).maybeSingle();
      if (active.error || active.data) return active;
      return rounds().order("started_at", { ascending: false }).order("id", { ascending: false }).limit(1).maybeSingle();
    };
    const [{ data, error }, membership, currentTranscript, historyCount] = await Promise.all([
      loadRound(),
      // The membership's mode, or — for a video the user removed from the
      // Library — the mode kept on its removal marker (040).
      supabase.rpc("fn_video_last_mode", { p_youtube_video_id: videoId }),
      supabase
        .from("transcripts")
        .select("id")
        .eq("youtube_video_id", videoId)
        .eq("language", "en")
        .eq("is_current", true)
        .eq("status", "ready")
        .maybeSingle(),
      supabase
        .from("listening_progress")
        .select("id", { head: true, count: "exact" })
        .eq("user_id", user.id)
        .eq("youtube_video_id", videoId),
    ]);

    if (error) {
      console.error("[session/resume] query error:", error);
      return NextResponse.json({ error: "Failed to fetch session" }, { status: 500 });
    }

    // Latest Dictation result per practiced sentence of this round (Phase 3
    // sentence accuracy) — owner-readable via RLS. Same ordering rule as
    // the database (created_at, then id), so client and server agree.
    let latestDictationResults: Array<{ segmentIndex: number; isCorrect: boolean }> = [];
    // The round's server-side progress (coverage per mode) — so a reopened
    // page shows the round's real coverage before any new submission.
    let progress: RoundProgress | null = null;
    // A round other than the active one: name the active round, so a
    // continuation of the old round can be refused (plan §5.3).
    let newerActiveRound: { roundId: string; roundNumber: number } | null = null;
    if (data && data.status !== "active") {
      const { data: act, error: activeError } = await supabase
        .from("learning_sessions")
        .select("id, round_number")
        .eq("user_id", user.id)
        .eq("youtube_video_id", videoId)
        .eq("status", "active")
        .limit(1)
        .maybeSingle();
      if (activeError) console.error("[session/resume] active round query error:", activeError);
      const a = act as { id: string; round_number: number | null } | null;
      if (a && a.id !== data.id) newerActiveRound = { roundId: a.id, roundNumber: a.round_number ?? 0 };
    }
    if (data) {
      const { data: p, error: progressError } = await supabase.rpc("fn_my_round_progress", { p_round_id: data.id });
      if (progressError) console.error("[session/resume] progress error:", progressError);
      else progress = (p as RoundProgress | null) ?? null;
    }
    if (data) {
      const { data: attempts, error: attemptsError } = await supabase
        .from("attempt_logs")
        .select("segment_index, is_correct, created_at, id")
        .eq("session_id", data.id)
        .eq("is_practice_valid", true)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false });
      if (attemptsError) {
        console.error("[session/resume] attempts query error:", attemptsError);
      } else {
        const seen = new Map<number, boolean>();
        for (const a of attempts ?? []) {
          if (!seen.has(a.segment_index)) seen.set(a.segment_index, a.is_correct);
        }
        latestDictationResults = [...seen.entries()]
          .sort((x, y) => x[0] - y[0])
          .map(([segmentIndex, isCorrect]) => ({ segmentIndex, isCorrect }));
      }
    }

    // Listening for the video's CURRENT revision (the null-transcript row when
    // there is no ready revision). Another revision's checkpoint is never
    // offered here — hasHistory only says that one exists.
    const currentTranscriptId = (currentTranscript.data as { id: string } | null)?.id ?? null;
    let listeningQuery = supabase
      .from("listening_progress")
      .select("coverage_ratio, listened_through, last_position_sec")
      .eq("user_id", user.id)
      .eq("youtube_video_id", videoId);
    listeningQuery = currentTranscriptId
      ? listeningQuery.eq("transcript_id", currentTranscriptId)
      : listeningQuery.is("transcript_id", null).is("superseded_at", null);
    const { data: listeningRow, error: listeningError } = await listeningQuery.maybeSingle();
    if (listeningError || membership.error || currentTranscript.error || historyCount.error) {
      console.error("[session/resume] listening/mode query error:", listeningError ?? membership.error ?? currentTranscript.error ?? historyCount.error);
    }
    const lr = listeningRow as { coverage_ratio: number | string; listened_through: boolean; last_position_sec: number | string } | null;
    const lastMode = typeof membership.data === "string" ? membership.data : null;

    const response: ResumeSessionResponse = {
      lastMode: lastMode === "dictation" || lastMode === "listening" || lastMode === "shadowing" ? lastMode : null,
      listening: {
        transcriptId: currentTranscriptId,
        coverageRatio: lr && currentTranscriptId ? Number(lr.coverage_ratio) : null,
        listenedThrough: lr?.listened_through ?? false,
        lastPositionSec: lr ? Number(lr.last_position_sec) : null,
        hasHistory: (historyCount.count ?? 0) > 0,
      },
      session: data
        ? {
            sessionId: data.id,
            currentSegmentIndex: data.current_segment_index ?? 0,
            videoCurrentTimeSec: Number(data.video_current_time ?? 0),
            accuracy: Number(data.accuracy ?? 0),
            totalAttempts: data.total_attempts ?? 0,
            updatedAt: data.updated_at,
            status: data.status as "active" | "completed" | "abandoned",
            // Phase 0 — the revision this session is pinned to. Every reader
            // (GET /api/transcript, useDictationSession) must fetch exactly
            // this revision when it's non-null, never "whatever is current".
            transcriptId: data.transcript_id ?? null,
            roundNumber: data.round_number ?? undefined,
            provenance: data.provenance ?? undefined,
            requiredSentenceCount: data.required_sentence_count ?? null,
            latestDictationResults,
            newerActiveRound,
            progress,
          }
        : null,
    };

    return NextResponse.json(response);
  } catch (err) {
    console.error("[session/resume] unexpected error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
