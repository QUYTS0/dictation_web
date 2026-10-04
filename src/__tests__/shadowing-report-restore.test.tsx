import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";

// Report fidelity, UI: a result restored from the server renders the same
// learning feedback as the live one (Word Match Details, per-word
// Pronunciation feedback), labelled as saved, without any network, Azure or
// speech-recognition call; partial/legacy records are shown honestly.
import { EvaluationTab } from "@/app/dictation/[videoId]/components/EvaluationTab";
import { azureResultFrom, wordMatchFrom } from "@/app/dictation/[videoId]/shadowingServerMerge";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { buildShadowingRoundSummary } from "@/lib/practice/shadowingSummary";
import { useShadowingEvaluations } from "@/app/dictation/[videoId]/useShadowingEvaluations";
import { computeWordMatch } from "@/lib/practice/wordMatch";
import type { SentenceEvaluation, TrueEvaluationWord, WordMatchResult } from "@/app/dictation/[videoId]/types";
import type { ShadowingAttemptDto } from "@/lib/practice/shadowingTypes";
import type { RecordedClip } from "@/hooks/useAudioRecorder";

const ATTEMPT = "7b0c3b9e-0000-4000-8000-000000000001";
const EARLIER = "7b0c3b9e-0000-4000-8000-000000000002";
const PINNED = "The cat saw the other cat today.";
const HEARD = "the cat saw the hat really today";

const quota = { engineConfigured: true, usedSec: 0, limitSec: 18_000, usedCount: 0, limitReached: false };
const clip: RecordedClip = { blob: new Blob(["x"]), url: "blob:take-1", mimeType: "audio/webm", durationSec: 3 } as RecordedClip;


/** useShadowingEvaluations shares its server reads with the report cache. */
function queryWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

function dto(over: {
  attemptId?: string;
  azure?: Partial<ShadowingAttemptDto["azure"]>;
  wordMatch?: Partial<ShadowingAttemptDto["wordMatch"]>;
}): ShadowingAttemptDto {
  return {
    attemptId: over.attemptId ?? ATTEMPT,
    clientAttemptId: "c-1",
    roundId: "round-1",
    youtubeVideoId: "vid",
    transcriptId: "tr-1",
    segmentIndex: 0,
    createdAt: "2026-09-01T10:00:00.000Z",
    recordingDurationSec: 3,
    isPracticeValid: true,
    validityBasis: "client_reported",
    studySessionId: null,
    azure: {
      status: "not_evaluated", seq: 0, requestedAt: null, evaluatedAt: null, pronunciationScore: null, accuracyScore: null,
      fluencyScore: null, completenessScore: null, prosodyScore: null, errorReason: null, engineVersion: null, detail: null,
      ...over.azure,
    },
    wordMatch: { status: null, seq: 0, accuracy: null, completeness: null, evaluatedAt: null, detail: null, ...over.wordMatch },
  };
}

const liveWordMatch = (): WordMatchResult => {
  const s = computeWordMatch(PINNED, HEARD);
  return { status: "completed", recognizedText: HEARD, ...s, clipId: clip.url, attemptId: ATTEMPT, persisted: true };
};
const restoredWordMatch = (recognizedText: string | null = HEARD, attemptId = ATTEMPT) => {
  const s = recognizedText === null ? { accuracy: 45, completeness: 60, problemWords: [] } : computeWordMatch(PINNED, recognizedText);
  return wordMatchFrom(
    dto({
      attemptId,
      wordMatch: {
        status: "completed",
        seq: 1,
        accuracy: s.accuracy,
        completeness: s.completeness,
        evaluatedAt: "2026-09-01T10:00:05.000Z",
        detail: recognizedText === null ? null : { recognizedText, problemWords: s.problemWords },
      },
    })
  );
};

const words: TrueEvaluationWord[] = [
  { word: "the", accuracyScore: 95, errorType: "None" },
  { word: "cat", accuracyScore: 40, errorType: "Mispronunciation", phonemes: [{ phoneme: "k", accuracyScore: 30 }] as TrueEvaluationWord["phonemes"] },
  { word: "saw", accuracyScore: 88, errorType: "None" },
  { word: "the", accuracyScore: 91, errorType: "None" },
  { word: "other", accuracyScore: null, errorType: "Omission" },
  { word: "cat", accuracyScore: 97, errorType: "None" },
  { word: "today", accuracyScore: 85, errorType: "None" },
];
const restoredAzure = (over: Partial<ShadowingAttemptDto["azure"]> = {}, attemptId = ATTEMPT) =>
  azureResultFrom(
    dto({
      attemptId,
      azure: {
        status: "completed", seq: 1, evaluatedAt: "2026-09-01T10:00:09.000Z", pronunciationScore: 71, accuracyScore: 80,
        fluencyScore: 66, completenessScore: 90, prosodyScore: null, engineVersion: "azure-short-audio-pa/v1",
        detail: { recognizedText: "The cat saw the cat today.", words: words as unknown as NonNullable<ShadowingAttemptDto["azure"]["detail"]>["words"] },
        ...over,
      },
    })
  );

