"use client";

import { useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "@/lib/motion";

/**
 * The number to display for `value`, counting up (or down) to each new value
 * over `durationMs` with an ease-out. The first value shows as is: only a
 * change counts. Under reduced motion it jumps straight to the new value.
 */
export function useCountUp(value: number, durationMs = 600): number {
  const [shown, setShown] = useState(value);
  // Where the next count starts: whatever is on screen right now.
  const shownRef = useRef(value);

  useEffect(() => {
    const from = shownRef.current;
    if (from === value) return;
    const instant = prefersReducedMotion() || typeof requestAnimationFrame !== "function";
    let frame = 0;
    let start: number | null = null;
    const step = (now: number) => {
      start ??= now;
      const k = instant ? 1 : Math.min(1, (now - start) / durationMs);
      const next = Math.round(from + (value - from) * (1 - Math.pow(1 - k, 3)));
      shownRef.current = next;
      setShown(next);
      if (k < 1) frame = requestAnimationFrame(step);
    };
    if (instant) {
      // Still asynchronous, like the animated path (no state update inside the effect body).
      const timer = setTimeout(() => step(0), 0);
      return () => clearTimeout(timer);
    }
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value, durationMs]);

  return shown;
}
