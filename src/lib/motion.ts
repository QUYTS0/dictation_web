/**
 * One-shot motion for things that just happened (a goal met, a streak that
 * grew, kudos given). The rules live in .github/skills/dictalearn-studio-ui
 * (§6 Motion): only on a change, short, ease-out, never looping, and nothing
 * at all under prefers-reduced-motion. Animations that play when an element
 * appears (progress fills, the flashcard turn) are CSS classes in
 * src/app/globals.css instead.
 */

export const EASE_OUT = "cubic-bezier(0.2, 0.8, 0.2, 1)";
/** Ease-out with a small overshoot, for pops. */
export const EASE_POP = "cubic-bezier(0.34, 1.56, 0.64, 1)";

/** Grows in from small with a slight overshoot (a check appearing). */
export const POP_IN: Keyframe[] = [
  { transform: "scale(0.4)", opacity: 0 },
  { transform: "scale(1)", opacity: 1 },
];

/** A quick bump of something already on screen (a heart, a flame). */
export const BUMP: Keyframe[] = [
  { transform: "scale(1)" },
  { transform: "scale(1.3)", offset: 0.35 },
  { transform: "scale(0.95)", offset: 0.65 },
  { transform: "scale(1)" },
];

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Plays `keyframes` once on `el` with the Web Animations API. A no-op under
 * reduced motion, without an element, or where the API is missing (jsdom).
 */
export function playOnce(el: Element | null | undefined, keyframes: Keyframe[], options: KeyframeAnimationOptions): void {
  if (!el || typeof el.animate !== "function" || prefersReducedMotion()) return;
  el.animate(keyframes, options);
}
