"use client";

import clsx from "clsx";
import { useAuth } from "@/context/auth";
import { useStreakQuery } from "@/lib/queries/streak";
import { PAGE_PADDING_CLASS, PAGE_WIDTH_CLASS } from "@/lib/layout/pageWidth";

/**
 * Quiet app-shell footer for the scrolling signed-in pages (not the
 * Vocabulary bank, which is a fixed-viewport layout, nor the practice
 * workspace). Reads the same streak cache entry as the header pill.
 */
export default function AppFooter() {
  const { user } = useAuth();
  const streak = useStreakQuery(user?.id).data;

  return (
    <footer className="mt-auto border-t border-line bg-white py-6 text-xs text-muted">
      <div
        className={clsx(
          "mx-auto flex w-full flex-col items-center justify-between gap-3 sm:flex-row",
          PAGE_WIDTH_CLASS.wide,
          PAGE_PADDING_CLASS.wide
        )}
      >
        <p className="flex flex-wrap items-center justify-center gap-x-2">
          <span className="font-semibold text-ink">DictaLearn</span>
          <span aria-hidden="true">·</span>
          <span>English listening, dictation &amp; shadowing studio</span>
        </p>
        {user && streak && (
          <p data-testid="footer-streak" className="font-mono">
            Streak:{" "}
            <strong className="text-ink">
              {streak.streakDays} {streak.streakDays === 1 ? "day" : "days"}
            </strong>
          </p>
        )}
      </div>
    </footer>
  );
}