function entry(over: Partial<SentenceEvaluation> = {}, segmentIndex = 0, referenceText = PINNED): SentenceEvaluation {
  return { segmentIndex, referenceText, wordCount: 7, audioDuration: 3, ...over };
}

function renderTab(e: SentenceEvaluation | undefined, withClip = false) {
  const props = {
    recorderStatus: "idle" as const,
    autoWordMatchEnabled: true,
    onRetryWordMatch: jest.fn(),
    quota,
    evaluationSummary: buildShadowingRoundSummary({ eligibleSentences: 3, recordedSentences: null, sentences: [] }),
    onJumpToSegment: jest.fn(),
  };
  const view = render(<EvaluationTab entry={e} recordingClip={withClip ? clip : null} {...props} />);
  return {
    ...view,
    rerenderWith: (next: SentenceEvaluation) =>
      view.rerender(<EvaluationTab entry={next} recordingClip={withClip ? clip : null} {...props} />),
  };
}

/** The expanded Word Match comparison (Script + What we heard). */
function openDetails() {
  fireEvent.click(screen.getByRole("button", { name: /Details/ }));
  return screen.getByText("Script").parentElement!.parentElement!.innerHTML;
}

const fetchMock = jest.fn();
const speechCtor = jest.fn();
beforeEach(() => {
  fetchMock.mockReset();
  speechCtor.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
  Object.assign(window, { SpeechRecognition: speechCtor, webkitSpeechRecognition: speechCtor });
});

describe("Word Match after reopening", () => {
  it("offers the same Details comparison as the live report (same differences, same places)", () => {
    const live = renderTab(entry({ wordMatch: liveWordMatch() }), true);
    const liveCompact = screen.getByText(/→|Missing|Extra/).textContent;
    const liveDetails = openDetails();
    live.unmount();

    renderTab(entry({ wordMatch: restoredWordMatch(), latestRecording: { attemptId: ATTEMPT, createdAt: "", azureStatus: "not_evaluated", isPracticeValid: true } }));
    expect(screen.getByText(/Saved results for this sentence/)).toBeInTheDocument();
    expect(screen.getByText(/audio isn.t kept/)).toBeInTheDocument();
    expect(screen.getByText(/^Saved result · .*% of words matched$/)).toBeInTheDocument();
    expect(screen.getByText(/→|Missing|Extra/).textContent).toBe(liveCompact);
    expect(openDetails()).toBe(liveDetails);
    // The second "cat" (not the first) and "other" are the missed words; "hat" and "really" are
    // the extra words heard — each marked at its own position.
    const script = screen.getByText("Script").parentElement!;
    const cats = within(script).getAllByText(/^cat/);
    expect(cats).toHaveLength(2);
    expect(cats[0].className).not.toMatch(/green/);
    expect(cats[1].className).toMatch(/green/);
    expect(within(script).getByText(/^other/).className).toMatch(/green/);
    const heard = screen.getByText("What we heard").parentElement!;
    expect(within(heard).getByText(/^hat/).className).toMatch(/purple/);
    expect(within(heard).getAllByText(/^the/).map((el) => el.className)).toEqual(["", ""]);
    expect(within(heard).getByText(/^really/).className).toMatch(/purple/);
  });

  it("a record saved without its recognized text shows its percentage and says the comparison wasn't saved", () => {
    renderTab(entry({ wordMatch: restoredWordMatch(null) }));
    expect(screen.getByText("45% of words matched")).toBeInTheDocument();
    expect(screen.getByText(/comparison wasn.t saved for this recording/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Details/ })).toBeNull();
    expect(screen.queryByText("Script")).toBeNull();
  });

  it("an empty recognition stays 'no speech recognized' — not 'not saved'", () => {
    renderTab(entry({ wordMatch: restoredWordMatch("") }));
    expect(screen.getByText(/No speech was recognized/)).toBeInTheDocument();
    expect(screen.queryByText(/wasn.t saved/)).toBeNull();
  });

  it("a Word Match from an earlier recording is labelled so", () => {
    renderTab(
      entry({
        wordMatch: restoredWordMatch(HEARD, EARLIER),
        latestRecording: { attemptId: ATTEMPT, createdAt: "", azureStatus: "not_evaluated", isPracticeValid: true },
      })
    );
    expect(screen.getByText(/from an earlier recording/)).toBeInTheDocument();
  });
});

