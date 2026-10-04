/**
 * Whole-round report UI (component tests, fetch mocked — not a real
 * browser). The metric formulas are the database's (fn_round_report, real
 * PostgreSQL in integration/phase6-library.integration.test.ts); these tests
 * pin down that BOTH surfaces — the practice page's results view and the
 * full report page — render exactly that one contract, never page-local
 * counters, and the report-view layout rules.
 */
import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Suspense, useState } from "react";
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

  it("incomplete (legacy) history: first try is 'Not enough historical data', no best run — never guessed", () => {
    render(
      <RoundReportPanel
        report={report({
          historyComplete: false,
          round: { ...report().round, provenance: "legacy_unverified" },
          dictation: { ...report().dictation, bestStreak: null, firstTry: { available: false, correct: null, correctWithHint: null, correctHintUnknown: null } },
        })}
      />
    );
    expect(screen.getByTestId("report-first-try")).toHaveTextContent("Not enough historical data");
    expect(screen.queryByTestId("report-best-streak")).toBeNull();
    expect(screen.getByText(/can't be proven/)).toBeInTheDocument();
    expect(screen.getByText("Completed earlier (unverified)")).toBeInTheDocument();
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
    fireEvent.click(screen.getByText("Practice again (new round)"));
    expect(props.onPracticeAgain).toHaveBeenCalled();
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
