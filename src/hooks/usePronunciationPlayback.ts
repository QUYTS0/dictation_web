"use client";

import { useEffect, useRef, useState } from "react";
import type { VocabularyAudioSource, VocabularyPronounceErrorResponse, VocabularyPronounceResponse } from "@/lib/types";

export type PronunciationStatus = "idle" | "loading" | "ready" | "playing" | "error";

const ERROR_MESSAGES: Record<string, string> = {
  TTS_NOT_CONFIGURED: "Pronunciation isn't available right now.",
  TTS_RATE_LIMITED: "Too many requests — try again in a moment.",
  TTS_QUOTA_EXCEEDED: "Pronunciation is temporarily unavailable.",
  TTS_UPSTREAM_ERROR: "Couldn't generate pronunciation. Try again.",
  TTS_STORAGE_ERROR: "Couldn't save pronunciation. Try again.",
  NOT_FOUND: "Couldn't play pronunciation.",
};
const DEFAULT_ERROR_MESSAGE = "Couldn't play pronunciation.";

// Cross-instance playback exclusivity. Every pronunciation button on the
// page — different vocabulary cards, or a card vs. the detail dialog —
// mounts its own instance of this hook with its own <audio> element; without
// coordination, playing card B while card A is mid-playback would leave both
// audible at once. This module-level slot is plain, unshared browser-tab
// state (not application data — nothing here is persisted or synced), so a
// bare module variable is enough: whichever instance starts playback next
// calls the previous claimant's stop function first.
let currentStop: (() => void) | null = null;
function claimPlaybackSlot(stop: () => void) {
  if (currentStop && currentStop !== stop) currentStop();
  currentStop = stop;
}
function releasePlaybackSlot(stop: () => void) {
  if (currentStop === stop) currentStop = null;
}

/**
 * Headless play/resolve state machine backing every pronunciation button in
 * the app (VocabularyDetailDialog and the Vocabulary Bank page) — kept as a
 * hook rather than a shared visual component since the two surfaces use
 * unrelated styling systems (the dictation route's CSS-variable theme vs.
 * the Vocabulary Bank page's Tailwind slate palette).
 *
 * Every saved item is a candidate for pronunciation now, word or phrase:
 * `knownAudioUrl` (item.audio_url) covers the dictionary-audio case and
 * plays instantly with no network call; everything else resolves through
 * POST /api/vocabulary/pronounce on first tap (see that route for the
 * dictionary → cached-Azure-asset → shared-cache → synthesize decision
 * chain). A resolved URL is cached in this hook's own state, so only the
 * first tap per *pronunciation identity* (see `term`/`canonicalForm` below)
 * ever hits the network.
 *
 * `term`/`canonicalForm` are never sent to the server — resolving what to
 * speak always happens server-side, from the owned row, never from client
 * input. They exist purely as a change-detection key: a saved item can be
 * edited without its `itemId` changing (the dialog stays open on the same
 * item), and any resolved/known audio for the OLD text must never keep
 * playing — or be a tap away from playing — under the NEW heading. When
 * either changes, all in-flight/resolved state for the old identity is
 * discarded and playback resets to idle, re-seeded from the fresh
 * `knownAudioUrl`.
 *
 * Does NOT auto-play after a successful resolve — an awaited fetch breaks
 * the synchronous user-gesture chain iOS Safari requires for reliable
 * playback, so the hook instead flips to "ready" and waits for the next
 * (fresh-gesture) tap to actually call play().
 */
