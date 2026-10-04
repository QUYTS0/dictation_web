/**
 * The Shadowing summary inside the shared round report (completion view,
 * /results, History): lazy loading, every coverage/evidence state, Retry,
 * refusal of another round's or revision's results, read-only previews, and
 * the same content as the practice page for the same saved round.
 * Component tests (jsdom), fetch mocked, no Azure.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RoundReportPanel } from "@/components/report/RoundReportPanel";
import { ShadowingSummaryView } from "@/components/report/ShadowingSummaryView";
import { buildShadowingRoundSummary } from "@/lib/practice/shadowingSummary";
import { fromRoundResults } from "@/lib/practice/shadowingSummaryInput";
import { mergeServerResults } from "@/app/dictation/[videoId]/shadowingServerMerge";
import { summaryInputFromEvaluations } from "@/app/dictation/[videoId]/videoPracticeSummary";
import type { ReportSentence, RoundReport } from "@/lib/types/learning";
import type { ShadowingAttemptDto, ShadowingRoundResults, ShadowingSegmentResults } from "@/lib/practice/shadowingTypes";

const TEXTS = ["The cat saw the dog.", "Think three times.", "Seven eight.", "Nine ten."];

function dto(seg: number, id: string, pron: number | null, words: unknown[] | null, wm: number | null = null): ShadowingAttemptDto {
  const at = `2026-09-01T10:0${seg}:00.000Z`;
  return {
    attemptId: id, clientAttemptId: `c-${id}`, roundId: "r1", youtubeVideoId: "vid", transcriptId: "tr-A", segmentIndex: seg, createdAt: at,
    recordingDurationSec: 2, isPracticeValid: true, validityBasis: "client_reported", studySessionId: "s1",
    azure: {
      status: pron === null ? "not_evaluated" : "completed", seq: 1, requestedAt: null, evaluatedAt: pron === null ? null : at,
      pronunciationScore: pron, accuracyScore: pron, fluencyScore: pron, completenessScore: pron, prosodyScore: null, errorReason: null,
      engineVersion: null, detail: pron === null ? null : { recognizedText: "x", words: (words ?? []) as never },
    },
    wordMatch: { status: wm === null ? null : "completed", seq: wm === null ? 0 : 1, accuracy: wm, completeness: wm, evaluatedAt: null, detail: null },
  };
}
function seg(d: ShadowingAttemptDto): ShadowingSegmentResults {
  const scored = d.azure.status === "completed";
  return {
    segmentIndex: d.segmentIndex, attemptCount: 1, latestAttempt: d, latestSuccessfulAzureAttempt: scored ? d : null,
    latestWordMatchAttempt: d.wordMatch.status === "completed" ? d : null,
    azureHistory: scored
      ? [{ attemptId: d.attemptId, createdAt: d.createdAt, evaluatedAt: d.azure.evaluatedAt, pronunciationScore: d.azure.pronunciationScore,
          accuracyScore: d.azure.accuracyScore, fluencyScore: null, completenessScore: null, prosodyScore: null,
          words: ((d.azure.detail?.words ?? []) as Array<{ word: string; accuracyScore: number | null; errorType: string }>).map(({ word, accuracyScore, errorType }) => ({ word, accuracyScore, errorType })) }]
      : [],
  };
}
const W = (word: string, accuracyScore: number | null, errorType = "None") => ({ word, accuracyScore, errorType });
const PARTIAL: ShadowingSegmentResults[] = [
  seg(dto(0, "a0", 80, [W("The", 95), W("cat", 92), W("saw", 92), W("the", 30, "Mispronunciation"), W("dog.", 92)])),
  seg(dto(1, "a1", 60, [W("Think", 40), W("three", 70), W("times.", 0, "Omission")], 70)),
  seg(dto(2, "a2", null, null, 50)),
];
const results = (segments: ShadowingSegmentResults[], over: Partial<ShadowingRoundResults> = {}): ShadowingRoundResults => ({
  roundId: "r1", youtubeVideoId: "vid", transcriptId: "tr-A", roundStatus: "completed", evaluationTimeoutSec: 120, segments, ...over,
});

const sentence = (i: number): ReportSentence => ({
  segmentIndex: i, text: TEXTS[i], eligible: true, category: "shadowing_only", dictation: null,
  shadowing: { takes: 1, validTakes: 1, latestAzure: null, latestWordMatch: null },
});
function report(over: { recorded?: number; scored?: number; takes?: number; required?: number | null } = {}): RoundReport {
  const required = over.required === undefined ? 6 : over.required;
  return {
    round: {
      roundId: "r1", videoId: "vid", title: "t", transcriptId: "tr-A", status: "completed", provenance: "current", roundNumber: 1,
      requiredSentenceCount: required, startedAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z",
      completedAt: "2026-09-01T00:00:00Z", completedAtApproximate: false, currentSegmentIndex: 0,
    },
    historyComplete: true,
    progress: {
      requiredSentenceCount: required, coveredSentences: { dictation: 6, shadowing: over.recorded ?? 3, overall: 6 },
      coverage: { dictation: 1, shadowing: 0.5, overall: 1 }, attemptCount: 6, sentenceAccuracy: { correct: 6, practiced: 6, percent: 100 },
    },
    dictation: {
      practicedSentences: 6, latestCorrect: 6, needsReview: 0, corrected: 0, submissions: 6, invalidSubmissions: 0, bestStreak: 6,
      firstTry: { available: true, correct: 6, correctWithHint: 0, correctHintUnknown: 0 }, accuracy: { correct: 6, practiced: 6, excludedUnverified: 0 },
    },
    shadowing: {
      takes: over.takes ?? 3, practicedSentences: over.recorded ?? 3, attemptedSentences: 3,
      azure: { evaluatedSentences: over.scored ?? 2, pronunciation: 72.5, accuracy: 72.5, completeness: 72.5, fluency: 70, prosody: null },
      wordMatch: { evaluatedSentences: 2, accuracy: 60, completeness: 60 },
    },
    activity: { activeSec: 40, trackedSince: null, sessionCount: 2, unattributedAnswers: 0, unattributedTakes: 0 },
    sentences: [0, 1, 2, 3].map(sentence),
  };
}

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
let calls: Array<{ url: string; method: string }>;
let serve: (url: string) => Response;
beforeEach(() => {
  calls = [];
  serve = () => json(results(PARTIAL));
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET" });
    return serve(url);
  }) as typeof fetch;
});
function renderPanel(props: Partial<React.ComponentProps<typeof RoundReportPanel>> = {}, r: RoundReport = report()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RoundReportPanel report={r} userId="user-1" {...props} />
    </QueryClientProvider>
  );
}
const attemptReads = () => calls.filter((c) => c.url.startsWith("/api/practice/attempts"));

describe("loading", () => {
  it("collapsed (History): nothing is downloaded until opened, then exactly this round", async () => {
    renderPanel({ shadowingFeedback: "collapsed" });
    const toggle = screen.getByRole("button", { name: /Shadowing summary · Round 1/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(attemptReads()).toEqual([]);
    fireEvent.click(toggle);
    expect(await screen.findByTestId("shadowing-summary")).toBeInTheDocument();
    expect(attemptReads().map((c) => c.url)).toEqual(["/api/practice/attempts?roundId=r1"]);
  });

  it("open (completion view, /results): loads at once; the SQL totals are visible meanwhile and stay on failure; Retry", async () => {
    // (5xx is retried twice with backoff before the error shows — same policy as the round report.)
    serve = () => json({ error: "gone" }, 404);
    renderPanel({ shadowingFeedback: "open" });
    expect(screen.getByTestId("report-shadowing-azure")).toHaveTextContent("2 of 6 sentences scored by Azure");
    expect(await screen.findByText(/Couldn.t load the Shadowing feedback/)).toBeInTheDocument();
    expect(screen.getByTestId("report-shadowing-azure")).toBeInTheDocument(); // the report is not hidden
    serve = () => json(results(PARTIAL));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByTestId("shadowing-summary")).toBeInTheDocument();
  });

  it("results of another round or script revision are refused, never shown against these sentences", async () => {
    serve = () => json(results(PARTIAL, { transcriptId: "tr-OTHER" }));
    renderPanel({ shadowingFeedback: "open" });
    expect(await screen.findByText(/don.t belong to this round.s script version/)).toBeInTheDocument();
    expect(screen.queryByTestId("shadowing-summary")).toBeNull();
  });

  it("no Shadowing practice: no Shadowing tiles or section (and nothing is fetched)", () => {
    const r = report();
    renderPanel({ shadowingFeedback: "open" }, { ...r, shadowing: { ...r.shadowing, takes: 0 } });
    expect(screen.queryByTestId("report-shadowing")).toBeNull();
    expect(screen.queryByTestId("report-shadowing-feedback")).toBeNull();
    expect(attemptReads()).toEqual([]);
  });
});

describe("states", () => {
  it("recordings but no Azure results: says so; no priorities; Word Match kept separate", async () => {
    serve = () => json(results([seg(dto(2, "a2", null, null, 50)), seg(dto(3, "a3", null, null, null))]));
    renderPanel({ shadowingFeedback: "open" }, report({ recorded: 2, scored: 0 }));
    expect(await screen.findByTestId("ss-state")).toHaveTextContent("No sentences have been scored by Azure yet.");
    expect(screen.queryByTestId("ss-priorities")).toBeNull();
    expect(screen.getByTestId("ss-word-match")).toHaveTextContent("not a pronunciation score");
  });

  it("partially evaluated: scoped statements, evidence-backed priorities, omissions as 'not recognized'", async () => {
    renderPanel({ shadowingFeedback: "open" });
    const view = await screen.findByTestId("shadowing-summary");
    expect(within(view).getByTestId("ss-state")).toHaveTextContent("Partial: 2 of 6 sentences scored by Azure.");
    expect(within(view).getByText(/Based only on the 2 sentences scored by Azure/)).toBeInTheDocument();
    const priorities = within(view).getAllByTestId("ss-priority");
    expect(priorities.map((p) => p.querySelector("span")?.textContent)).toEqual(["Think", "the"]); // one spelling kept; "The"/"the" share the key
    expect(priorities[1]).toHaveTextContent("Flagged in 1 of 2 occurrences across 1 of 1 sentence");
    fireEvent.click(within(view).getByText("More feedback"));
    expect(within(view).getByTestId("ss-not-recognized")).toHaveTextContent("times (1 sentence)");
  });

  it("all eligible sentences recorded but partly scored; all scored", async () => {
    const { unmount } = renderPanel({ shadowingFeedback: "open" }, report({ recorded: 6 }));
    expect(await screen.findByTestId("ss-state")).toHaveTextContent("All sentences are recorded in Shadowing — 2 of 6 sentences scored by Azure.");
    unmount();
    renderPanel({ shadowingFeedback: "open" }, report({ recorded: 2, required: 2 }));
    expect(await screen.findByTestId("ss-state")).toHaveTextContent("Every eligible sentence has an Azure score.");
  });

  it("missing word detail: an honest statement, never 'no issues'", async () => {
    serve = () => json(results([seg(dto(0, "a0", 70, [])), seg(dto(1, "a1", 50, null))]));
    renderPanel({ shadowingFeedback: "open" });
    expect(await screen.findByText(/Word-level feedback wasn.t saved for the 2 scored sentences/)).toBeInTheDocument();
    expect(screen.queryByText(/No words were flagged|No major/)).toBeNull();
  });
});

describe("sentences: read-only preview vs. practice navigation", () => {
  it("/results and History: a read-only preview of the saved feedback — no navigation, no writes", async () => {
    renderPanel({ shadowingFeedback: "open" });
    const view = await screen.findByTestId("shadowing-summary");
    fireEvent.click(within(view).getByText("More feedback"));
    expect(within(view).queryByRole("button", { name: "Review sentence" })).toBeNull();
    fireEvent.click(within(within(view).getByTestId("ss-sentences")).getAllByRole("button", { name: "Show feedback" })[0]);
    const preview = within(view).getByTestId("ss-sentence-preview-0");
    expect(preview).toHaveTextContent("The cat saw the dog.");
    expect(preview).toHaveTextContent("the 30 · mispronounced");
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(calls.every((c) => c.url.startsWith("/api/practice/attempts?roundId=r1"))).toBe(true);
  });

  it("completion view (the page's own round): examples and rows open the sentence through the page", async () => {
    const onReviewSentence = jest.fn();
    renderPanel({ shadowingFeedback: "open", onReviewSentence });
    const view = await screen.findByTestId("shadowing-summary");
    fireEvent.click(within(view).getAllByRole("button", { name: "sentence 2" })[0]);
    expect(onReviewSentence).toHaveBeenCalledWith(1);
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });
});

describe("same round → same summary in practice and in reports", () => {
  it("the practice page's adapter and the report's adapter render identical content", async () => {
    const r = results(PARTIAL);
    const counts = { eligibleSentences: 6, recordedSentences: 3 };
    const practice = buildShadowingRoundSummary(summaryInputFromEvaluations(mergeServerResults({}, r, (i) => TEXTS[i]), counts));
    const reportSide = buildShadowingRoundSummary(fromRoundResults(r, (i) => TEXTS[i], counts));
    const a = render(<ShadowingSummaryView summary={practice} />);
    const practiceText = a.container.textContent;
    a.unmount();
    const b = render(<ShadowingSummaryView summary={reportSide} />);
    expect(b.container.textContent).toBe(practiceText);
    await waitFor(() => expect(practiceText).toContain("Partial: 2 of 6 sentences scored by Azure."));
  });
});
