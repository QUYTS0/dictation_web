// =====================================================
// YouTube URL parsing & validation utilities
// =====================================================

/**
 * Extracts the 11-character YouTube video ID from common URL formats:
 * - https://www.youtube.com/watch?v=XXXXXXXXXXX
 * - https://youtu.be/XXXXXXXXXXX
 * - https://www.youtube.com/embed/XXXXXXXXXXX
 * - https://www.youtube.com/shorts/XXXXXXXXXXX
 *
 * Returns null if the URL is not a valid YouTube video URL.
 */
export function extractYouTubeVideoId(url: string): string | null {
  if (!url || typeof url !== "string") return null;

  const trimmed = url.trim();

  // youtube.com/watch?v=ID or with extra params
  const watchMatch = trimmed.match(
    /(?:youtube\.com\/watch\?(?:[^&]+&)*v=)([A-Za-z0-9_-]{11})/
  );
  if (watchMatch) return watchMatch[1];

  // youtu.be/ID
  const shortMatch = trimmed.match(/(?:youtu\.be\/)([A-Za-z0-9_-]{11})/);
  if (shortMatch) return shortMatch[1];

  // youtube.com/embed/ID
  const embedMatch = trimmed.match(
    /(?:youtube\.com\/embed\/)([A-Za-z0-9_-]{11})/
  );
  if (embedMatch) return embedMatch[1];

  // youtube.com/shorts/ID
  const shortsMatch = trimmed.match(
    /(?:youtube\.com\/shorts\/)([A-Za-z0-9_-]{11})/
  );
  if (shortsMatch) return shortsMatch[1];

  // Bare 11-char video ID
  if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) return trimmed;

  return null;
}

/**
 * Returns true if the given string is a valid YouTube URL (or bare video ID).
 */
export function isValidYouTubeUrl(url: string): boolean {
  return extractYouTubeVideoId(url) !== null;
}
