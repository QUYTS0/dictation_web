/**
 * Whole-round report UI (component tests, fetch mocked — not a real
 * browser). The metric formulas are the database's (fn_round_report, real
 * PostgreSQL in integration/phase6-library.integration.test.ts); these tests
 * pin down that BOTH surfaces — the practice page's results view and the
 * full report page — render exactly that one contract, never page-local
 * counters, and the report-view layout rules.
 */
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Suspense, useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";
import type { RoundReport, ReportSentence } from "@/lib/types/learning";
import type { SessionReportResponse } from "@/lib/types";
import { roundReportKeys } from "@/lib/queries/roundReport";

let authUser: User | null = { id: "user-1" } as User;
jest.mock("@/context/auth", () => ({
  useAuth: () => ({ user: authUser, loading: false, openAuthModal: jest.fn() }),
}));
jest.mock("next/link", () => {
  return function MockLink({ href, children, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; children: React.ReactNode }) {
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  };
});
/** next/navigation: push re-renders the results page for the new URL, as the App Router does. */
const mockNav: { go: ((url: string) => void) | null } = { go: null };
const mockPush = jest.fn((url: string) => mockNav.go?.(url));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn(), prefetch: jest.fn() }),
  useSearchParams: () => new URLSearchParams(window.location.search),
  usePathname: () => window.location.pathname,
}));
jest.mock("@/components/AppHeader", () => function AppHeader() {
  return null;
});
jest.mock("@/components/VocabularySaveButton", () => function VocabularySaveButton() {
  return null;
});

import { RoundReportPanel } from "@/components/report/RoundReportPanel";
import { PracticeReportView } from "@/app/dictation/[videoId]/components/PracticeReportView";
import { useReportViewLayout } from "@/app/dictation/[videoId]/useReportViewLayout";
import SessionResultsPage from "@/app/results/[sessionId]/page";

const sentence = (i: number, category: ReportSentence["category"], over: Partial<ReportSentence> = {}): ReportSentence => ({
  segmentIndex: i,
  text: `Sentence number ${i}`,
  eligible: true,
  category,
  dictation:
    category === "shadowing_only"
      ? null
      : {
          submissions: category === "corrected" ? 2 : 1,
          practiceSubmissions: category === "corrected" ? 2 : 1,
          first: { correct: category === "first_try", hintLevel: 0, userText: "first" },
          latest: { correct: category !== "needs_review", userText: category === "needs_review" ? "wrong words" : "right", errorType: null, attemptId: `a${i}`, createdAt: "2026-09-02T00:00:00Z" },
          everIncorrect: category !== "first_try",
        },
  shadowing: null,
  ...over,
});

function report(over: Partial<RoundReport> = {}): RoundReport {
  return {
    round: {
      roundId: "round-1",
      videoId: "vid",
      title: "The video",
      transcriptId: "tr",
      status: "completed",
      provenance: "current",
      roundNumber: 2,
      requiredSentenceCount: 110,
      startedAt: "2026-09-01T00:00:00Z",
      updatedAt: "2026-09-03T00:00:00Z",
      completedAt: "2026-09-03T00:00:00Z",
      completedAtApproximate: false,
      currentSegmentIndex: 0,
    },
    historyComplete: true,
    progress: {
      requiredSentenceCount: 110,
      coveredSentences: { dictation: 110, shadowing: 0, overall: 110 },
      coverage: { dictation: 1, shadowing: 0, overall: 1 },
      attemptCount: 155,
      sentenceAccuracy: { correct: 100, practiced: 110, percent: 91 },
    },
    dictation: {
      practicedSentences: 110,
      latestCorrect: 100,
      needsReview: 10,
      corrected: 30,
      submissions: 155,
      invalidSubmissions: 0,
      bestStreak: 41,
      firstTry: { available: true, correct: 70, correctWithHint: 5, correctHintUnknown: 0 },
      accuracy: { correct: 100, practiced: 110, excludedUnverified: 0 },
    },
    shadowing: {
      takes: 0,
      practicedSentences: 0,
      attemptedSentences: 0,
      azure: { evaluatedSentences: 0, pronunciation: null, accuracy: null, completeness: null, fluency: null, prosody: null },
      wordMatch: { evaluatedSentences: 0, accuracy: null, completeness: null },
    },
    activity: { activeSec: 5400, trackedSince: "2026-09-01T00:00:00Z", sessionCount: 3, unattributedAnswers: 0, unattributedTakes: 0 },
    sentences: [sentence(0, "first_try"), sentence(1, "corrected"), sentence(2, "needs_review"), sentence(3, "correct")],
    ...over,
  };
}

