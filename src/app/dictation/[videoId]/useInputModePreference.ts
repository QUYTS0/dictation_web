"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { InputMode } from "./types";

function storageKey(videoId: string): string {
  return `dictation.input-mode.${videoId}`;
}

/**
 * Which central-input-area component the practice page shows: the dictation
 * typing box, or the read-only Listening Mode transcript. The `?mode=` URL
 * query param is the source of truth — set by the dashboard, a resumable
 * session link, or a direct URL — so refreshes and shared links always agree
 * on the mode. A per-video localStorage fallback recalls the last mode used
 * for links (typed URLs, old bookmarks) that omit the param.
 */
export function useInputModePreference(videoId: string) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const modeParam = searchParams.get("mode");

  const [inputMode, setInputModeState] = useState<InputMode>(modeParam === "listening" ? "listening" : "dictation");

  useEffect(() => {
    if (modeParam) {
      setInputModeState(modeParam === "listening" ? "listening" : "dictation");
      return;
    }
    setInputModeState("dictation");
    if (typeof window === "undefined") return;
    try {
      if (window.localStorage.getItem(storageKey(videoId)) === "listening") {
        setInputModeState("listening");
      }
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
      else params.set("mode", "listening");
      const qs = params.toString();
      router.replace(`/dictation/${videoId}${qs ? `?${qs}` : ""}`, { scroll: false });
    },
    [router, videoId]
  );

  return { inputMode, setInputMode };
}
