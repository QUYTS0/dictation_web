/**
 * Learning Reports P4 — the full report page (/results/<roundId>) with saved
 * explanations: labels for pattern reuse / earlier explanations, unsaved
 * output flagged as such, a confirmed save refreshes the report, and nothing
 * fetched for one account is ever shown to the next. fetch is mocked; no
 * provider call exists in this test.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let currentUser: { id: string } | null = { id: "user-A" };
jest.mock("@/context/auth", () => ({
  useAuth: () => ({ user: currentUser, loading: false, openAuthModal: jest.fn() }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("next/link", () => ({ __esModule: true, default: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
jest.mock("@/components/AppHeader", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/VocabularySaveButton", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/report/RoundActions", () => ({ RoundActions: () => null }));
jest.mock("@/components/report/RoundSelector", () => ({ RoundSelector: () => null, roundOptionLabel: () => "" }));
// The deterministic panel is covered elsewhere; here it only hosts each sentence's extra (the AI card).
jest.mock("@/components/report/RoundReportPanel", () => ({
  parseReportSection: () => null,
  RoundReportPanel: ({ renderSentenceExtra }: { renderSentenceExtra: (s: { segmentIndex: number; text: string }) => React.ReactNode }) => (
    <div>
      {[0, 1, 2].map((i) => (
        <div key={i} data-testid={`sentence-${i}`}>
          {renderSentenceExtra({ segmentIndex: i, text: `Sentence ${i}` })}
        </div>
      ))}
    </div>
  ),
}));

import SessionResultsPage from "@/app/results/[sessionId]/page";

const ROUND = "round-1";
const mistake = (seg: number, attemptId: string, aiFeedback: unknown) => ({
  segmentIndex: seg,
  expectedText: "Ref.",
  userText: "ref",
  errorType: null,
  attempts: 1,
  attemptId,
  aiFeedback,
});
function report(mistakes: unknown[]) {
  return {
    session: {
      id: ROUND, videoId: "vid", videoTitle: "Video", status: "completed", accuracy: 50, totalAttempts: 3,
      currentSegmentIndex: 0, totalSegments: 3, startedAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-02T00:00:00Z",
      durationSec: 60, assessment: null, assessmentGeneratedAt: null,
    },
    errorBreakdown: [],
    mistakes,
    round: { round: { roundId: ROUND, roundNumber: 1, status: "completed", provenance: "current", startedAt: "2026-09-01T00:00:00Z", transcriptId: "tr" } },
  };
}

let reportQueue: unknown[] = [];
let reportCalls: string[] = [];
let explainAllResponse: unknown = null;
const fetchMock = jest.fn(async (url: string) => {
  const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
  if (url.endsWith(`/api/session/${ROUND}/report`)) {
    reportCalls.push(currentUser?.id ?? "none");
    return json(reportQueue.length > 1 ? reportQueue.shift() : reportQueue[0]);
  }
  if (url.includes("/explain-all")) return json(explainAllResponse);
  if (url.startsWith("/api/ai/quota")) return json({ configured: false, rpdUsed: 0, rpdLimit: 20 });
  if (url.startsWith("/api/vocabulary")) return json({ items: [] });
  throw new Error(`unexpected fetch ${url}`);
});

function resolvedParams() {
  const p = Promise.resolve({ sessionId: ROUND }) as Promise<{ sessionId: string }> & { status?: string; value?: unknown };
  p.status = "fulfilled";
  p.value = { sessionId: ROUND };
  return p;
}
function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const params = resolvedParams();
  const ui = () => (
    <QueryClientProvider client={client}>
      <SessionResultsPage params={params} />
    </QueryClientProvider>
  );
  const r = render(ui());
  return { ...r, rerenderPage: () => r.rerender(ui()) };
}

beforeEach(() => {
  currentUser = { id: "user-A" };
  reportQueue = [];
  reportCalls = [];
  explainAllResponse = null;
  fetchMock.mockClear();
  (global as unknown as { fetch: unknown }).fetch = fetchMock;
});

it("shows saved notes with their relation to the answer (own, same mistake, earlier explanation, corrected)", async () => {
  reportQueue = [
    report([
      mistake(0, "a0", { explanation: "Own legacy note.", correctedText: "Ref.", example: "", via: "attempt", historical: true, legacy: true }),
      mistake(1, "a1", { explanation: "Shared note.", correctedText: "Ref.", example: "", via: "pattern", viaSegmentIndex: 0, historical: false, legacy: false }),
    ]),
  ];
  renderPage();
  expect(await screen.findByText("Own legacy note.")).toBeInTheDocument();
  expect(screen.getByText("· earlier explanation")).toBeInTheDocument();
  expect(screen.getByText("Earlier mistake (now corrected or answered again)")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Same mistake as sentence 1" })).toBeInTheDocument();
  expect(screen.getByText("Shared note.")).toBeInTheDocument();
});

// The unsaved-output, refresh-after-save and account-switch cases now drive
// the P5 actions (POST /assessment, /explanations, /assessment/recover) and
// live in p5-results-assessment.test.tsx.