describe("RoundReportPanel — one contract, whole-round scope", () => {
  it("every figure is the round's (all sessions): coverage, accuracy, first try with hint note, answers, best run, active time", () => {
    render(<RoundReportPanel report={report()} />);
    expect(screen.getByTestId("report-coverage")).toHaveTextContent("110/110");
    expect(screen.getByTestId("report-accuracy")).toHaveTextContent("91%");
    expect(screen.getByTestId("report-accuracy")).toHaveTextContent("100/110 Dictation sentences correct on your latest answer");
    expect(screen.getByTestId("report-first-try")).toHaveTextContent("70/110");
    expect(screen.getByTestId("report-first-try")).toHaveTextContent("5 with a hint");
    expect(screen.getByTestId("report-submissions")).toHaveTextContent("155");
    expect(screen.getByTestId("report-best-streak")).toHaveTextContent("41 in a row");
    expect(screen.getByTestId("report-best-streak")).toHaveTextContent("not your daily streak");
    expect(screen.getByTestId("report-active-time")).toHaveTextContent("1h 30m");
    expect(screen.getByText(/3 study sessions/)).toBeInTheDocument();
  });

  it("'still needs review' and 'corrected' are separate, accurate lists; review selects that sentence", () => {
    const onReview = jest.fn();
    render(<RoundReportPanel report={report()} onReviewSentence={onReview} />);
    const needs = screen.getByText("Still needs review (1)").closest("section")!;
    expect(within(needs).getByText("Sentence number 2")).toBeInTheDocument();
    expect(within(needs).getByText(/Your latest answer: wrong words/)).toBeInTheDocument();
    expect(within(needs).queryByText("Sentence number 1")).toBeNull();
    const fixed = screen.getByText("Corrected after mistakes (1)").closest("section")!;
    expect(within(fixed).getByText("Sentence number 1")).toBeInTheDocument();
    fireEvent.click(within(needs).getByText("Review sentence 3"));
    expect(onReview).toHaveBeenCalledWith(2);
  });

  it("incomplete (legacy) history: no first-try tile or best run (a one-line note instead) — never guessed; neutral headline", () => {
    render(
      <RoundReportPanel
        report={report({
          historyComplete: false,
          round: { ...report().round, provenance: "legacy_unverified" },
          dictation: { ...report().dictation, bestStreak: null, firstTry: { available: false, correct: null, correctWithHint: null, correctHintUnknown: null } },
        })}
      />
    );
    expect(screen.queryByTestId("report-first-try")).toBeNull(); // no large "—" tile
    expect(screen.queryByTestId("report-best-streak")).toBeNull();
    expect(screen.getByTestId("report-history-note")).toHaveTextContent(
      "Part of this round was practised before detailed tracking. First-try and best-run statistics aren't available"
    );
    // The round's origin never turns into a claim about its completion.
    expect(screen.getByRole("heading", { name: "Round complete" })).toBeInTheDocument();
    expect(screen.queryByText(/earlier \(unverified\)/)).toBeNull();
  });

  it("mixed Dictation + Shadowing round: Dictation figures use Dictation-practiced sentences; Azure missing stays '—' (no Word Match fallback)", () => {
    render(
      <RoundReportPanel
        report={report({
          progress: { ...report().progress, requiredSentenceCount: 4, coveredSentences: { dictation: 2, shadowing: 2, overall: 4 } },
          dictation: { ...report().dictation, practicedSentences: 2, latestCorrect: 1, firstTry: { available: true, correct: 1, correctWithHint: 0, correctHintUnknown: 0 } },
          shadowing: {
            takes: 3,
            practicedSentences: 2,
            attemptedSentences: 2,
            azure: { evaluatedSentences: 0, pronunciation: null, accuracy: null, completeness: null, fluency: null, prosody: null },
            wordMatch: { evaluatedSentences: 2, accuracy: 88, completeness: 90 },
          },
        })}
      />
    );
    expect(screen.getByTestId("report-coverage")).toHaveTextContent("4/4");
    expect(screen.getByTestId("report-accuracy")).toHaveTextContent("50%");
    expect(screen.getByTestId("report-accuracy")).toHaveTextContent("1/2 Dictation sentences");
    expect(screen.getByTestId("report-first-try")).toHaveTextContent("1/2");
    const sh = screen.getByTestId("report-shadowing");
    expect(within(sh).getByText("Pronunciation (Azure)").parentElement).toHaveTextContent("—");
    expect(within(sh).getByText("Pronunciation (Azure)").parentElement).toHaveTextContent("No saved pronunciation scores");
    // One display rule for round averages (one decimal, like the server); out of the ELIGIBLE sentences.
    expect(within(sh).getByText("Word Match").parentElement).toHaveTextContent("88.0%");
    expect(within(sh).getByText("Word Match").parentElement).toHaveTextContent("2 of 4 sentences");
    expect(within(sh).getByText("Shadowing recordings").parentElement).toHaveTextContent("2/4");
  });
});

