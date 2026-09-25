"use client";

import { useEffect, useRef } from "react";

const SCROLL_SAVE_THROTTLE_MS = 150;

/**
 * Restores a list page's scroll position after navigating back to it, and
 * remembers it while scrolling away — sessionStorage-backed, keyed by
 * pathname + userId so one page's position is never applied to another and
 * one account's session never leaks into another's.
 *
 * `ready` must only become true once the content that determines page
 * height has actually rendered (e.g. a query's data has arrived) — restoring
 * earlier would land on a still-loading/empty page and then visibly jump
 * once content pops in. Restoration always uses `behavior: "auto"` (never
 * "smooth") so it reads as "already there", not an animated jump.
 */
export function useScrollRestoration(pathname: string, userId: string | undefined, ready: boolean) {
  const storageKey = userId ? `scroll:${pathname}:${userId}` : null;
  const restoredRef = useRef(false);
  const throttleRef = useRef<number | null>(null);

  useEffect(() => {
    restoredRef.current = false;
  }, [storageKey]);

  useEffect(() => {
    if (!ready || !storageKey || restoredRef.current || typeof window === "undefined") return;
    restoredRef.current = true;
    let saved = 0;
    try {
      saved = Number(window.sessionStorage.getItem(storageKey)) || 0;
    } catch {
      saved = 0;
    }
    if (saved <= 0) return;
    const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    window.scrollTo({ top: Math.min(saved, maxScroll), behavior: "auto" });
  }, [ready, storageKey]);

  useEffect(() => {
    if (!storageKey || typeof window === "undefined") return;
    const handleScroll = () => {
      if (throttleRef.current !== null) return;
      throttleRef.current = window.setTimeout(() => {
        throttleRef.current = null;
        try {
          window.sessionStorage.setItem(storageKey, String(window.scrollY));
        } catch {
          // ignore
        }
      }, SCROLL_SAVE_THROTTLE_MS);
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", handleScroll);
      if (throttleRef.current !== null) window.clearTimeout(throttleRef.current);
    };
  }, [storageKey]);
}
