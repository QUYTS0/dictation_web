"use client";

import { useEffect, useRef } from "react";
import clsx from "clsx";
import { Check } from "lucide-react";
import { EASE_POP, POP_IN, playOnce } from "@/lib/motion";

/** r = 13 in a 32-unit box (keep in step with `ringFill` in globals.css). */
const CIRCUMFERENCE = 2 * Math.PI * 13;

/**
 * The weekly track's "today" marker: today's active minutes toward the daily
 * goal. An amber arc grows as the minutes add up; once the goal is met the
 * ring closes in teal around a check, like a practiced day. Decorative (the
 * day's button or label names the same facts). The arc fills when it
 * appears and slides on change; the check pops in once, only when the goal
 * is met while the page is open (not on every visit).
 */
export function GoalRing({ pct, met }: { pct: number; met: boolean }) {
  const checkRef = useRef<HTMLSpanElement>(null);
  const wasMet = useRef(met);

  useEffect(() => {
    if (met && !wasMet.current) playOnce(checkRef.current, POP_IN, { duration: 350, delay: 400, easing: EASE_POP, fill: "backwards" });
    wasMet.current = met;
  }, [met]);

  const fraction = met ? 1 : Math.min(1, Math.max(0, pct / 100));
  return (
    <span aria-hidden="true" data-testid="goal-ring" data-met={met} className="relative flex size-full items-center justify-center">
      <svg viewBox="0 0 32 32" className="absolute inset-0 size-full -rotate-90">
        <circle cx="16" cy="16" r="13" fill="none" strokeWidth="3" className={clsx("transition-colors", met ? "stroke-success/30" : "stroke-white/15")} />
        {fraction > 0 && (
          <circle
            cx="16"
            cy="16"
            r="13"
            fill="none"
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            style={{ strokeDashoffset: CIRCUMFERENCE * (1 - fraction) }}
            className={clsx("animate-ring-fill", met ? "stroke-success" : "stroke-reward")}
          />
        )}
      </svg>
      {met ? (
        <span ref={checkRef} className="relative flex size-[70%] items-center justify-center rounded-full bg-success text-hero">
          <Check size={12} strokeWidth={3.25} />
        </span>
      ) : (
        <span className="relative h-1.5 w-1.5 rounded-full bg-reward" />
      )}
    </span>
  );
}
