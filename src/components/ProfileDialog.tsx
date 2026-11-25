"use client";

import { useId, useRef, useState, type FormEvent, type RefObject } from "react";
import clsx from "clsx";
import { X } from "lucide-react";
import { ModalDialog } from "@/components/ModalDialog";
import { useToast } from "@/components/ToastProvider";
import { useAuth } from "@/context/auth";
import { DAILY_GOAL_CHOICES, DEFAULT_DAILY_GOAL_MINUTES } from "@/lib/constants/dailyGoal";
import { useProfileQuery, useUpdateProfileMutation } from "@/lib/queries/profile";
import type { UserProfilePatch } from "@/lib/types/profile";

interface ProfileDialogProps {
  onClose: () => void;
  /** Where focus goes on close when the opener itself unmounts (a menu item). */
  returnFocusRef?: RefObject<HTMLElement | null>;
}

const PUBLIC_NAME_MAX = 24;
/** The database's normalization (fn_update_my_profile): trimmed, single spaces. */
const normalizeName = (s: string) => s.trim().replace(/\s+/g, " ");

/**
 * "Profile & preferences" (plan §4.2), opened from the account menu, the
 * Dashboard's Today's target and the leaderboard. Saved to the account
 * (every device):
 *   - the daily goal (Phase 4)
 *   - the public name shown on leaderboards (empty = the generated
 *     nickname) and whether to appear on them at all (Phase 7, D7)
 * Only the changed values are sent; the database validates them.
 */
export function ProfileDialog({ onClose, returnFocusRef }: ProfileDialogProps) {
  const { user } = useAuth();
  const userId = user?.id;
  const toast = useToast();
  const profileQuery = useProfileQuery(userId);
  const update = useUpdateProfileMutation(userId);
  const [choice, setChoice] = useState<number | null>(null);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [shownDraft, setShownDraft] = useState<boolean | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const checkedRef = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const nameHintId = useId();
  const nameErrorId = useId();

  const profile = profileQuery.data;
  const saved = profile ? (profile.dailyGoalMinutes ?? DEFAULT_DAILY_GOAL_MINUTES) : null;
  const selected = choice ?? saved;
  const nameValue = nameDraft ?? profile?.publicName ?? "";
  const shown = shownDraft ?? !(profile?.leaderboardHidden ?? false);

  const buildPatch = (): UserProfilePatch | null => {
    if (!profile || selected === null) return null;
    const patch: UserProfilePatch = {};
    // An unset goal keeps meaning "the default" unless another value is chosen.
    if (selected !== saved) patch.dailyGoalMinutes = selected;
    const name = normalizeName(nameValue);
    if (name !== (profile.publicName ?? "")) patch.publicName = name === "" ? null : name;
    if (shown === profile.leaderboardHidden) patch.leaderboardHidden = !shown;
    return patch;
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (update.isPending) return;
    const patch = buildPatch();
    if (!patch) return;
    if ("publicName" in patch && patch.publicName !== null && (patch.publicName!.length < 2 || patch.publicName!.length > PUBLIC_NAME_MAX)) {
      setNameError(`Use 2–${PUBLIC_NAME_MAX} characters, or leave it empty.`);
      return;
    }
    if (Object.keys(patch).length === 0) return onClose();
    setNameError(null);
    update.mutate(patch, {
      onSuccess: (p) => {
        const onlyGoal = Object.keys(patch).length === 1 && "dailyGoalMinutes" in patch;
        toast(onlyGoal ? { message: "Daily goal saved", sub: `${p.dailyGoalMinutes ?? selected} min of practice a day` } : { message: "Preferences saved" });
        onClose();
      },
      onError: (err) => {
        if ((err as { status?: number }).status === 400 && "publicName" in patch) {
          setNameError("That name can't be used. Use 2–24 characters, without @ < > / \\ : and not a \"Learner\" nickname.");
        }
      },
    });
  };

  const onlyGoalPending = (() => {
    const v = update.variables;
    return !!v && Object.keys(v).length === 1 && "dailyGoalMinutes" in v;
  })();

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
          <div className="space-y-6">
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

            <fieldset aria-busy={!profile} disabled={!profile || update.isPending} className="space-y-3">
              <legend className="text-sm font-semibold text-ink">Leaderboard</legend>
              <div>
                <label htmlFor="profile-public-name" className="block text-xs font-semibold text-ink">
                  Public name
                </label>
                <input
                  id="profile-public-name"
                  type="text"
                  value={nameValue}
                  maxLength={PUBLIC_NAME_MAX}
                  placeholder={profile?.nickname ?? ""}
                  onChange={(e) => {
                    setNameDraft(e.target.value);
                    setNameError(null);
                  }}
                  aria-describedby={nameError ? `${nameHintId} ${nameErrorId}` : nameHintId}
                  aria-invalid={!!nameError}
                  className="mt-1 w-full rounded-lg border border-line px-3 py-2 text-sm text-ink placeholder:text-muted focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/30"
                />
                <p id={nameHintId} className="mt-1 text-xs leading-relaxed text-muted">
                  {profile ? `Leave it empty to appear as ${profile.nickname}.` : " "}
                </p>
                {nameError && (
                  <p id={nameErrorId} role="alert" className="mt-1 text-xs text-danger">
                    {nameError}
                  </p>
                )}
              </div>
              <label className="flex items-start gap-2.5 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={shown}
                  onChange={(e) => setShownDraft(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-line text-primary-600 focus:ring-primary-500"
                />
                <span>
                  <span className="font-semibold">Show me on leaderboards</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-muted">
                    Boards show your name, weekly XP, streak and kudos — never your email or photo. When off, you&apos;re left out and don&apos;t see
                    them.
                  </span>
                </span>
              </label>
            </fieldset>
          </div>
        )}

        {update.isError && !nameError && (
          <p role="alert" className="mt-4 text-sm text-danger">
            {onlyGoalPending ? "Couldn't save your daily goal. Please try again." : "Couldn't save your preferences. Please try again."}
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
