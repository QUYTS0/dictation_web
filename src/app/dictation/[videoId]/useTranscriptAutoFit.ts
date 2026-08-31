"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";

// Safe shrink range for the English transcript, tried largest-first. 20px
// matches the original (desktop) text-xl size, so the common case — a
// sentence that already fits at full size — never visibly changes.
const ENGLISH_FONT_STEPS_PX = [20, 18, 16] as const;
// English-to-translation gap, shrunk only once the font floor still overflows.
const GAP_STEPS_PX = [8, 6, 4] as const;

const ENGLISH_TARGET_SELECTOR = "[data-transcript-english]";

/**
 * Fits the mobile transcript stage's content (English + Vietnamese) inside
 * its fixed-height box: shrink the English font size, then the gap, and if
 * it still overflows, fall back to internal scrolling — the stage itself
 * never grows or shrinks. Re-measures whenever `deps` changes (e.g. the
 * active sentence) or the stage's own box actually resizes (orientation
 * change, or a live resize across the `md` breakpoint) — never when a
 * mobile browser toolbar shows/hides, since the stage is sized in `svh`.
 * A no-op on desktop, where the stage is `display:contents` and clientHeight
 * reads 0.
 */
export function useTranscriptAutoFit(deps: readonly unknown[]) {
  const contentRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [englishFontPx, setEnglishFontPx] = useState<number>(ENGLISH_FONT_STEPS_PX[0]);
  const [gapPx, setGapPx] = useState<number>(GAP_STEPS_PX[0]);
  const [needsScroll, setNeedsScroll] = useState(false);

  const fit = useCallback(() => {
    const content = contentRef.current;
    const measure = measureRef.current;
    if (!content || !measure) return;

    const available = content.clientHeight;
    if (available === 0) {
      // Desktop: the stage is `display:contents`, so there's no fixed box to
      // fit into — reset to defaults so a live resize across the breakpoint
      // (not just a fresh load at a given width) doesn't strand a shrunk
      // mobile font size on the unrelated desktop layout.
      setEnglishFontPx(ENGLISH_FONT_STEPS_PX[0]);
      setGapPx(GAP_STEPS_PX[0]);
      setNeedsScroll(false);
      return;
    }

    // Dictation and Listening mode both keep a `[data-transcript-english]`
    // node mounted (Dictation's stays in the DOM, just `hidden`, so its
    // internal typing state survives a mode switch) — pick whichever one is
    // actually visible so a hidden node's fixed layout doesn't get mutated
    // instead of (and skew the measurement of) the one that's on screen.
    const candidates = Array.from(measure.querySelectorAll<HTMLElement>(ENGLISH_TARGET_SELECTOR));
    const englishTarget = candidates.find((el) => el.offsetParent !== null) ?? candidates[0] ?? null;

    let resolvedFont: number = ENGLISH_FONT_STEPS_PX[ENGLISH_FONT_STEPS_PX.length - 1];
    let resolvedGap: number = GAP_STEPS_PX[GAP_STEPS_PX.length - 1];
    let fits = false;

    outer: for (const font of ENGLISH_FONT_STEPS_PX) {
      if (englishTarget) englishTarget.style.fontSize = `${font}px`;
      for (const gap of GAP_STEPS_PX) {
        measure.style.gap = `${gap}px`;
        if (measure.scrollHeight <= available) {
          resolvedFont = font;
          resolvedGap = gap;
          fits = true;
          break outer;
        }
      }
    }

    setEnglishFontPx(resolvedFont);
    setGapPx(resolvedGap);
    setNeedsScroll(!fits);
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(fit, deps);

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => fit());
    observer.observe(content);
    return () => observer.disconnect();
  }, [fit]);

  return { contentRef, measureRef, englishFontPx, gapPx, needsScroll };
}
