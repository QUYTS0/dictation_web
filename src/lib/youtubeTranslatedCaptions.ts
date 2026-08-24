import type { CueItem } from "@/lib/utils/segment";

const INNERTUBE_PLAYER_URL = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";
const ANDROID_CLIENT_VERSION = "20.10.38";
const ANDROID_USER_AGENT = `com.google.android.youtube/${ANDROID_CLIENT_VERSION} (Linux; U; Android 14)`;

interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  kind?: string;
}

/**
 * Fetches captions for `videoId` machine-translated into `targetLang` by
 * YouTube's own server-side translation — the same "tlang" mechanism behind
 * YouTube's auto-translate caption menu. No third-party translation call is
 * involved. Works off whatever caption track the video actually has (manual
 * or auto-generated), so it covers far more videos than requiring an exact
 * `targetLang` track to already exist. Returns null if the video has no
 * captions, already has a track in `targetLang`, or the request fails.
 */
export async function fetchYoutubeTranslatedCaptions(
  videoId: string,
  targetLang: string
): Promise<CueItem[] | null> {
  const tracks = await fetchCaptionTracks(videoId);
  if (!tracks || tracks.length === 0) return null;

  // This app always generates original transcripts in English, so prefer an
  // English source track (manual over auto-generated); fall back to whatever
  // the video has — tlang can translate from any source language.
  const track =
    tracks.find((t) => t.languageCode === "en" && t.kind !== "asr") ??
    tracks.find((t) => t.languageCode?.startsWith("en")) ??
    tracks[0];

  if (!track?.baseUrl || track.languageCode === targetLang) return null;

  const translatedUrl = `${track.baseUrl}&tlang=${encodeURIComponent(targetLang)}`;

  let xml: string;
  try {
    const res = await fetch(translatedUrl, { headers: { "User-Agent": ANDROID_USER_AGENT } });
    if (!res.ok) return null;
    xml = await res.text();
  } catch {
    return null;
  }

  const cues = parseTranscriptXml(xml);
  return cues.length > 0 ? cues : null;
}

async function fetchCaptionTracks(videoId: string): Promise<CaptionTrack[] | null> {
  try {
    const res = await fetch(INNERTUBE_PLAYER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": ANDROID_USER_AGENT },
      body: JSON.stringify({
        context: { client: { clientName: "ANDROID", clientVersion: ANDROID_CLIENT_VERSION } },
        videoId,
      }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const tracks = json?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    return Array.isArray(tracks) && tracks.length > 0 ? tracks : null;
  } catch {
    return null;
  }
}

// Mirrors the `youtube-transcript` package's XML parsing (srv3 `<p t d>` and
// classic `<text start dur>` formats) since that package doesn't expose it
// for a custom (tlang-appended) URL.
function parseTranscriptXml(xml: string): CueItem[] {
  const result: CueItem[] = [];
  const srv3Re = /<p\s+t="(\d+)"\s+d="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;
  let match: RegExpExecArray | null;
  while ((match = srv3Re.exec(xml)) !== null) {
    const offset = parseInt(match[1], 10);
    const duration = parseInt(match[2], 10);
    const inner = match[3];
    let text = "";
    const sRe = /<s[^>]*>([^<]*)<\/s>/g;
    let sMatch: RegExpExecArray | null;
    while ((sMatch = sRe.exec(inner)) !== null) text += sMatch[1];
    if (!text) text = inner.replace(/<[^>]+>/g, "");
    text = decodeEntities(text).trim();
    if (text) result.push({ text, duration, offset });
  }
  if (result.length > 0) return result;

  const classicRe = /<text start="([^"]*)" dur="([^"]*)">([^<]*)<\/text>/g;
  let classicMatch: RegExpExecArray | null;
  while ((classicMatch = classicRe.exec(xml)) !== null) {
    const offset = parseFloat(classicMatch[1]);
    const duration = parseFloat(classicMatch[2]);
    const text = decodeEntities(classicMatch[3]).trim();
    if (text) result.push({ text, duration, offset });
  }
  return result;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)));
}
