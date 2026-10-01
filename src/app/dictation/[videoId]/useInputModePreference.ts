"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { InputMode } from "./types";

function storageKey(videoId: string): string {
  return `dictation.input-mode.${videoId}`;
}

// Modes other than the default ("dictation") carry an explicit `?mode=`
// value; dictation stays paramless as before so existing links are unaffected.
const NON_DEFAULT_MODES: ReadonlyArray<InputMode> = ["listening", "shadowing"];

// Pronunciation Practice existed as its own mode before it was merged into
// Shadowing (see "Shadowing and Pronunciation Practice Plan.md" §2/§3.3) —
// any link or stored value from before that merge may still say
// "pronunciation". Treat it as "shadowing" rather than silently falling back
// to "dictation" (today's behavior for any other unrecognized value).
const LEGACY_MODE_ALIASES: Record<string, InputMode> = { pronunciation: "shadowing" };

function parseInputMode(value: string | null): InputMode {
  if (!value) return "dictation";
  if (value in LEGACY_MODE_ALIASES) return LEGACY_MODE_ALIASES[value];
  return (NON_DEFAULT_MODES as readonly string[]).includes(value) ? (value as InputMode) : "dictation";
}

/**
 * Which central-input-area component the practice page shows: the dictation
 * typing box, the read-only Listening Mode transcript, or the Shadowing
 * recorder UI.
 *
 * Precedence (Phase 6), highest first:
 *   1. an explicit `?mode=` in the URL (a link or navigation that asks for a
 *      mode) — always wins for that load;
 *   2. the server's saved last mode for this video (the last EXPLICIT mode
 *      switch on any device) — applied via applyServerMode when the resume
 *      check answers, unless the user already switched on this page;
 *   3. this browser's per-video localStorage fallback (applied at once, so
 *      the page doesn't wait for the server; replaced by 2 when it arrives);
 *   4. Dictation.
 */
export function useInputModePreference(videoId: string) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const modeParam = searchParams.get("mode");

  const [inputMode, setInputModeState] = useState<InputMode>(parseInputMode(modeParam));
  // Set once the user switches modes on this page — a later server answer
  // must not override their own choice.
  const switchedThisVisitRef = useRef(false);
  const modeParamRef = useRef(modeParam);
  useEffect(() => {
    modeParamRef.current = modeParam;
  }, [modeParam]);

  useEffect(() => {
    if (modeParam) {
      setInputModeState(parseInputMode(modeParam));
      // A legacy `?mode=pronunciation` link resolves correctly above, but
      // leaves the stale value sitting in the address bar/history — clean it
      // up immediately rather than waiting for the next manual mode switch.
      // This only touches the URL; it never resets currentSegIdx, uxState,
      // or the sessionStorage session snapshot, all owned elsewhere.
      if (modeParam in LEGACY_MODE_ALIASES) {
        const params = new URLSearchParams(window.location.search);
        params.set("mode", LEGACY_MODE_ALIASES[modeParam]);
        router.replace(`/dictation/${videoId}?${params.toString()}`, { scroll: false });
      }
      return;
    }
    switchedThisVisitRef.current = false;
    setInputModeState("dictation");
    if (typeof window === "undefined") return;
    try {
      const saved = window.localStorage.getItem(storageKey(videoId));
      if (saved) setInputModeState(parseInputMode(saved));
    } catch {
      // localStorage can throw (private browsing, quota) — not worth failing over
    }
    // Deliberately excludes modeParam: this only needs to re-derive the mode
    // when navigating to a different video, not when setInputMode below
    // updates the URL itself (that already updates state directly).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId]);

  const setInputMode = useCallback(
    (mode: InputMode) => {
      switchedThisVisitRef.current = true;
      setInputModeState(mode);
      try {
        window.localStorage.setItem(storageKey(videoId), mode);
      } catch {
        // ignore
      }
      const params = new URLSearchParams(window.location.search);
      if (mode === "dictation") params.delete("mode");
      else params.set("mode", mode);
      const qs = params.toString();
      router.replace(`/dictation/${videoId}${qs ? `?${qs}` : ""}`, { scroll: false });
    },
    [router, videoId]
  );

  /** Precedence step 2 (see above): the server's saved last mode. */
  const applyServerMode = useCallback(
    (mode: InputMode) => {
      if (modeParamRef.current || switchedThisVisitRef.current) return;
      setInputModeState(mode);
      try {
        window.localStorage.setItem(storageKey(videoId), mode);
      } catch {
        // ignore
      }
    },
    [videoId]
  );

  return { inputMode, setInputMode, applyServerMode };
}
