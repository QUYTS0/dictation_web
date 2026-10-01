/**
 * History (component test, fetch mocked — not a real browser): one entry per
 * study session, with estimated active time and the bookkeeping span as two
 * separately labeled numbers, Listening shown as MEDIA time, unattributed
 * practice labeled instead of grouped into invented sessions, round report
 * links by explicit round id — and the existing Mistakes view kept.
 */
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { User } from "@supabase/supabase-js";
import type { HistorySession, HistorySessionsPage } from "@/lib/types/learning";

jest.mock("@/context/auth", () => ({
  useAuth: () => ({ user: { id: "user-1" } as User, loading: false, openAuthModal: jest.fn() }),
}));
jest.mock("next/navigation", () => ({
  usePathname: () => "/history",
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
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

import HistoryPage from "@/app/history/page";

const session = (over: Partial<HistorySession>): HistorySession => ({
  studySessionId: "s1",
  videoId: "vid",
  title: "The video",
  roundId: "round-9",
  roundNumber: 2,
  roundStatus: "active",
  roundProvenance: "current",
  startedAt: "2026-09-30T08:00:00Z",
  lastActivityAt: "2026-09-30T08:25:00Z",
  endedAt: null,
  modesUsed: ["dictation", "shadowing"],
  elapsedSpanSec: 1500,
  activeSec: 1320,
  listeningObservedSec: 0,
  listeningNewlyCoveredSec: 0,
  dictationSentences: 8,
  shadowingSentences: 5,
  overlapSentences: 3,
  uniqueSentences: 10,
  newlyCoveredInRound: 6,
  dictationLatest: { correct: 6, practiced: 8 },
  ...over,
});

const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
let sessionsPage: HistorySessionsPage;

beforeEach(() => {
  window.sessionStorage.clear();
  sessionsPage = {
    items: [
      session({}),
      session({
        studySessionId: "s2",
        roundId: null,
        roundNumber: null,
        roundStatus: null,
        modesUsed: ["listening"],
        dictationSentences: 0,
        shadowingSentences: 0,
        overlapSentences: 0,
        uniqueSentences: 0,
        newlyCoveredInRound: 0,
        listeningObservedSec: 240,
        listeningNewlyCoveredSec: 95,
        activeSec: 130,
        elapsedSpanSec: 200,
      }),
    ],
    hasMore: false,
    unattributed: { legacyRounds: 2, unattributedAnswers: 14, unattributedTakes: 0 },
  };
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/history/sessions")) return json(sessionsPage);
    if (url.startsWith("/api/history/mistakes")) return json({ items: [], total: 0, hasMore: false });
    if (url.startsWith("/api/dashboard/summary")) return json({ completedVideos: 3, activeTime: { activeSec: 7200, trackedSince: null, sessionCount: 4 } });
    return json({});
  }) as typeof fetch;
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <HistoryPage />
    </QueryClientProvider>
  );
}

it("one entry per study session: modes, sentences (with overlap and first-coverage credit), active time vs span labeled separately", async () => {
  renderPage();
  const card = await screen.findByTestId("history-session-s1");
  expect(card).toHaveTextContent("Dictation");
  expect(card).toHaveTextContent("Shadowing");
  expect(within(card).getByTestId("history-sentences")).toHaveTextContent(
    "10 sentences practiced (Dictation 8 · Shadowing 5 · 3 in both) · 6 new to the round · 6/8 correct on the latest answer this session"
  );
  expect(card).toHaveTextContent("Est. active 22m");
  expect(card).toHaveTextContent("Session span 25m");
  expect(within(card).getByText(/Round 2 report/).closest("a")).toHaveAttribute("href", "/results/round-9");
});

it("Listening-only session: no round, media seconds labeled as video time (replays included) vs newly covered", async () => {
  renderPage();
  const card = await screen.findByTestId("history-session-s2");
  expect(card).toHaveTextContent("No practice round");
  expect(card).toHaveTextContent("Listened to 4m of video (replays included) · 2m newly covered");
  expect(within(card).queryByText(/report/)).toBeNull();
});

it("practice no session owns is labeled, not invented; the Mistakes view is still there", async () => {
  renderPage();
  expect(await screen.findByTestId("history-unattributed")).toHaveTextContent(
    "2 rounds from before sessions were tracked · 14 answers without a session"
  );
  expect(screen.getByRole("heading", { name: "Mistakes" })).toBeInTheDocument();
  expect(screen.getByText("Est. active time").parentElement).toHaveTextContent("2h");
});