describe("RoundReportPanel — deterministic Dictation analysis (Learning Reports P1)", () => {
  const ev = (rows: Array<[string, number, string, boolean, string?]>): import("@/lib/practice/dictationAnalysis").DictationEvidence => {
    const { buildDictationEvidence } = jest.requireActual("@/lib/practice/dictationAnalysis") as typeof import("@/lib/practice/dictationAnalysis");
    return buildDictationEvidence(
      rows.map(([id, seg, text, correct, mode], i) => ({
        id, segment_index: seg, user_text: text, is_correct: correct, is_practice_valid: text !== "",
        match_mode: mode ?? "relaxed", created_at: `2026-09-02T00:00:${String(i).padStart(2, "0")}Z`,
      }))
    );
  };

  it("leads still-incorrect rows with 'You wrote → Reference', differences marked, without repeating the reference", () => {
    const r = report({ sentences: [sentence(2, "needs_review", { text: "It spans two weeks." })] });
    render(<RoundReportPanel report={r} dictationEvidence={ev([["x1", 2, "it span two weeks", false]])} />);
    const cmp = screen.getByTestId("answer-comparison");
    expect(cmp).toHaveTextContent("You wrote");
    expect(cmp).toHaveTextContent("Reference");
    expect(within(cmp).getByText("span")).toHaveAttribute("data-diff", "answer-changed");
    expect(within(cmp).getByText("spans")).toHaveAttribute("data-diff", "reference-changed");
    expect(cmp).toHaveTextContent("You wrote “span”; the reference has “spans”");
    // Shown once, in comparison form (the collapsed "All practiced sentences" list is separate).
    const section = screen.getByRole("heading", { name: /Still needs review/ }).closest("section")!;
    expect(within(section).queryByText("It spans two weeks.")).toBeNull();
  });

  it("nothing left to review, many corrected: a positive line, then 5 corrected rows and 'Show N more'", () => {
    const corrected = Array.from({ length: 8 }, (_, i) => sentence(i, "corrected"));
    render(<RoundReportPanel report={report({ sentences: corrected })} />);
    expect(screen.getByTestId("report-nothing-to-review")).toHaveTextContent("Nothing left to review");
    const list = document.getElementById("report-corrected-list")!;
    expect(within(list).getAllByRole("listitem")).toHaveLength(5);
    const more = screen.getByRole("button", { name: "Show 3 more" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(more);
    expect(within(list).getAllByRole("listitem")).toHaveLength(8);
  });

  it("a corrected row describes the past mistake, never as unresolved", () => {
    const r = report({ sentences: [sentence(1, "corrected", { text: "The cat sat." })] });
    render(<RoundReportPanel report={r} dictationEvidence={ev([["c1", 1, "the cat sit", false], ["c2", 1, "the cat sit", false], ["c3", 1, "the cat sat", true]])} />);
    expect(screen.getByTestId("answer-comparison")).toHaveTextContent("Corrected after 2 incorrect answers — your last mistake:");
    expect(screen.queryByText(/still incorrect/)).toBeNull();
  });

  it("review priorities: still incorrect first, then repeated differences; shown 3 at a time", () => {
    const r = report({
      sentences: [
        sentence(0, "needs_review", { text: "A dog sat." }),
        sentence(1, "needs_review", { text: "The cat sat down." }),
        sentence(2, "needs_review", { text: "We sat here." }),
        sentence(3, "needs_review", { text: "They ran." }),
      ],
    });
    render(
      <RoundReportPanel
        report={r}
        dictationEvidence={ev([["p0", 0, "a dog sit", false], ["p1", 1, "the cat sit down", false], ["p2", 2, "we sit here", false], ["p3", 3, "they run", false]])}
      />
    );
    const section = screen.getByTestId("report-priorities");
    expect(within(section).getAllByRole("listitem")).toHaveLength(3);
    expect(within(section).getAllByRole("listitem")[0]).toHaveTextContent("Sentence 1 is still incorrect");
    fireEvent.click(within(section).getByRole("button", { name: "Show all 5" }));
    expect(within(section).getAllByRole("listitem")[4]).toHaveTextContent("You wrote “sit” for “sat” in 3 sentences (1, 2, 3)");
  });

  it("a stored correct answer is never labelled 'Marked incorrect'; a stored incorrect one that the current rules can't explain is said so", () => {
    // Stored INCORRECT although equal under the current relaxed rules.
    const r = report({ sentences: [sentence(2, "needs_review", { text: "Hello there." })] });
    const { unmount } = render(<RoundReportPanel report={r} dictationEvidence={ev([["d1", 2, "hello there", false]])} />);
    expect(screen.getByTestId("answer-comparison")).toHaveTextContent("Marked incorrect when submitted");
    unmount();
    // The analysis of a stored CORRECT answer never says "Marked incorrect".
    const { analyzeAnswer } = jest.requireActual("@/lib/practice/dictationAnalysis") as typeof import("@/lib/practice/dictationAnalysis");
    expect(analyzeAnswer("Hello there.", { attemptId: "d2", userText: "hello world", matchMode: "relaxed", isCorrect: true, createdAt: "x" }).status).toBe(
      "accepted_as_correct"
    );
  });

  it("answers submitted names empty answers and labels the per-answer figure, never as accuracy", () => {
    const r = report({ dictation: { ...report().dictation, submissions: 4, invalidSubmissions: 1 }, sentences: [sentence(2, "needs_review")] });
    render(<RoundReportPanel report={r} dictationEvidence={ev([["s1", 2, "wrong", false], ["s2", 2, "", false], ["s3", 3, "right", true], ["s4", 3, "right", true]])} />);
    const tile = screen.getByTestId("report-submissions");
    expect(tile).toHaveTextContent("1 empty answer not counted");
    expect(tile).toHaveTextContent("correct across valid answers: 67%");
    expect(screen.getByTestId("report-accuracy")).toHaveTextContent("Correct on latest answer");
  });

  it("a synthesized completion date says so; an exact one doesn't", () => {
    const r = report({ round: { ...report().round, completedAtApproximate: true, provenance: "legacy_unverified" }, historyComplete: false });
    render(<RoundReportPanel report={r} />);
    expect(screen.getByText(/\(date estimated\)/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Round complete" })).toBeInTheDocument();
  });
});


const jsonRes = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
function reportResponse(r: RoundReport): SessionReportResponse {
  return {
    session: {
      id: r.round.roundId,
      videoId: r.round.videoId,
      videoTitle: r.round.title,
      status: r.round.status,
      accuracy: 0,
      totalAttempts: 0,
      currentSegmentIndex: 0,
      totalSegments: null,
      startedAt: r.round.startedAt,
      updatedAt: r.round.updatedAt,
      durationSec: 0,
      assessment: null,
      assessmentGeneratedAt: null,
    },
    errorBreakdown: [],
    mistakes: [],
    round: r,
  };
}

describe("PracticeReportView (practice page results)", () => {
  beforeEach(() => {
    authUser = { id: "user-1" } as User;
    global.fetch = jest.fn(async (input: RequestInfo | URL) =>
      String(input).includes("/report") ? jsonRes(reportResponse(report())) : jsonRes({})
    ) as typeof fetch;
  });

  it("loads the round's server report (not page counters) and offers the explicit next actions", async () => {
    const props = {
      onReviewSentence: jest.fn(),
      onSwitchMode: jest.fn(),
      onBackToPractice: jest.fn(),
      onOpenScript: jest.fn(),
      onPracticeAgain: jest.fn(),
      onContinueShadowing: jest.fn(),
    };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <PracticeReportView userId="user-1" roundId="round-1" videoTitle="The video" inputMode="dictation" {...props} />
      </QueryClientProvider>
    );
    await screen.findByTestId("round-report");
    expect(global.fetch).toHaveBeenCalledWith("/api/session/round-1/report");
    expect(qc.getQueryData(roundReportKeys.report("user-1", "round-1"))).toBeDefined();
    expect(screen.queryByText("Continue in Dictation")).toBeNull(); // current mode
    fireEvent.click(screen.getByText("Continue in Listening"));
    expect(props.onSwitchMode).toHaveBeenCalledWith("listening");
    fireEvent.click(screen.getByText("Practice again — new round"));
    expect(props.onPracticeAgain).toHaveBeenCalled();
    // Shadowing's next step is the same-round continuation, not a plain mode switch.
    expect(screen.queryByText("Continue in Shadowing")).toBeNull();
    fireEvent.click(screen.getByTestId("round-action-continue_shadowing"));
    expect(props.onContinueShadowing).toHaveBeenCalledWith("unrecorded");
    fireEvent.click(screen.getByText("Open script"));
    expect(props.onOpenScript).toHaveBeenCalled();
    expect(screen.getByText("Full report").closest("a")).toHaveAttribute("href", "/results/round-1");
    expect(screen.getByText("Library").closest("a")).toHaveAttribute("href", "/dashboard");
  });

  it("a guest (no round) sees the local fallback — never a fabricated server report", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <PracticeReportView
          userId={undefined}
          roundId={null}
          videoTitle="V"
          inputMode="dictation"
          onReviewSentence={jest.fn()}
          onSwitchMode={jest.fn()}
          onBackToPractice={jest.fn()}
          onOpenScript={jest.fn()}
          onPracticeAgain={jest.fn()}
          onContinueShadowing={jest.fn()}
          guestFallback={<p>guest summary</p>}
        />
      </QueryClientProvider>
    );
    expect(screen.getByText("guest summary")).toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("report view layout (useReportViewLayout)", () => {
  function usePanel(initial: boolean) {
    const [showPanel, setShowPanel] = useState(initial);
    const layout = useReportViewLayout({ showPanel, setShowPanel });
    return { showPanel, ...layout };
  }

  it("entering collapses the panel; Open script shows it; leaving restores the user's previous layout", () => {
    const { result } = renderHook(() => usePanel(true));
    act(() => result.current.openReport());
    expect(result.current).toMatchObject({ reportOpen: true, showPanel: false });
    act(() => result.current.openScript());
    expect(result.current).toMatchObject({ reportOpen: true, showPanel: true });
    act(() => result.current.closeReport());
    expect(result.current).toMatchObject({ reportOpen: false, showPanel: true });
  });

  it("a panel the user had closed stays closed after the report (their choice is not overwritten)", () => {
    const { result } = renderHook(() => usePanel(false));
    act(() => result.current.openReport());
    act(() => result.current.openScript()); // peeked at the script
    act(() => result.current.closeReport());
    expect(result.current.showPanel).toBe(false);
    act(() => result.current.openReport());
    act(() => result.current.openReport()); // idempotent
    act(() => result.current.closeReport());
    expect(result.current).toMatchObject({ reportOpen: false, showPanel: false });
  });
});

describe("full report page (/results/[roundId])", () => {
  it("renders the same shared report for an explicit round id; another account's cached report is never shown", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(roundReportKeys.report("user-1", "round-1"), reportResponse(report()));
    authUser = { id: "user-2" } as User;
    let answer!: (r: Response) => void;
    global.fetch = jest.fn((input: RequestInfo | URL) =>
      String(input).includes("/report") ? new Promise<Response>((r) => (answer = r)) : Promise.resolve(jsonRes({}))
    ) as typeof fetch;
    const params = Promise.resolve({ sessionId: "round-1" });
    await act(async () => {
      render(
        <QueryClientProvider client={qc}>
          <Suspense fallback={null}>
            <SessionResultsPage params={params} />
          </Suspense>
        </QueryClientProvider>
      );
      await params;
    });
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith("/api/session/round-1/report"));
    expect(screen.queryByTestId("round-report")).toBeNull(); // user-1's cache is not user-2's report
    await act(async () => answer(jsonRes({ error: "Session not found" }, 404)));
    await screen.findByText(/Failed to load this round/);
  });
});

describe("Learning Reports P3 — one report shell, separate mode sections", () => {
  afterEach(() => {
    authUser = { id: "user-1" } as User;
    window.history.replaceState(null, "", "/");
  });

  it("a summary first (accomplishment, key figures, next steps), then Dictation / Shadowing / Listening tabs", () => {
    const sentences = Array.from({ length: 3 }, (_, i) => sentence(i, "corrected"));
    const r = report({ dictation: { ...report().dictation, practicedSentences: 59, latestCorrect: 59, corrected: 23, needsReview: 0 }, sentences });
    render(<RoundReportPanel report={r} transcriptVersion={3} />);
    expect(screen.getByTestId("report-accomplishment")).toHaveTextContent(
      "You completed 110 sentences. All 59 Dictation sentences are correct on your latest answer; 23 were corrected after earlier mistakes."
    );
    expect(screen.getByTestId("report-identity")).toHaveTextContent("Round 2 · script version 3");
    const tabs = screen.getAllByRole("tab").map((t) => t.textContent);
    expect(tabs).toEqual(["Dictation", "Shadowing", "Listening"]);
    expect(screen.getByRole("tab", { name: "Dictation" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "Dictation" })).toBeVisible();
  });

  it("tabs are keyboard operable and switch panels without leaving the page", () => {
    render(<RoundReportPanel report={report()} />);
    const dictationTab = screen.getByRole("tab", { name: "Dictation" });
    dictationTab.focus();
    fireEvent.keyDown(dictationTab, { key: "ArrowRight" });
    const shadowingTab = screen.getByRole("tab", { name: "Shadowing" });
    expect(shadowingTab).toHaveAttribute("aria-selected", "true");
    expect(shadowingTab).toHaveFocus();
    expect(screen.getByRole("tabpanel", { name: "Shadowing" })).toHaveTextContent("No Shadowing recordings in this round yet.");
    fireEvent.keyDown(shadowingTab, { key: "End" });
    expect(screen.getByRole("tab", { name: "Listening" })).toHaveAttribute("aria-selected", "true");
  });

  it("Listening is labelled by its real scope: the script version (all sittings), plus this round's own sittings", () => {
    render(
      <RoundReportPanel
        report={report()}
        transcriptVersion={3}
        defaultSection="listening"
        listening={{ coverageRatio: 0.92, listenedThrough: true, lastPositionSec: 75, roundSittingsNewlyCoveredSec: 30, roundSittingsObservedSec: 95 }}
      />
    );
    const section = screen.getByTestId("report-listening");
    expect(section).toHaveTextContent("Listening — script version 3 (all sittings)");
    expect(screen.getByTestId("report-listening-coverage")).toHaveTextContent("92%");
    expect(screen.getByTestId("report-listening-coverage")).toHaveTextContent("listened through");
    expect(screen.getByTestId("report-listening-round")).toHaveTextContent("In this round's sittings");
    expect(section).toHaveTextContent("Coverage measures playback of the video, not attention");
  });

  it("no Listening data: an honest empty state, never 0%", () => {
    render(<RoundReportPanel report={report()} defaultSection="listening" />);
    expect(screen.getByTestId("report-listening-empty")).toHaveTextContent("No Listening recorded for this script version yet.");
  });

  it("the practice view opens on the mode the learner was practising; the Shadowing summary action switches tabs", async () => {
    const r = report({ shadowing: { ...report().shadowing, takes: 3 }, progress: { ...report().progress, coveredSentences: { dictation: 110, shadowing: 110, overall: 110 } } });
    global.fetch = jest.fn(async () => jsonRes(reportResponse(r))) as typeof fetch;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <PracticeReportView
          userId="user-1"
          roundId="round-1"
          videoTitle="V"
          inputMode="shadowing"
          onReviewSentence={jest.fn()}
          onSwitchMode={jest.fn()}
          onBackToPractice={jest.fn()}
          onOpenScript={jest.fn()}
          onPracticeAgain={jest.fn()}
          onContinueShadowing={jest.fn()}
        />
      </QueryClientProvider>
    );
    await screen.findByTestId("round-report");
    expect(screen.getByRole("tab", { name: "Shadowing" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("tab", { name: "Dictation" }));
    fireEvent.click(screen.getByTestId("round-action-view_shadowing_summary"));
    expect(screen.getByRole("tab", { name: "Shadowing" })).toHaveAttribute("aria-selected", "true");
  });

  it("/results honours ?section= and keeps the chosen tab in the URL without navigating", async () => {
    window.history.replaceState(null, "", "/results/round-1?section=listening");
    global.fetch = jest.fn(async (input: RequestInfo | URL) =>
      String(input).includes("/report") ? jsonRes(reportResponse(report())) : jsonRes([])
    ) as typeof fetch;
    const params = Promise.resolve({ sessionId: "round-1" });
    await act(async () => {
      render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <Suspense fallback={null}>
            <SessionResultsPage params={params} />
          </Suspense>
        </QueryClientProvider>
      );
      await params;
    });
    await screen.findByTestId("round-report");
    expect(screen.getByRole("tab", { name: "Listening" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("tab", { name: "Shadowing" }));
    expect(window.location.search).toBe("?section=shadowing");
    expect(window.location.pathname).toBe("/results/round-1");
  });
});


describe("an earlier round's full report after a newer round started", () => {
  afterEach(() => window.history.replaceState(null, "", "/"));

  it("/results/<round 1> shows round 1 itself — no redirect, no continuation, an explicit link to the current round, reads only", async () => {
    window.history.replaceState(null, "", "/results/round-1");
    const fetchMock = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>(async (input) =>
      String(input).includes("/report")
        ? jsonRes({ ...reportResponse(report()), newerActiveRound: { roundId: "round-9", roundNumber: 3 } })
        : jsonRes([])
    );
    global.fetch = fetchMock as typeof fetch;
    const params = Promise.resolve({ sessionId: "round-1" });
    await act(async () => {
      render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <Suspense fallback={null}>
            <SessionResultsPage params={params} />
          </Suspense>
        </QueryClientProvider>
      );
      await params;
    });
    const panel = await screen.findByTestId("round-report");
    expect(panel).toHaveTextContent("Round complete");
    expect(screen.getByTestId("report-identity")).toHaveTextContent("Round 2"); // its own round number, not the newer Round 3
    expect(screen.getByRole("link", { name: "Go to current round (Round 3)" })).toHaveAttribute("href", "/dictation/vid");
    expect(screen.queryByTestId("round-action-continue_shadowing")).toBeNull();
    expect(screen.queryByTestId("round-action-practice_again_new_round")).toBeNull();
    expect(window.location.pathname).toBe("/results/round-1");
    const urls = fetchMock.mock.calls.map(([u, init]) => [String(u), (init as RequestInit | undefined)?.method ?? "GET"]);
    expect(urls.filter(([u]) => u.includes("/report"))).toEqual([["/api/session/round-1/report", "GET"]]);
    expect(urls.filter(([, m]) => m !== "GET")).toEqual([]);
  });
});

// ---------------------------------------------------------------- report page round navigation

describe("report page: round count and selector", () => {
  const ROUNDS = [
    { roundId: "r3", roundNumber: 3, status: "abandoned", provenance: "current", startedAt: "2026-09-20T00:00:00Z", transcriptId: "tr-B" },
    { roundId: "r2", roundNumber: 2, status: "active", provenance: "current", startedAt: "2026-09-25T00:00:00Z", transcriptId: "tr-B" },
    { roundId: "r1", roundNumber: 1, status: "completed", provenance: "current", startedAt: "2026-09-01T00:00:00Z", transcriptId: "tr-A" },
  ] as const;
  const roundReport = (id: "r1" | "r2" | "r3") => {
    const meta = ROUNDS.find((r) => r.roundId === id)!;
    const correct = id === "r1" ? 100 : id === "r2" ? 3 : 50;
    return report({
      round: { ...report().round, roundId: id, roundNumber: meta.roundNumber, status: meta.status, startedAt: meta.startedAt, transcriptId: meta.transcriptId, completedAt: meta.status === "completed" ? "2026-09-03T00:00:00Z" : null },
      progress: { ...report().progress, sentenceAccuracy: { correct, practiced: 110, percent: Math.round((100 * correct) / 110) } },
      dictation: { ...report().dictation, latestCorrect: correct, accuracy: { correct, practiced: 110, excludedUnverified: 0 } },
      sentences: [sentence(0, "needs_review", { text: `Script ${meta.transcriptId} sentence` })],
    });
  };
  let calls: Array<{ url: string; method: string }>;
  let listPages: Record<number, unknown>;
  let delayed: Record<string, (() => void) | undefined>;
  let listFails: boolean;

  beforeEach(() => {
    authUser = { id: "user-1" } as User;
    calls = [];
    delayed = {};
    listFails = false;
    mockPush.mockClear();
    listPages = { 0: { videoId: "vid", total: 3, offset: 0, items: [ROUNDS[1], ROUNDS[0], ROUNDS[2]].sort((a, b) => b.startedAt.localeCompare(a.startedAt)), hasMore: false } };
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET" });
      const m = url.match(/^\/api\/session\/(r\d)\/report$/);
      if (m) {
        const answer = () => jsonRes({ ...reportResponse(roundReport(m[1] as "r1")), newerActiveRound: m[1] === "r2" ? null : { roundId: "r2", roundNumber: 2 }, transcriptVersion: m[1] === "r1" ? 1 : 2 });
        if (delayed[m[1]] === undefined && m[1] in delayed) return new Promise<Response>((resolve) => (delayed[m[1]] = () => resolve(answer())));
        return Promise.resolve(answer());
      }
      const list = url.match(/^\/api\/history\/videos\/vid\/round-list\?offset=(\d+)&limit=50$/);
      if (list) return Promise.resolve(listFails ? jsonRes({ error: "x" }, 500) : jsonRes(listPages[Number(list[1])]));
      return Promise.resolve(jsonRes([]));
    }) as typeof fetch;
  });
  afterEach(() => {
    mockNav.go = null;
    window.history.replaceState(null, "", "/");
  });

  function ResultsAt() {
    const sessionFrom = (url: string) => url.split("?")[0].split("/")[2];
    const [params, setParams] = useState(() => Promise.resolve({ sessionId: sessionFrom(window.location.pathname) }));
    useEffect(() => {
      mockNav.go = (url: string) => {
        window.history.pushState(null, "", url);
        setParams(Promise.resolve({ sessionId: sessionFrom(url) }));
      };
    });
    return (
      <Suspense fallback={<p>loading page</p>}>
        <SessionResultsPage params={params} />
      </Suspense>
    );
  }
  const open = async (url: string, qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })) => {
    window.history.replaceState(null, "", url);
    await act(async () => {
      render(
        <QueryClientProvider client={qc}>
          <ResultsAt />
        </QueryClientProvider>
      );
    });
    return qc;
  };
  const selector = () => screen.getByRole("combobox", { name: "Viewing round" }) as HTMLSelectElement;

  it("3, 4: opening round 1 while round 2 is active: '3 rounds', round 1 selected and readable, options newest first with status and start date", async () => {
    await open("/results/r1");
    await screen.findByTestId("round-report");
    expect(await screen.findByTestId("round-count")).toHaveTextContent("3 rounds");
    await waitFor(() => expect(selector().value).toBe("r1"));
    const options = within(selector()).getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual([
      `Round 2 · In progress · started ${new Date("2026-09-25T00:00:00Z").toLocaleDateString()}`,
      `Round 3 · Ended · started ${new Date("2026-09-20T00:00:00Z").toLocaleDateString()}`,
      `Round 1 · Completed · started ${new Date("2026-09-01T00:00:00Z").toLocaleDateString()}`,
    ]);
    expect(screen.getByTestId("report-identity")).toHaveTextContent("Round 1 · script version 1");
    expect(screen.getAllByText("Script tr-A sentence").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "Go to current round (Round 2)" })).toBeInTheDocument();
    // Only this account's list of THIS video is asked for.
    expect(calls.filter((c) => c.url.includes("round-list")).map((c) => c.url)).toEqual(["/api/history/videos/vid/round-list?offset=0&limit=50"]);
  });

  it("5, 7, 9: switching navigates to the canonical URL with the same section, shows the new round's own metrics and script, and only reads", async () => {
    await open("/results/r1?section=shadowing");
    await screen.findByTestId("round-report");
    expect(screen.getByRole("tab", { name: "Shadowing" })).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(selector().value).toBe("r1"));
    await act(async () => {
      fireEvent.change(selector(), { target: { value: "r2" } });
    });
    expect(mockPush).toHaveBeenCalledWith("/results/r2?section=shadowing");
    expect(window.location.pathname + window.location.search).toBe("/results/r2?section=shadowing");
    await waitFor(() => expect(screen.getByTestId("report-identity")).toHaveTextContent("Round 2 · script version 2"));
    expect(selector().value).toBe("r2");
    expect(screen.getByRole("tab", { name: "Shadowing" })).toHaveAttribute("aria-selected", "true"); // same mode to compare
    fireEvent.click(screen.getByRole("tab", { name: "Dictation" }));
    expect(screen.getByTestId("report-accuracy")).toHaveTextContent("3/110");
    expect(screen.getAllByText("Script tr-B sentence").length).toBeGreaterThan(0);
    expect(screen.queryAllByText("Script tr-A sentence")).toEqual([]);
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(calls.some((c) => /restart|save-progress|attempt|evaluate|explain|\/mode/.test(c.url))).toBe(false);
  });

  it("6: reload and Back/Forward show the round in the URL", async () => {
    const qc = await open("/results/r1");
    await screen.findByTestId("round-report");
    await waitFor(() => expect(within(selector()).getAllByRole("option")).toHaveLength(3));
    await act(async () => {
      fireEvent.change(selector(), { target: { value: "r3" } });
    });
    expect(window.location.pathname).toBe("/results/r3");
    await waitFor(() => expect(screen.getByTestId("report-identity")).toHaveTextContent("Round 3"));
    // Back: the page is rendered for /results/r1 again.
    await act(async () => mockNav.go!("/results/r1"));
    await waitFor(() => expect(screen.getByTestId("report-identity")).toHaveTextContent("Round 1"));
    expect(selector().value).toBe("r1");
    // Forward again, then a reload of /results/r3 (a new page, empty cache).
    await act(async () => mockNav.go!("/results/r3"));
    await waitFor(() => expect(screen.getByTestId("report-identity")).toHaveTextContent("Round 3"));
    void qc;
    cleanup();
    await open("/results/r3");
    await waitFor(() => expect(screen.getByTestId("report-identity")).toHaveTextContent("Round 3"));
    await waitFor(() => expect(selector().value).toBe("r3"));
  });

  it("8: while the next round loads its heading is shown, never the previous round's metrics; a late answer for the old round is ignored", async () => {
    await open("/results/r1");
    await screen.findByTestId("round-report");
    await waitFor(() => expect(selector().value).toBe("r1"));
    delayed = { r2: undefined };
    await act(async () => {
      fireEvent.change(selector(), { target: { value: "r2" } });
    });
    expect(screen.queryByTestId("round-report")).toBeNull(); // round 1's metrics are gone
    expect(screen.getByText("Loading Round 2's report…")).toBeInTheDocument();
    expect(screen.getByTestId("results-round-line")).toHaveTextContent("Round 2 · In progress");
    expect(selector().value).toBe("r2");
    // Back to round 1 (cached) before round 2 answers; then round 2's answer lands.
    await act(async () => mockNav.go!("/results/r1"));
    await waitFor(() => expect(screen.getByTestId("report-identity")).toHaveTextContent("Round 1"));
    await act(async () => delayed.r2?.());
    expect(screen.getByTestId("report-identity")).toHaveTextContent("Round 1");
    expect(screen.getAllByText("Script tr-A sentence").length).toBeGreaterThan(0);
  });

  it("10: one round shows '1 round' with a disabled selector; a failed list says so with Retry and the report still shows", async () => {
    listPages = { 0: { videoId: "vid", total: 1, offset: 0, items: [ROUNDS[2]], hasMore: false } };
    await open("/results/r1");
    await screen.findByTestId("round-report");
    expect(await screen.findByTestId("round-count")).toHaveTextContent(/^1 round$/);
    expect(selector()).toBeDisabled();
    expect(selector().selectedOptions[0].textContent).toMatch(/^Round 1 · Completed/);
    cleanup();
    listFails = true;
    await open("/results/r1");
    const alert = await screen.findByText(/Couldn't load this video's rounds/);
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.getAllByTestId("round-report").length).toBeGreaterThan(0);
  });

  it("10: more than one page of rounds — the exact total, the opened older round kept selected, older rounds loaded on request", async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      roundId: `x${i}`,
      roundNumber: 120 - i,
      status: "completed" as const,
      provenance: "current" as const,
      startedAt: new Date(Date.UTC(2026, 8, 30) - i * 3600_000).toISOString(),
      transcriptId: "tr-B",
    }));
    listPages = {
      0: { videoId: "vid", total: 120, offset: 0, items: many, hasMore: true },
      50: { videoId: "vid", total: 120, offset: 50, items: [ROUNDS[2]], hasMore: true },
    };
    await open("/results/r1");
    await screen.findByTestId("round-report");
    expect(await screen.findByTestId("round-count")).toHaveTextContent("120 rounds");
    await waitFor(() => expect(selector().value).toBe("r1")); // not on the first page, still selected
    expect(selector().selectedOptions[0].textContent).toMatch(/^Round 1 · Completed · started /); // and named, not a placeholder
    expect(within(selector()).getAllByRole("option")).toHaveLength(51);
    fireEvent.click(screen.getByRole("button", { name: "Show older rounds (70 more)" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("round-list?offset=50&limit=50"))).toBe(true));
    await waitFor(() => expect(within(selector()).getAllByRole("option")).toHaveLength(51)); // r1 now from the list, not duplicated
    expect(selector().value).toBe("r1");
  });
});

