/**
 * Learning Reports P2 follow-up — the Round menu's rules and the new-round
 * confirmation, as pure functions (the page, its Zen controls and the cards
 * render exactly these).
 */
import { NO_PENDING_WORK, newRoundConfirmation, roundMenuModel, type RoundMenuInput } from "@/lib/practice/roundMenu";

const base: RoundMenuInput = {
  signedIn: true,
  loading: false,
  lookupFailed: false,
  roundId: "round-3",
  roundNumber: 3,
  status: "active",
  newerActiveRound: null,
  inputMode: "dictation",
  recording: false,
  restartPending: false,
};
const kinds = (input: Partial<RoundMenuInput>) => roundMenuModel({ ...base, ...input }).items.map((i) => [i.kind, i.disabled]);

describe("roundMenuModel", () => {
  it("names the round on every width: 'Round 3' on desktop; the accessible name says which round and its state", () => {
    const m = roundMenuModel(base);
    expect(m.label).toBe("Round 3");
    expect(m.accessibleName).toBe("Round menu — Round 3, in progress");
    expect(roundMenuModel({ ...base, status: "completed" }).accessibleName).toBe("Round menu — Round 3, completed");
    expect(roundMenuModel({ ...base, roundNumber: null }).label).toBe("Round");
  });

  it("11: the same two actions for active and completed rounds in Dictation, Shadowing and Listening", () => {
    for (const status of ["active", "completed"] as const) {
      for (const inputMode of ["dictation", "shadowing", "listening"] as const) {
        expect(kinds({ status, inputMode })).toEqual([
          ["view_report", false],
          ["practice_again_new_round", false],
        ]);
      }
    }
  });

  it("6: a running recording disables both, with the reason", () => {
    const m = roundMenuModel({ ...base, recording: true });
    expect(m.items.map((i) => [i.disabled, i.reason])).toEqual([
      [true, "Stop recording to view report."],
      [true, "Stop recording to start a new round."],
    ]);
  });

  it("13: a restart already in flight can't be requested again", () => {
    expect(roundMenuModel({ ...base, restartPending: true }).items[1]).toMatchObject({ disabled: true, reason: "Starting a new round…" });
  });

  it("loading or a failed lookup never guesses a round", () => {
    expect(kinds({ loading: true, roundId: null })).toEqual([
      ["view_report", true],
      ["practice_again_new_round", true],
    ]);
    expect(roundMenuModel({ ...base, loading: true }).items[0].reason).toBe("Loading this video's round…");
    expect(roundMenuModel({ ...base, roundId: null, lookupFailed: true }).items[0].reason).toMatch(/Couldn't check this video's round/);
  });

  it("8: Listening without a round: both unavailable, explained — no round is created to fill the menu", () => {
    const m = roundMenuModel({ ...base, roundId: null, roundNumber: null, status: null, inputMode: "listening" });
    expect(m.items.every((i) => i.disabled)).toBe(true);
    expect(m.note).toMatch(/Listening doesn't start a practice round/);
    expect(m.accessibleName).toBe("Round menu — No practice round yet.");
  });

  it("19: an outdated round view offers the current round instead of a new one", () => {
    const m = roundMenuModel({ ...base, status: "completed", newerActiveRound: { roundId: "round-4", roundNumber: 4 } });
    expect(m.items.map((i) => [i.kind, i.label, i.disabled])).toEqual([
      ["view_report", "View round report", false],
      ["go_to_current_round", "Go to current round (Round 4)", false],
    ]);
    expect(m.note).toBe("A newer round (Round 4) is in progress.");
  });

  it("signed out: nothing to open", () => {
    expect(roundMenuModel({ ...base, signedIn: false }).items.every((i) => i.disabled)).toBe(true);
  });
});

describe("newRoundConfirmation", () => {
  it("uses the exact wording for completed and active rounds", () => {
    expect(newRoundConfirmation("completed", NO_PENDING_WORK)).toMatchObject({
      title: "Start a new round?",
      body: "Your previous round and reports will remain in History. Progress starts from zero.",
      blockers: [],
      unsaved: null,
      notes: [],
    });
    expect(newRoundConfirmation("active", NO_PENDING_WORK)).toMatchObject({
      title: "End this round and start a new one?",
      body: "Your current answers and results will remain in History. The new round starts from zero.",
    });
  });

  it("16: recording and saves in flight block; unsaved takes/scores need a choice; a draft and a running score are disclosed", () => {
    const c = newRoundConfirmation("active", {
      recording: true,
      answerSaving: true,
      recordingsSaving: 2,
      recordingsFailed: 1,
      scoresUnsaved: 1,
      evaluationRunning: true,
      draft: true,
    });
    expect(c.blockers).toEqual([
      "Stop recording first.",
      "Your answer is still being saved — wait a moment.",
      "2 recordings are still being saved — wait a moment.",
    ]);
    expect(c.unsaved).toBe("1 recording and 1 pronunciation score from this round couldn't be saved yet.");
    expect(c.notes).toEqual([
      "Your unsent answer for this sentence will be discarded.",
      "A pronunciation score is still being calculated — it stays with this round's recording.",
    ]);
  });
});