export function usePronunciationPlayback({
  itemId,
  knownAudioUrl,
  term,
  canonicalForm,
  active = true,
  onResolved,
}: {
  itemId: string;
  knownAudioUrl: string | null;
  term: string;
  canonicalForm?: string | null;
  /** Set false to pause and reset to idle immediately — e.g. a dialog
   *  starting its close animation. */
  active?: boolean;
  onResolved?: (source: VocabularyAudioSource) => void;
}) {
  const [status, setStatus] = useState<PronunciationStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // True only while the button is stuck on a broken KNOWN dictionary URL —
  // gates the explicit, bounded "Use generated pronunciation" recovery
  // action (see handlePlaybackError below). Never set for a broken
  // server-resolved (cached/synthesized) URL, which instead self-heals via
  // failedOnceRef without any user-visible recovery control.
  const [canRecoverWithGenerated, setCanRecoverWithGenerated] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const knownAudioUrlRef = useRef(knownAudioUrl);
  const resolvedUrlRef = useRef<string | null>(knownAudioUrl);
  // Whether resolvedUrlRef currently holds the raw, never-fetched dictionary
  // URL (true) vs. something resolved through the pronounce route (false).
  const resolvedIsKnownRef = useRef(true);
  // The last server-resolved URL that failed exactly once — a second
  // failure on the SAME url clears resolvedUrlRef so the next tap
  // re-resolves from the server instead of retrying forever.
  const failedOnceRef = useRef<string | null>(null);
  // Bumped whenever the pronunciation identity changes; resolveAndFetch
  // captures it at call time and discards its own response if it no longer
  // matches by the time the network round trip completes.
  const generationRef = useRef(0);

  // Lazy, once-per-mount stable closure (same pattern as this codebase's
  // other lazy-ref-init audio components) — stored in a ref so its identity
  // never changes across renders, which the module-level playback-slot
  // coordinator above relies on for correct claim/release comparisons.
  const stopSelfRef = useRef<(() => void) | null>(null);
  if (!stopSelfRef.current) {
    stopSelfRef.current = () => {
      audioRef.current?.pause();
      setStatus("idle");
    };
  }
  const stopSelf = stopSelfRef.current;
  const stopAndReleaseSlot = () => {
    stopSelf();
    releasePlaybackSlot(stopSelf);
  };

  const identityKey = `${itemId}::${canonicalForm ?? ""}::${term}`;

  useEffect(() => {
    return () => {
      stopAndReleaseSlot();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resets playback state whenever the pronunciation-relevant identity
  // changes — including a same-item-id edit, which is a normal case (the
  // dialog/card stays mounted; only the term/canonicalForm props change).
  // Also runs once on mount, which is a harmless no-op re-seed.
  useEffect(() => {
    generationRef.current += 1;
    stopAndReleaseSlot();
    knownAudioUrlRef.current = knownAudioUrl;
    resolvedUrlRef.current = knownAudioUrl;
    resolvedIsKnownRef.current = true;
    failedOnceRef.current = null;
    setStatus("idle");
    setErrorMessage(null);
    setCanRecoverWithGenerated(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identityKey]);

  useEffect(() => {
    if (active) return;
    stopAndReleaseSlot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const handlePlaybackError = (url: string) => {
    releasePlaybackSlot(stopSelf);
    setErrorMessage(DEFAULT_ERROR_MESSAGE);
    setStatus("error");

    if (resolvedIsKnownRef.current && url === knownAudioUrlRef.current) {
      // Bounded recovery for unusable dictionary audio: never auto-trigger
      // synthesis (a single playback failure isn't evidence the text is
      // wrong — could be a dead 404 or a transient network blip) — surface
      // an explicit, opt-in action instead.
      setCanRecoverWithGenerated(true);
      return;
    }
    if (!resolvedIsKnownRef.current) {
      // Retry-same-source-first already gives this URL one more chance
      // (see toggle()); only clear it once THAT retry also fails, so a
      // genuinely broken cache entry (e.g. a missing Storage object) can't
      // trap playback forever — the next tap re-resolves from the server.
      if (failedOnceRef.current === url) {
        resolvedUrlRef.current = null;
        failedOnceRef.current = null;
      } else {
        failedOnceRef.current = url;
      }
    }
  };

  const playUrl = (url: string) => {
    let audio = audioRef.current;
    if (!audio) {
      audio = new Audio(url);
      audio.addEventListener("ended", () => {
        setStatus("idle");
        releasePlaybackSlot(stopSelf);
      });
      audio.addEventListener("error", () => handlePlaybackError(url));
      audioRef.current = audio;
    } else if (audio.src !== url) {
      audio.src = url;
    }
    claimPlaybackSlot(stopSelf);
    setStatus("loading");
    audio
      .play()
      .then(() => setStatus("playing"))
      .catch(() => handlePlaybackError(url));
  };

  const resolveAndFetch = async (options: { preferGenerated?: boolean } = {}) => {
    const myGeneration = generationRef.current;
    setStatus("loading");
    setErrorMessage(null);
    try {
      const res = await fetch("/api/vocabulary/pronounce", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId, ...(options.preferGenerated ? { preferGenerated: true } : {}) }),
      });
      const data = (await res.json().catch(() => ({}))) as Partial<
        VocabularyPronounceResponse & VocabularyPronounceErrorResponse
      >;
      // The item's pronunciation identity changed (or this instance
      // unmounted) while the request was in flight — the response no
      // longer describes what's currently displayed, so it's discarded
      // rather than applied to whatever text is showing now.
      if (generationRef.current !== myGeneration) return;
      if (!res.ok || !data.audioUrl) {
        setErrorMessage((data.code && ERROR_MESSAGES[data.code]) || data.error || DEFAULT_ERROR_MESSAGE);
        setStatus("error");
        return;
      }
      resolvedUrlRef.current = data.audioUrl;
      resolvedIsKnownRef.current = false;
      failedOnceRef.current = null;
      if (data.source) onResolved?.(data.source);
      setStatus("ready");
    } catch {
      if (generationRef.current !== myGeneration) return;
      setErrorMessage(DEFAULT_ERROR_MESSAGE);
      setStatus("error");
    }
  };

  const toggle = () => {
    if (status === "playing") {
      stopAndReleaseSlot();
      return;
    }
    if (status === "loading") return;
    // Retry-same-source-first: a known URL (dictionary audio, or a
    // previously resolved Azure clip) is always retried before ever
    // spending a fresh synthesis call, including after a playback error.
    if (resolvedUrlRef.current) {
      playUrl(resolvedUrlRef.current);
      return;
    }
    void resolveAndFetch();
  };

  /** Explicit, user-initiated recovery from unusable dictionary audio —
   *  bypasses the dictionary shortcut for this one request so the server
   *  resolves (or synthesizes) an Azure alternative instead. Never called
   *  automatically. */
  const requestGeneratedAlternative = () => {
    if (status === "loading") return;
    resolvedUrlRef.current = null;
    resolvedIsKnownRef.current = false;
    setCanRecoverWithGenerated(false);
    void resolveAndFetch({ preferGenerated: true });
  };

  return { status, errorMessage, toggle, canRecoverWithGenerated, requestGeneratedAlternative };
}
