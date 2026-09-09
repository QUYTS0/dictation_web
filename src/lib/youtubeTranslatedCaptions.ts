import type { CueItem } from "@/lib/utils/segment";
import { fetchCaptionTracks, fetchTimedText } from "@/lib/youtubeCaptions/innerTubeClient";
import { parseTimedTextRaw } from "@/lib/youtubeCaptions/parseTimedText";

/**
 * Fetches captions for `videoId` machine-translated into `targetLang` by
 * YouTube's own server-side translation — the same "tlang" mechanism behind
 * YouTube's auto-translate caption menu. No third-party translation call is
 * involved. Works off whatever caption track the video actually has (manual
 * or auto-generated), so it covers far more videos than requiring an exact
 * `targetLang` track to already exist. Returns null if the video has no
 * captions, already has a track in `targetLang`, or the request fails.
 *
 * Shares its InnerTube request/track-extraction/timed-text-fetch primitives
 * with the English provider (see src/lib/youtubeCaptions/innerTubeClient.ts)
 * but keeps its own track-preference logic and CueItem[] output shape —
 * this path's job is picking a *source* track to translate from (any
 * language will do; tlang can translate from any of them), which is a
 * genuinely different concern from the English path's "must be English".
 */
export async function fetchYoutubeTranslatedCaptions(
  videoId: string,
  targetLang: string
): Promise<CueItem[] | null> {
  const { tracks } = await fetchCaptionTracks(videoId).catch(() => ({ tracks: null }));
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
    const result = await fetchTimedText(translatedUrl);
    if (result.httpStatus < 200 || result.httpStatus >= 300) return null;
    xml = result.text;
  } catch {
    return null;
  }

  const cues = parseTimedTextRaw(xml);
  return cues.length > 0 ? cues : null;
}
