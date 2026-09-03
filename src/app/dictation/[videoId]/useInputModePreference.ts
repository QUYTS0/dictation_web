"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { InputMode } from "./types";

function storageKey(videoId: string): string {
  return `dictation.input-mode.${videoId}`;
}

// Modes other than the default ("dictation") carry an explicit `?mode=`
// value; dictation stays paramless as before so existing links are unaffected.
const NON_DEFAULT_MODES: ReadonlyArray<InputMode> = ["listening", "shadowing", "pronunciation"];

function parseInputMode(value: string | null): InputMode {
  return (NON_DEFAULT_MODES as readonly string[]).includes(value ?? "") ? (value as InputMode) : "dictation";
}

/**
 * Which central-input-area component the practice page shows: the dictation
 * typing box, the read-only Listening Mode transcript, or the Shadowing /
 * Pronunciation Practice recorder panels. The `?mode=` URL query param is the
 * source of truth — set by the dashboard, a resumable session link, or a
 * direct URL — so refreshes and shared links always agree on the mode. A
 * per-video localStorage fallback recalls the last mode used for links
 * (typed URLs, old bookmarks) that omit the param.
 */
export function useInputModePreference(videoId: string) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const modeParam = searchParams.get("mode");

  const [inputMode, setInputModeState] = useState<InputMode>(parseInputMode(modeParam));

  useEffect(() => {
    if (modeParam) {
      setInputModeState(parseInputMode(modeParam));
      return;
    }
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

  return { inputMode, setInputMode };
}
