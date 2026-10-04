/**
 * Shadowing summary audit findings D1–D5 (.claude/shadowing-summary-audit.md)
 * — now asserting the CORRECTED behavior on the rendered surfaces: the
 * practice page's round panel and the shared round report. Component tests
 * (jsdom), no network, no Azure.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { buildShadowingRoundSummary, type SummarySentenceInput, type SummaryWordInput } from "@/lib/practice/shadowingSummary";
import { EvaluationSessionSummary } from "@/app/dictation/[videoId]/components/EvaluationSessionSummary";
import { RoundReportPanel } from "@/components/report/RoundReportPanel";
import { ShadowingSummaryView } from "@/components/report/ShadowingSummaryView";
import type { RoundReport } from "@/lib/types/learning";

const w = (word: string, accuracyScore: number | null, errorType = "None"): SummaryWordInput => ({ word, accuracyScore, errorType });

function scored(segmentIndex: number, referenceText: string, at: string, pron: number, words: SummaryWordInput[] | null): SummarySentenceInput {
  return {
    segmentIndex,
    referenceText,
    wordCount: referenceText.split(/\s+/).length,
    audioDurationSec: 2,
    representative: {
      attemptId: `a${segmentIndex}`,
      recordingCreatedAt: at,
      evaluatedAt: at,
      scores: { pronunciation: pron, accuracy: pron, fluency: pron, completeness: pron, prosody: pron },
      words,
    },
    history: [{ attemptId: `a${segmentIndex}`, recordingCreatedAt: at, evaluatedAt: at, pronunciationScore: pron, words }],
    wordMatch: null,
  };
}
const summaryOf = (sentences: SummarySentenceInput[], eligible: number | null = 10, recorded: number | null = sentences.length) =>
  buildShadowingRoundSummary({ eligibleSentences: eligible, recordedSentences: recorded, sentences });

function expand() {
  if (!screen.queryByText("Words to practice")) fireEvent.click(screen.getByRole("button", { name: /this round/i }));
}

beforeEach(() => localStorage.clear());

describe("D2 — repeated words keep every occurrence", () => {
  it("the weak 2nd 'the' is a word to practice, with occurrence and sentence counts kept apart", () => {
    const s = summaryOf([
      scored(0, "The cat saw the dog.", "2026-09-01T10:00:00Z", 80, [w("The", 95), w("cat", 92), w("saw", 92), w("the", 30, "Mispronunciation"), w("dog.", 92)]),
    ]);
    render(<EvaluationSessionSummary summary={s} onJumpToSegment={() => {}} />);
    expand();
    const row = screen.getByText("the").closest("li")!;
    expect(within(row).getByText("Flagged in 1 of 2 occurrences across 1 of 1 sentence")).toBeInTheDocument();
    expect(within(row).getByText(/Average 62\.5 over its scored occurrences/)).toBeInTheDocument();
    expect(within(row).getByText(/sentence 1/)).toBeInTheDocument();
    expect(s.wellPronounced.map((x) => x.word.toLowerCase())).not.toContain("the");
  });
});

describe("D3 — no improvement across different sentences", () => {
  it("weak in sentence 1 and fine in sentence 6 is a word to practice, never an improvement", () => {
    const s = summaryOf([
      scored(0, "Water is wet.", "2026-09-01T10:00:00Z", 60, [w("Water", 30, "Mispronunciation"), w("is", 90), w("wet.", 90)]),
      scored(5, "Drink the water.", "2026-09-01T10:10:00Z", 90, [w("Drink", 90), w("the", 90), w("water.", 92)]),
    ]);
    expect([s.wordImprovements, s.sentenceImprovements]).toEqual([[], []]);
    render(<EvaluationSessionSummary summary={s} onJumpToSegment={() => {}} />);
    expand();
    expect(screen.queryByText(/improvement/i)).toBeNull();
    expect(screen.getByText("water")).toBeInTheDocument(); // "Water" and "water." share one key
  });
});

describe("D4 — omissions are 'not recognized', never a pronunciation score", () => {
  it("an omission with a numeric 0 is not a word to practice; the report lists it with cautious wording", () => {
    const s = summaryOf([
      scored(0, "I saw the other cat.", "2026-09-01T10:00:00Z", 75, [w("I", 90), w("saw", 90), w("the", 90), w("other", 0, "Omission"), w("cat.", 90)]),
    ]);
    expect(s.priorities).toEqual([]);
    render(<ShadowingSummaryView summary={s} />);
    fireEvent.click(screen.getByText("More feedback"));
    const section = screen.getByTestId("ss-not-recognized");
    expect(within(section).getByText(/didn.t recognize these words in your recording/)).toBeInTheDocument();
    expect(within(section).getByText("other (1 sentence)")).toBeInTheDocument();
    expect(screen.queryByText(/Avg\. 0/)).toBeNull();
  });
});

describe("D5 — honest fallback without word detail", () => {
  it("no detail: no 'no issues' claim, scores still count", () => {
    const s = summaryOf([scored(0, "One two three.", "2026-09-01T10:00:00Z", 40, null), scored(1, "Four five.", "2026-09-01T10:01:00Z", 60, null)], 3);
    expect(s.metrics.pronunciation?.sentences).toBe(2);
    render(<EvaluationSessionSummary summary={s} onJumpToSegment={() => {}} />);
    expand();
    expect(screen.queryByText(/No major pronunciation issues/)).toBeNull();
    expect(screen.getByText(/Word-level feedback wasn.t saved for the 2 scored sentences/)).toBeInTheDocument();
  });

  it("partial detail: the statement and any 'nothing flagged' line are scoped to the sentences with detail", () => {
    const s = summaryOf([scored(0, "One two.", "2026-09-01T10:00:00Z", 90, [w("One", 95), w("two.", 95)]), scored(1, "Three four.", "2026-09-01T10:01:00Z", 40, null)], 3);
    render(<EvaluationSessionSummary summary={s} onJumpToSegment={() => {}} />);
    expand();
    expect(screen.getByText("Word-level feedback is available for 1 of 2 scored sentences.")).toBeInTheDocument();
    expect(screen.getByText(/No words were flagged in the 1 scored sentence with word-level feedback/)).toBeInTheDocument();
  });
});

describe("D1 — every round surface: scored out of ELIGIBLE sentences; recording coverage separate", () => {
  const report: RoundReport = {
    round: {
      roundId: "r", videoId: "v", title: "t", transcriptId: "tr", status: "completed", provenance: "current", roundNumber: 1,
      requiredSentenceCount: 6, startedAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z",
      completedAt: "2026-09-01T00:00:00Z", completedAtApproximate: false, currentSegmentIndex: 0,
    },
    historyComplete: true,
    progress: {
      requiredSentenceCount: 6, coveredSentences: { dictation: 6, shadowing: 5, overall: 6 },
      coverage: { dictation: 1, shadowing: 5 / 6, overall: 1 }, attemptCount: 14, sentenceAccuracy: { correct: 6, practiced: 6, percent: 100 },
    },
    dictation: {
      practicedSentences: 6, latestCorrect: 6, needsReview: 0, corrected: 0, submissions: 6, invalidSubmissions: 0, bestStreak: 6,
      firstTry: { available: true, correct: 6, correctWithHint: 0, correctHintUnknown: 0 }, accuracy: { correct: 6, practiced: 6, excludedUnverified: 0 },
    },
    shadowing: {
      takes: 9, practicedSentences: 5, attemptedSentences: 6,
      azure: { evaluatedSentences: 3, pronunciation: 78.6, accuracy: 78.6, completeness: 78.6, fluency: 74, prosody: 74 },
      wordMatch: { evaluatedSentences: 2, accuracy: 66.7, completeness: 66.7 },
    },
    activity: { activeSec: 40, trackedSince: "2026-09-01T00:00:00Z", sessionCount: 2, unattributedAnswers: 0, unattributedTakes: 0 },
    sentences: [],
  };

  it("round report (completion view, /results and History share it): 3 of 6 scored, 5/6 recorded, one-decimal average", () => {
    render(<RoundReportPanel report={report} />);
    expect(within(screen.getByTestId("report-shadowing-azure")).getByText("3 of 6 sentences scored by Azure")).toBeInTheDocument();
    expect(within(screen.getByTestId("report-shadowing-azure")).getByText("78.6")).toBeInTheDocument();
    expect(within(screen.getByTestId("report-shadowing-recorded")).getByText("5/6")).toBeInTheDocument();
    expect(within(screen.getByTestId("report-shadowing-recorded")).getByText(/9 recordings in total/)).toBeInTheDocument();
    expect(within(screen.getByTestId("report-shadowing-word-match")).getByText(/2 of 6 sentences/)).toBeInTheDocument();
    expect(screen.queryByText(/3\/5|3\/6 evaluated/)).toBeNull();
    expect(screen.getByText("Round complete")).toBeInTheDocument();
  });

  it("practice panel: 3/6 scored · 50%, and an unknown denominator shows a count only", () => {
    const three = [0, 1, 2].map((i) => scored(i, "One two.", `2026-09-01T10:0${i}:00Z`, 80, null));
    const { unmount } = render(<EvaluationSessionSummary summary={summaryOf(three, 6, 5)} onJumpToSegment={() => {}} />);
    expect(screen.getByText("3/6 scored · 50%")).toBeInTheDocument();
    unmount();
    render(<EvaluationSessionSummary summary={summaryOf(three, null, null)} onJumpToSegment={() => {}} />);
    expect(screen.getByText("3 scored")).toBeInTheDocument();
  });

  it("summary view: recorded vs scored statements; all recorded but partly scored stays partial", () => {
    const three = [0, 1, 2].map((i) => scored(i, "One two.", `2026-09-01T10:0${i}:00Z`, 80, null));
    const { unmount } = render(<ShadowingSummaryView summary={summaryOf(three, 6, 5)} />);
    expect(screen.getByText("5 of 6 sentences")).toBeInTheDocument();
    expect(screen.getByText("3 of 6 sentences")).toBeInTheDocument();
    expect(screen.getByTestId("ss-state")).toHaveTextContent("Partial: 3 of 6 sentences scored by Azure.");
    unmount();
    render(<ShadowingSummaryView summary={summaryOf(three, 6, 6)} />);
    expect(screen.getByTestId("ss-state")).toHaveTextContent("All sentences are recorded in Shadowing — 3 of 6 sentences scored by Azure.");
  });
});
