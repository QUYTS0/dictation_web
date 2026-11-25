"use client";

import { useId, useRef, useState, type FormEvent, type RefObject } from "react";
import clsx from "clsx";
import { X } from "lucide-react";
import { ModalDialog } from "@/components/ModalDialog";
import { useToast } from "@/components/ToastProvider";
import { useAuth } from "@/context/auth";
import { DAILY_GOAL_CHOICES, DEFAULT_DAILY_GOAL_MINUTES } from "@/lib/constants/dailyGoal";
import { useProfileQuery, useUpdateProfileMutation } from "@/lib/queries/profile";

interface ProfileDialogProps {
  onClose: () => void;
  /** Where focus goes on close when the opener itself unmounts (a menu item). */
  returnFocusRef?: RefObject<HTMLElement | null>;
}

/**
 * "Profile & preferences" (plan §4.2), opened from the account menu and from
 * the Dashboard's Today's target. Phase 4: the daily goal, saved to the
 * account (every device). The public name and leaderboard visibility join it
 * with the leaderboard (Phase 7).
 */
export function ProfileDialog({ onClose, returnFocusRef }: ProfileDialogProps) {
  const { user } = useAuth();
  const userId = user?.id;
  const toast = useToast();
  const profileQuery = useProfileQuery(userId);
  const update = useUpdateProfileMutation(userId);
  const [choice, setChoice] = useState<number | null>(null);
  const checkedRef = useRef<HTMLInputElement>(null);
  const hintId = useId();

  const profile = profileQuery.data;
  const saved = profile ? (profile.dailyGoalMinutes ?? DEFAULT_DAILY_GOAL_MINUTES) : null;
  const selected = choice ?? saved;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (selected === null || update.isPending) return;
    // Nothing changed (an unset goal keeps meaning "the default").
    if (selected === saved) return onClose();
    update.mutate(
      { dailyGoalMinutes: selected },
      {
        onSuccess: (p) => {
          toast({ message: "Daily goal saved", sub: `${p.dailyGoalMinutes ?? selected} min of practice a day` });
          onClose();
        },
      }
    );
  };

  return (
    <ModalDialog labelledBy="profile-dialog-title" onClose={onClose} initialFocusRef={checkedRef} returnFocusRef={returnFocusRef} panelClassName="max-w-md">
      <form onSubmit={onSubmit} noValidate>
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h2 id="profile-dialog-title" className="text-lg font-bold text-ink">
              Profile &amp; preferences
            </h2>
            <p className="mt-0.5 text-sm text-muted">Saved to your account, on every device.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close profile and preferences"
            className="rounded-lg p-1.5 text-muted transition-colors hover:bg-surface hover:text-ink"
          >
            <X size={18} />
          </button>
        </div>

        {profileQuery.isError && !profile ? (
          <p role="alert" className="rounded-xl bg-surface p-4 text-sm text-muted">
            Your preferences aren&apos;t available right now. Please try again later.
          </p>
        ) : (
          <fieldset aria-describedby={hintId} aria-busy={!profile} disabled={!profile || update.isPending}>
            <legend className="text-sm font-semibold text-ink">Daily goal</legend>
            <p id={hintId} className="mt-1 text-xs leading-relaxed text-muted">
              Minutes of active practice a day in Dictation, Shadowing and Listening. Word reviews keep your streak going but aren&apos;t timed.
            </p>
            <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-6">
              {DAILY_GOAL_CHOICES.map((minutes) => {
                const checked = selected === minutes;
                return (
                  <label
                    key={minutes}
                    className={clsx(
                      "relative flex cursor-pointer items-center justify-center rounded-lg border px-2 py-2 text-sm font-semibold transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary-500 has-[:focus-visible]:ring-offset-1",
                      checked ? "border-primary-600 bg-primary-50 text-primary-700" : "border-line text-ink hover:bg-surface",
                      !profile && "animate-pulse cursor-default opacity-60"
                    )}
                  >
                    <input
                      ref={checked ? checkedRef : undefined}
                      type="radio"
                      name="daily-goal"
                      value={minutes}
                      checked={checked}
                      onChange={() => setChoice(minutes)}
                      className="sr-only"
                    />
                    {minutes} min
                  </label>
                );
              })}
            </div>
            {profile && profile.dailyGoalMinutes === null && (
              <p className="mt-2 text-xs text-muted">No goal saved yet — {DEFAULT_DAILY_GOAL_MINUTES} min is the default.</p>
            )}
          </fieldset>
        )}

        {update.isError && (
          <p role="alert" className="mt-4 text-sm text-danger">
            Couldn&apos;t save your daily goal. Please try again.
          </p>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-xl px-4 py-2 text-sm font-semibold text-muted transition-colors hover:bg-surface hover:text-ink">
            Cancel
          </button>
          <button
            type="submit"
            disabled={!profile || update.isPending}
            className="rounded-xl bg-primary-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {update.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}
