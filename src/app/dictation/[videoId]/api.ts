import type {
  CheckAnswerResponse,
  MatchMode,
  ResumeSessionResponse,
  TranscriptResponse,
  TranslateTranscriptResponse,
  VocabHighlightsResponse,
} from "@/lib/types";
import type { ManualSegmentInput } from "@/lib/utils/segment";

export async function fetchTranscript(videoId: string): Promise<TranscriptResponse> {
  const res = await fetch(`/api/transcript/${videoId}?lang=en`);
  if (!res.ok) throw new Error("Failed to fetch transcript");
  return res.json();
}

/**
 * Response fields present on a non-2xx (or "processing"/cooldown) result
 * from /api/transcript/generate — additive to the plain success shape, so
 * older callers that only read transcriptId/status still work unchanged.
 * See src/lib/youtubeCaptions/errors.ts for the TranscriptFetchErrorCode
 * union `code` is drawn from (plus "GENERATION_IN_PROGRESS"/"FETCH_COOLDOWN",
 * which aren't per-provider errors but reuse the same field).
 */
export interface GenerateTranscriptResult {
  transcriptId?: string;
  status: string;
  error?: string;
  code?: string;
  retryAfterMs?: number;
  retryAt?: string;
  previousErrorCode?: string;
}

async function postGenerate(body: Record<string, unknown>): Promise<GenerateTranscriptResult> {
  const res = await fetch("/api/transcript/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data: GenerateTranscriptResult = await res.json();
  // A contended lock (202) or an active cooldown (503, but with a
  // still-preserved ready transcript) are expected, non-exceptional
  // outcomes — callers branch on `status`/`code`, not a thrown error, for
  // the polling/backoff logic in useDictationSession.ts to work with.
  if (!res.ok && data.code !== "GENERATION_IN_PROGRESS" && data.code !== "FETCH_COOLDOWN") {
    throw Object.assign(new Error(data.error ?? "Failed to generate transcript"), { code: data.code, retryAfterMs: data.retryAfterMs });
  }
  return data;
}

/** Wipes the cached transcript/segments and re-derives them from YouTube's captions. */
export async function regenerateTranscript(videoId: string): Promise<GenerateTranscriptResult> {
  return postGenerate({ videoId, force: true });
}

/** Saves caller-supplied segments (manual paste, .srt/.vtt upload) as the video's transcript. */
export async function saveManualTranscript(
  videoId: string,
  segments: ManualSegmentInput[],
  importSource: "manual" | "srt" | "vtt" = "manual"
): Promise<GenerateTranscriptResult> {
  return postGenerate({ videoId, segments, force: true, importSource });
}

/** Quietly checks/kicks off generation without forcing a re-fetch of an
 *  already-ready transcript — used by the background auto-generate effect
 *  in useDictationSession.ts (as opposed to the user-triggered "regenerate"
 *  above, which always forces a fresh fetch and resets session state). */
export async function requestTranscriptGeneration(videoId: string): Promise<GenerateTranscriptResult> {
  return postGenerate({ videoId });
}

export async function checkAnswerApi(
  segmentIndex: number,
  userText: string,
  expectedText: string,
  matchMode: MatchMode,
  sessionId?: string
): Promise<CheckAnswerResponse> {
  const res = await fetch("/api/dictation/check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ segmentIndex, userText, expectedText, matchMode, sessionId }),
  });
  if (!res.ok) throw new Error("Failed to check answer");
  return res.json();
}

export async function saveProgress(
  videoId: string,
  segmentIndex: number,
  videoCurrentTimeSec: number,
  accuracy: number,
  totalAttempts: number,
  sessionId?: string,
  transcriptId?: string,
  status: "active" | "completed" | "abandoned" = "active"
): Promise<{ sessionId: string }> {
  const res = await fetch("/api/session/save-progress", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId,
      youtubeVideoId: videoId,
      transcriptId,
      currentSegmentIndex: segmentIndex,
      videoCurrentTimeSec,
      accuracy,
      totalAttempts,
      status,
    }),
  });
  if (!res.ok) throw new Error("Failed to save progress");
  return res.json();
}

export async function fetchResumeSession(videoId: string): Promise<ResumeSessionResponse> {
  const res = await fetch(`/api/session/resume?videoId=${encodeURIComponent(videoId)}`);
  if (!res.ok) throw new Error("Failed to fetch resume session");
  return res.json();
}

export async function fetchTranslation(
  videoId: string,
  transcriptId: string,
  language = "vi",
  force = false
): Promise<TranslateTranscriptResponse> {
  const res = await fetch("/api/transcript/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videoId, transcriptId, language, force }),
  });
  if (!res.ok) throw new Error("Failed to fetch translation");
  return res.json();
}

export async function fetchVocabHighlights(
  videoId: string,
  transcriptId: string,
  learningLevel?: string,
  force = false
): Promise<VocabHighlightsResponse> {
  const res = await fetch("/api/transcript/vocab-highlights", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videoId, transcriptId, learningLevel, force }),
  });
  if (!res.ok) throw new Error("Failed to fetch vocab highlights");
  return res.json();
}

export async function restartSession(videoId: string, sessionId?: string): Promise<void> {
  const res = await fetch("/api/session/restart", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videoId, sessionId }),
  });
  if (!res.ok) throw new Error("Failed to restart session");
}
