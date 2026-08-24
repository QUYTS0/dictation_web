import type {
  CheckAnswerResponse,
  MatchMode,
  ResumeSessionResponse,
  TranscriptResponse,
  TranslateTranscriptResponse,
  VocabHighlightsResponse,
} from "@/lib/types";

export async function fetchTranscript(videoId: string): Promise<TranscriptResponse> {
  const res = await fetch(`/api/transcript/${videoId}?lang=en`);
  if (!res.ok) throw new Error("Failed to fetch transcript");
  return res.json();
}

/** Wipes the cached transcript/segments and re-derives them from YouTube's captions. */
export async function regenerateTranscript(
  videoId: string
): Promise<{ transcriptId?: string; status: string; error?: string }> {
  const res = await fetch("/api/transcript/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videoId, force: true }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Failed to regenerate transcript");
  return data;
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
  language = "vi"
): Promise<TranslateTranscriptResponse> {
  const res = await fetch("/api/transcript/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videoId, transcriptId, language }),
  });
  if (!res.ok) throw new Error("Failed to fetch translation");
  return res.json();
}

export async function fetchVocabHighlights(
  videoId: string,
  transcriptId: string
): Promise<VocabHighlightsResponse> {
  const res = await fetch("/api/transcript/vocab-highlights", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videoId, transcriptId }),
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