describe("Pronunciation after reopening", () => {
  it("keeps scores and per-word feedback (each occurrence separately) with the detailed report available", () => {
    const saved = restoredAzure();
    renderTab(entry({ lastSuccessfulTrueEvaluation: saved, trueEvaluation: saved }));
    expect(screen.getByText("71")).toBeInTheDocument();
    expect(screen.getAllByText(/^Saved result · /).length).toBeGreaterThan(0);
    expect(screen.getByText("Focus")).toBeInTheDocument();
    const details = screen.getByText("Word details").closest("details")!;
    // Only the flagged occurrence of "cat" is listed, with its own label and score.
    expect(within(details).getAllByText("cat")).toHaveLength(1);
    expect(within(details).getByText("Mispronunciation · 40/100")).toBeInTheDocument();
    expect(within(details).getByText("other")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Detailed report/ })).toBeInTheDocument();
    expect(screen.queryByText(/Word-level feedback wasn.t saved/)).toBeNull();
  });

  it("a metric that wasn't returned stays unavailable (not 0)", () => {
    const { unmount } = renderTab(entry({ lastSuccessfulTrueEvaluation: restoredAzure({ prosodyScore: 70 }) }));
    const withProsody = screen.queryAllByText("Prosody").length;
    unmount();
    renderTab(entry({ lastSuccessfulTrueEvaluation: restoredAzure({ prosodyScore: null }) }));
    expect(screen.queryAllByText("Prosody").length).toBe(withProsody - 1);
    expect(screen.queryByText("0")).toBeNull();
  });

  it("a summary-only record shows its scores and says word-level feedback wasn't saved — no invented words", () => {
    renderTab(entry({ lastSuccessfulTrueEvaluation: restoredAzure({ detail: null }) }));
    expect(screen.getByText("71")).toBeInTheDocument();
    expect(screen.getByText(/Word-level feedback wasn.t saved for this recording/)).toBeInTheDocument();
    expect(screen.queryByText("Word details")).toBeNull();
  });

  it("an earlier evaluation is labelled as such when the newest recording has none", () => {
    const saved = restoredAzure({}, EARLIER);
    renderTab(
      entry({
        lastSuccessfulTrueEvaluation: saved,
        trueEvaluation: saved,
        latestRecording: { attemptId: ATTEMPT, createdAt: "", azureStatus: "not_evaluated", isPracticeValid: true },
      })
    );
    expect(screen.getByText(/From an earlier recording — your latest saved recording/)).toBeInTheDocument();
    expect(screen.getByText("71")).toBeInTheDocument();
  });
});

describe("opening saved detail", () => {
  it("calls no network, Azure or speech recognition", () => {
    const saved = restoredAzure();
    renderTab(entry({ wordMatch: restoredWordMatch(), lastSuccessfulTrueEvaluation: saved, trueEvaluation: saved }));
    openDetails();
    fireEvent.click(screen.getByText("Word details"));
    fireEvent.click(screen.getByRole("button", { name: /Detailed report/ }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(speechCtor).not.toHaveBeenCalled();
  });

  it("switching sentence shows that sentence's own report, with the comparison collapsed again", () => {
    const OTHER_SENTENCE = "Birds sing early.";
    const other = wordMatchFrom(
      dto({
        attemptId: EARLIER,
        wordMatch: { status: "completed", seq: 1, accuracy: 67, completeness: 67, detail: { recognizedText: "birds sing", problemWords: [] } },
      })
    );
    const view = renderTab(entry({ wordMatch: restoredWordMatch() }));
    openDetails();
    view.rerenderWith(entry({ wordMatch: other }, 1, OTHER_SENTENCE));
    expect(screen.queryByText("Script")).toBeNull();
    expect(screen.getByText(/early — Missing/)).toBeInTheDocument();
    openDetails();
    expect(within(screen.getByText("Script").parentElement!).getByText(/^birds/)).toBeInTheDocument();
    expect(screen.queryByText(/^hat/)).toBeNull();
  });
});

describe("pinned revision", () => {
  const round = (transcriptId: string) => ({
    roundId: "round-1",
    youtubeVideoId: "vid",
    transcriptId,
    roundStatus: "active",
    evaluationTimeoutSec: 120,
    segments: [
      {
        segmentIndex: 0,
        attemptCount: 1,
        latestAttempt: dto({}),
        latestSuccessfulAzureAttempt: null,
        latestWordMatchAttempt: dto({ wordMatch: { status: "completed", seq: 1, accuracy: 50, completeness: 50, detail: { recognizedText: HEARD, problemWords: [] } } }),
        azureHistory: [],
      },
    ],
  });
  const respond = (body: unknown) => fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => body } as Response);
  const hook = (transcriptId: string) =>
    renderHook(
      () =>
        useShadowingEvaluations({
          videoId: "vid", transcriptId, userId: "user-1", roundId: "round-1", eligibleSentences: 3, recordedSentences: null, referenceTextFor: () => PINNED,
        }),
      { wrapper: queryWrapper() }
    );

  beforeEach(() => sessionStorage.clear());

  it("restores results against the round's pinned sentence", async () => {
    respond(round("tr-1"));
    const { result } = hook("tr-1");
    await waitFor(() => expect(result.current.evaluations[0]?.wordMatch?.recognizedText).toBe(HEARD));
    expect(result.current.evaluations[0].referenceText).toBe(PINNED);
  });

  it("never attaches results pinned to another revision to the sentences shown, and says why", async () => {
    respond(round("tr-old"));
    const { result } = hook("tr-new");
    await waitFor(() => expect(result.current.serverLoadError).toMatch(/different version of this script/));
    await act(async () => {});
    expect(result.current.evaluations[0]).toBeUndefined();
  });
});
