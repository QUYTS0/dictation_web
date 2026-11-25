"use client";

import { useState } from "react";
import { EyeOff } from "lucide-react";

const noticeKey = (userId: string) => `dictalearn:league-notice-dismissed:${userId}`;
const readDismissed = (userId: string) => {
  try {
    return window.localStorage.getItem(noticeKey(userId)) === "1";
  } catch {
    return false;
  }
};

/**
 * The one-time privacy notice (plan §4.3, D7): everyone takes part under a
 * generated nickname by default, so the learner is told how they appear and
 * where to change it. `persistent` (the /leaderboard page) always shows it;
 * otherwise "Got it" hides it for good in this browser.
 */
export function LeaguePrivacyNotice({
  userId,
  displayName,
  onOpenPreferences,
  persistent = false,
}: {
  userId: string;
  displayName: string;
  onOpenPreferences: () => void;
  persistent?: boolean;
}) {
  const [dismissed, setDismissed] = useState(() => !persistent && readDismissed(userId));
  if (dismissed) return null;
  return (
    <div data-testid="league-privacy-notice" className="flex items-start gap-2.5 rounded-xl border border-line bg-surface p-3 text-xs leading-relaxed text-ink">
      <EyeOff size={14} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p>
          You appear as <strong>{displayName}</strong>. Change your name or hide yourself in Preferences.
        </p>
        <div className="mt-1.5 flex gap-3">
          <button type="button" onClick={onOpenPreferences} className="font-semibold text-primary-600 hover:text-primary-700">
            Preferences
          </button>
          {!persistent && (
            <button
              type="button"
              onClick={() => {
                try {
                  window.localStorage.setItem(noticeKey(userId), "1");
                } catch {
                  // Storage unavailable: the notice comes back next visit — harmless.
                }
                setDismissed(true);
              }}
              className="font-semibold text-muted hover:text-ink"
            >
              Got it
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
