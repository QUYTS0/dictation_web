/**
 * The practice page's Round menu and its "new round" confirmation (Learning
 * Reports P2 follow-up) — pure rules, shared by the top bar, the compact
 * mobile trigger, the Zen controls, the completed-round card and the report
 * actions, so every entry point offers the same actions with the same
 * guards.
 *
 * Nothing here guesses a round: while the round lookup is loading or failed,
 * or when the page has no round (Listening-only visits never create one),
 * the round actions are unavailable and say why.
 *
 * Pure: no network, no writes.
 */

export type RoundStatus = "active" | "completed" | "abandoned";

export interface RoundMenuInput {
  signedIn: boolean;
  /** The resume lookup hasn't answered yet. */
  loading: boolean;
  /** The resume lookup failed (no round id is guessed). */
  lookupFailed: boolean;
  roundId: string | null;
  roundNumber: number | null;
  status: RoundStatus | null;
  /** An active round of this video other than the one on screen. */
  newerActiveRound: { roundId: string; roundNumber: number } | null;
  inputMode: "dictation" | "shadowing" | "listening";
  /** A Shadowing recording is running right now. */
  recording: boolean;
  /** A confirmed restart request is in flight. */
  restartPending: boolean;
}

export type RoundMenuItemKind = "view_report" | "practice_again_new_round" | "go_to_current_round";

export interface RoundMenuItem {
  kind: RoundMenuItemKind;
  label: string;
  disabled: boolean;
  /** Why the item is unavailable (shown under it, and its accessible description). */
  reason?: string;
}

export interface RoundMenuModel {
  /** Desktop trigger text ("Round 3", or "Round" when the number is unknown). */
  label: string;
  /** Accessible name of the trigger — identifies the round on every width. */
  accessibleName: string;
  items: RoundMenuItem[];
  /** A short explanation shown at the top of the menu, when needed. */
  note?: string;
}

const STATUS_TEXT: Record<RoundStatus, string> = { active: "in progress", completed: "completed", abandoned: "ended" };

export function roundMenuModel(input: RoundMenuInput): RoundMenuModel {
  const label = input.roundNumber ? `Round ${input.roundNumber}` : "Round";
  const unavailable = (reason: string, note?: string): RoundMenuModel => ({
    label,
    accessibleName: `Round menu — ${reason}`,
    note,
    items: [
      { kind: "view_report", label: "View round report", disabled: true, reason },
      { kind: "practice_again_new_round", label: "Practice again — new round", disabled: true, reason },
    ],
  });

  if (!input.signedIn) return unavailable("Sign in to keep a report of each round.");
  if (input.loading) return unavailable("Loading this video's round…");
  if (!input.roundId) {
    if (input.lookupFailed) return unavailable("Couldn't check this video's round. Reload to try again.");
    return input.inputMode === "listening"
      ? unavailable(
          "No practice round yet.",
          "Listening doesn't start a practice round — its progress is shown under the player. Practise Dictation or Shadowing to start one."
        )
      : unavailable("No practice round yet.", "Your first answer or recording starts a round.");
  }

  const roundName = input.roundNumber ? `Round ${input.roundNumber}` : "this round";
  const accessibleName = `Round menu — ${roundName}${input.status ? `, ${STATUS_TEXT[input.status]}` : ""}`;
  const viewReport: RoundMenuItem = input.recording
    ? { kind: "view_report", label: "View round report", disabled: true, reason: "Stop recording to view report." }
    : { kind: "view_report", label: "View round report", disabled: false };

  const newer = input.newerActiveRound && input.newerActiveRound.roundId !== input.roundId ? input.newerActiveRound : null;
  if (newer) {
    // An outdated round view never starts (or ends) anything: the current
    // round is the one to continue.
    return {
      label,
      accessibleName,
      note: `A newer round (Round ${newer.roundNumber}) is in progress.`,
      items: [viewReport, { kind: "go_to_current_round", label: `Go to current round (Round ${newer.roundNumber})`, disabled: false }],
    };
  }

  const newRound: RoundMenuItem = input.recording
    ? { kind: "practice_again_new_round", label: "Practice again — new round", disabled: true, reason: "Stop recording to start a new round." }
    : input.restartPending
      ? { kind: "practice_again_new_round", label: "Practice again — new round", disabled: true, reason: "Starting a new round…" }
      : { kind: "practice_again_new_round", label: "Practice again — new round", disabled: false };
  return { label, accessibleName, items: [viewReport, newRound] };
}

// ------------------------------------------------------------ confirmation

/** Local work that a new round would leave behind (never discarded silently). */
export interface PendingLocalWork {
  /** A Shadowing recording is running. */
  recording: boolean;
  /** A Dictation answer is being checked and saved. */
  answerSaving: boolean;
  /** Finished takes still being saved. */
  recordingsSaving: number;
  /** Finished takes whose save failed (their metadata can still be retried). */
  recordingsFailed: number;
  /** Pronunciation scores that came back but couldn't be saved yet (recoverable). */
  scoresUnsaved: number;
  /** A pronunciation score is being calculated for a saved take. */
  evaluationRunning: boolean;
  /** Typed, unsubmitted Dictation answer text. */
  draft: boolean;
}

export const NO_PENDING_WORK: PendingLocalWork = {
  recording: false,
  answerSaving: false,
  recordingsSaving: 0,
  recordingsFailed: 0,
  scoresUnsaved: 0,
  evaluationRunning: false,
  draft: false,
};

export interface NewRoundConfirmation {
  title: string;
  body: string;
  /** Must clear before a new round can start (waiting is enough). */
  blockers: string[];
  /** Unsaved results the learner must retry or explicitly discard first. */
  unsaved: string | null;
  /** What happens to other local work (no action needed). */
  notes: string[];
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function newRoundConfirmation(status: RoundStatus | null, work: PendingLocalWork): NewRoundConfirmation {
  const active = status === "active";
  const blockers: string[] = [];
  if (work.recording) blockers.push("Stop recording first.");
  if (work.answerSaving) blockers.push("Your answer is still being saved — wait a moment.");
  if (work.recordingsSaving > 0) blockers.push(`${plural(work.recordingsSaving, "recording is", "recordings are")} still being saved — wait a moment.`);

  const unsavedParts: string[] = [];
  if (work.recordingsFailed > 0) unsavedParts.push(plural(work.recordingsFailed, "recording", "recordings"));
  if (work.scoresUnsaved > 0) unsavedParts.push(plural(work.scoresUnsaved, "pronunciation score", "pronunciation scores"));
  const unsaved = unsavedParts.length > 0 ? `${unsavedParts.join(" and ")} from this round couldn't be saved yet.` : null;

  const notes: string[] = [];
  if (work.draft) notes.push("Your unsent answer for this sentence will be discarded.");
  if (work.evaluationRunning) notes.push("A pronunciation score is still being calculated — it stays with this round's recording.");

  return {
    title: active ? "End this round and start a new one?" : "Start a new round?",
    body: active
      ? "Your current answers and results will remain in History. The new round starts from zero."
      : "Your previous round and reports will remain in History. Progress starts from zero.",
    blockers,
    unsaved,
    notes,
  };
}
