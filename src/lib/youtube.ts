const OEMBED_TIMEOUT_MS = 3_000;

interface OEmbedResponse {
  title?: string;
}

/**
 * Video title via YouTube's oEmbed endpoint (no API key required). Never
 * throws — a null result just means the title couldn't be resolved right
 * now, and callers should fall back to showing the video ID.
 */
export async function fetchYouTubeVideoTitle(videoId: string): Promise<string | null> {
  try {
    const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(
      `https://www.youtube.com/watch?v=${videoId}`
    )}&format=json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(OEMBED_TIMEOUT_MS) });
    if (!res.ok) return null;

    const data = (await res.json()) as OEmbedResponse;
    return data.title?.trim() || null;
  } catch (err) {
    console.warn("[youtube] oEmbed title lookup failed:", err instanceof Error ? err.message : err);
    return null;
  }
}
