const OPENVERSE_TIMEOUT_MS = 3_000;

export interface WordImage {
  url: string;
  thumbnailUrl: string;
  attribution: string;
  sourceUrl: string;
  license: string;
}

interface OpenverseResult {
  title?: string;
  creator?: string;
  url?: string;
  thumbnail?: string;
  foreign_landing_url?: string;
  license?: string;
}

interface OpenverseResponse {
  results?: OpenverseResult[];
}

/**
 * A free, no-API-key illustrative photo for a single word, via Openverse
 * (aggregates CC-licensed images from Flickr, Wikimedia, etc.). Never
 * throws — a null result just means no good image match, which is common
 * for abstract words. Only meaningful for single words, never phrases.
 */
export async function lookupWordImage(word: string): Promise<WordImage | null> {
  const trimmed = word.trim();
  if (!trimmed) return null;

  try {
    const res = await fetch(
      `https://api.openverse.org/v1/images/?q=${encodeURIComponent(trimmed)}&page_size=1&mature=false`,
      { signal: AbortSignal.timeout(OPENVERSE_TIMEOUT_MS) }
    );
    if (!res.ok) return null;

    const data = (await res.json()) as OpenverseResponse;
    const result = data.results?.[0];
    if (!result?.url || !result.foreign_landing_url) return null;

    const title = result.title || trimmed;
    const creator = result.creator || "unknown";
    const license = (result.license || "unknown").toUpperCase();

    return {
      url: result.url,
      thumbnailUrl: result.thumbnail || result.url,
      attribution: `"${title}" by ${creator}, licensed under CC ${license}`,
      sourceUrl: result.foreign_landing_url,
      license,
    };
  } catch (err) {
    console.warn("[image] Openverse lookup failed:", err instanceof Error ? err.message : err);
    return null;
  }
}
