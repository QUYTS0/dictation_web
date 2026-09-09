// =====================================================
// Deterministic English caption-track selection.
//
// Fixes a real bug in the `youtube-transcript` package: it requires
// `track.languageCode === "en"` exactly, so a video whose only English track
// is "en-US"/"en-GB" (no bare "en") is reported as having no English
// captions at all. This picks the best available English track from
// whatever InnerTube actually returned, never a non-English track, and
// never based on a substring match against the track's display `name`
// (display names are unreliable/localized and can contain "English" while
// the track itself is not English, or vice versa).
// =====================================================

import type { CaptionTrackMeta, TrackSelectionResult } from "./types";

const REGIONAL_EN_RE = /^en-[A-Za-z]{2}$/i;
/** InnerTube's `vssId` sometimes carries language info more reliably than
 *  `languageCode` for oddly-shaped tracks (e.g. ".en", "a.en", ".en-US").
 *  Used only as a narrow fallback signal — never a substring/name match. */
const VSS_ID_EN_RE = /^a?\.en(-[A-Za-z]{2})?$/i;

type Tier = 4 | 3 | 2;

function isAsr(track: CaptionTrackMeta): boolean {
  return track.kind === "asr";
}

function classify(track: CaptionTrackMeta): Tier | null {
  const lang = track.languageCode ?? "";
  if (lang.toLowerCase() === "en") return 4;
  if (REGIONAL_EN_RE.test(lang)) return 3;
  if (!lang && track.vssId && VSS_ID_EN_RE.test(track.vssId)) return 2;
  return null;
}

/**
 * Selects the best English track, or null if none of the tracks are
 * (reliably) English. Deterministic: given the same input array, always
 * returns the same result.
 *
 * Ranking: tracks lacking a fetchable `baseUrl` are excluded outright, then
 * language-match specificity decides (exact "en" > regional "en-XX" > other
 * reliably-English-by-vssId), then manually-authored beats ASR as a
 * same-tier tie-break, then original array order as the final deterministic
 * tie-breaker. English ASR is still accepted — just only when no manually
 * authored track exists in the same or a better tier.
 */
export function selectEnglishTrack(tracks: CaptionTrackMeta[]): TrackSelectionResult | null {
  let best: { track: CaptionTrackMeta; tier: Tier; manual: boolean } | null = null;

  tracks.forEach((track) => {
    // A track with no fetchable URL is not a usable candidate at all —
    // filtered out before ranking rather than merely deprioritized, so it's
    // never selected just because nothing else happens to be available.
    if (!track.baseUrl) return;
    const tier = classify(track);
    if (tier === null) return;
    const manual = !isAsr(track);

    if (!best) {
      best = { track, tier, manual };
      return;
    }
    if (tier > best.tier) {
      best = { track, tier, manual };
      return;
    }
    if (tier < best.tier) return;
    // Same tier — manual beats ASR; otherwise keep the earlier (first-seen)
    // track as the deterministic tie-break.
    if (manual && !best.manual) {
      best = { track, tier, manual };
    }
  });

  if (!best) return null;
  const { track, tier, manual } = best as { track: CaptionTrackMeta; tier: Tier; manual: boolean };

  const reasonParts = [
    tier === 4 ? "exact-en" : tier === 3 ? "regional-en" : "vssid-en",
    manual ? "manual" : "asr",
  ];
  return { track, reason: reasonParts.join("+") };
}
