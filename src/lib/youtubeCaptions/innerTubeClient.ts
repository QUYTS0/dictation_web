// =====================================================
// Shared raw InnerTube primitives: video-ID validation, the unauthenticated
// InnerTube player request (spoofing the Android client, exactly as before),
// caption-track extraction, and timed-text fetching with abort/timeout.
//
// This is the one place that talks to YouTube's unofficial InnerTube
// endpoint. Both innerTubeProvider.ts (English) and
// youtubeTranslatedCaptions.ts (Vietnamese tlang translation) call these
// primitives instead of each keeping their own copy — their higher-level
// orchestration and response contracts stay separate (see item 1's
// carve-out: don't force a shared contract where the two paths genuinely
// differ).
//
// Request destinations are fixed constants below — a videoId is
// interpolated into a JSON POST body (never into a URL), and every fetch
// target is always www.youtube.com. Nothing here ever fetches a
// client-supplied URL.
// =====================================================

import type { CaptionTrackMeta } from "./types";
import { PROVIDER_FETCH_TIMEOUT_MS } from "./config";

const INNERTUBE_PLAYER_URL = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";
const ANDROID_CLIENT_VERSION = "20.10.38";
const ANDROID_USER_AGENT = `com.google.android.youtube/${ANDROID_CLIENT_VERSION} (Linux; U; Android 14)`;

/** Standard 11-character YouTube video ID shape — letters, digits, `-`, `_`. */
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export function isValidYoutubeVideoId(videoId: string): boolean {
  return VIDEO_ID_RE.test(videoId);
}

async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export interface FetchCaptionTracksResult {
  tracks: CaptionTrackMeta[] | null;
  /** Safe (non-content) diagnostic metadata for structured logging. */
  diagnostics: { httpStatus: number; playabilityStatus?: string; trackCount: number };
}

/**
 * Lists caption tracks for `videoId` via YouTube's InnerTube player endpoint,
 * spoofing the Android client (no cookies, no API key, no login). Returns
 * `tracks: null` on any network/parse failure or when the video genuinely
 * has none — callers distinguish those cases via `diagnostics`/thrown
 * errors as appropriate for their own error taxonomy.
 */
export async function fetchCaptionTracks(
  videoId: string,
  opts: { timeoutMs?: number } = {}
): Promise<FetchCaptionTracksResult> {
  if (!isValidYoutubeVideoId(videoId)) {
    return { tracks: null, diagnostics: { httpStatus: 0, trackCount: 0 } };
  }

  const res = await fetchWithTimeout(
    INNERTUBE_PLAYER_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": ANDROID_USER_AGENT },
      body: JSON.stringify({
        context: { client: { clientName: "ANDROID", clientVersion: ANDROID_CLIENT_VERSION } },
        videoId,
      }),
    },
    opts.timeoutMs ?? PROVIDER_FETCH_TIMEOUT_MS
  );

  if (!res.ok) {
    return { tracks: null, diagnostics: { httpStatus: res.status, trackCount: 0 } };
  }

  const json = await res.json().catch(() => null);
  const playabilityStatus: string | undefined = json?.playabilityStatus?.status;
  const tracks = json?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  const validTracks: CaptionTrackMeta[] | null =
    Array.isArray(tracks) && tracks.length > 0
      ? tracks.map((t: Record<string, unknown>) => ({
          baseUrl: String(t.baseUrl ?? ""),
          languageCode: String(t.languageCode ?? ""),
          kind: typeof t.kind === "string" ? t.kind : undefined,
          vssId: typeof t.vssId === "string" ? t.vssId : undefined,
          name: typeof t.name === "object" && t.name !== null ? String((t.name as { simpleText?: string }).simpleText ?? "") : undefined,
          isTranslatable: typeof t.isTranslatable === "boolean" ? t.isTranslatable : undefined,
        }))
      : null;

  return {
    tracks: validTracks,
    diagnostics: { httpStatus: res.status, playabilityStatus, trackCount: validTracks?.length ?? 0 },
  };
}

export interface FetchTimedTextResult {
  httpStatus: number;
  contentType: string | null;
  text: string;
}

/**
 * Fetches a caption track's `baseUrl` (optionally with query params already
 * appended by the caller, e.g. `&tlang=vi`). `baseUrl` always originates
 * from a track returned by fetchCaptionTracks above (i.e. from YouTube
 * itself), never from arbitrary client input.
 */
export async function fetchTimedText(
  url: string,
  opts: { timeoutMs?: number; acceptLanguage?: string } = {}
): Promise<FetchTimedTextResult> {
  const res = await fetchWithTimeout(
    url,
    {
      headers: {
        "User-Agent": ANDROID_USER_AGENT,
        ...(opts.acceptLanguage ? { "Accept-Language": opts.acceptLanguage } : {}),
      },
    },
    opts.timeoutMs ?? PROVIDER_FETCH_TIMEOUT_MS
  );
  const text = await res.text().catch(() => "");
  return { httpStatus: res.status, contentType: res.headers.get("content-type"), text };
}
