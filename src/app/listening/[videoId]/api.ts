import type { TranscriptResponse, TranslateTranscriptResponse } from "@/lib/types";

export async function fetchTranscript(videoId: string): Promise<TranscriptResponse> {
  const res = await fetch(`/api/transcript/${videoId}?lang=en`);
  if (!res.ok) throw new Error("Failed to fetch transcript");
  return res.json();
}

export async function triggerTranscriptGeneration(
  videoId: string
): Promise<{ transcriptId?: string; status: string; error?: string }> {
  const res = await fetch("/api/transcript/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videoId }),
  });
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
