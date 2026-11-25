"use client";

import { useState } from "react";
import type { ReviewGrade } from "@/lib/types";

export type ReviewMode = "gap" | "meaning";

export const REVIEW_GRADES: ReadonlyArray<{ grade: ReviewGrade; label: string; key: string }> = [
  { grade: "again", label: "Again", key: "1" },
  { grade: "hard", label: "Hard", key: "2" },
  { grade: "good", label: "Good", key: "3" },
  { grade: "easy", label: "Easy", key: "4" },
];

const MODE_STORAGE_KEY = "dictalearn:review-mode";

/**
 * Fill the gap (default) or Meaning, remembered per browser. Review cards
 * only render after auth resolves on the client, so reading localStorage in
 * the initializer can't cause a hydration mismatch.
 */
export function useReviewMode(): [ReviewMode, (mode: ReviewMode) => void] {
  const [mode, setMode] = useState<ReviewMode>(() => {
    if (typeof window === "undefined") return "gap";
    try {
      return window.localStorage.getItem(MODE_STORAGE_KEY) === "meaning" ? "meaning" : "gap";
    } catch {
      return "gap";
    }
  });
  const update = (next: ReviewMode) => {
    setMode(next);
    try {
      window.localStorage.setItem(MODE_STORAGE_KEY, next);
    } catch {
      // Private mode / storage full: the choice just isn't remembered.
    }
  };
  return [mode, update];
}

type ShortcutEvent = Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey"> & { target: EventTarget | null };

/**
 * Anki-style review keys: Space/Enter flips, 1–4 grade (only once the answer
 * is showing). Never while typing in a field or with a modifier held, and
 * Space/Enter on a focused button/link is left to the browser (it activates
 * that control — the flip itself is a button).
 */
export function reviewShortcut(e: ShortcutEvent, revealed: boolean): { type: "flip" } | { type: "grade"; grade: ReviewGrade } | null {
  if (e.altKey || e.ctrlKey || e.metaKey) return null;
  const el = e.target instanceof HTMLElement ? e.target : null;
  if (el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName))) return null;
  if (e.key === " " || e.key === "Enter") {
    if (el && (el.tagName === "BUTTON" || el.tagName === "A" || el.getAttribute("role") === "button")) return null;
    return { type: "flip" };
  }
  const grade = REVIEW_GRADES.find((g) => g.key === e.key);
  return grade && revealed ? { type: "grade", grade: grade.grade } : null;
}
