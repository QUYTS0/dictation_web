/**
 * Practice History, grouped by video (component test, fetch mocked — not a
 * real browser). The grouping, counts, ordering and pagination are the
 * database's (fn_history_videos & co., migration 042 — real PostgreSQL in
 * integration/history-by-video.integration.test.ts); this pins down the
 * page: one card per video, the selected round explicit, rounds/sessions
 * loaded on demand, the shared round report for the selected round, round-
 * less Listening kept apart — and no writes at all.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { User } from "@supabase/supabase-js";
import type { HistoryRound, HistoryVideo, HistoryVideoRounds, HistoryVideoSession, HistoryVideosPage, RoundReport } from "@/lib/types/learning";
import { historySessionsKeys } from "@/lib/queries/historySessions";

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
jest.mock("@/components/VocabularySaveButton", () => function VocabularySaveButton() {
  return null;
});

import HistoryPage from "@/app/history/page";

const progress = (covered: number, required = 10) => ({
  requiredSentenceCount: required,
  coveredSentences: { dictation: covered, shadowing: 0, overall: covered },
  coverage: { dictation: covered / required, shadowing: 0, overall: covered / required },
  attemptCount: covered,
  sentenceAccuracy: { correct: covered, practiced: covered, percent: 100 },
});

const video = (over: Partial<HistoryVideo>): HistoryVideo => ({
  videoId: "vidA",
  title: "Video A",
  lastActivityAt: "2026-09-30T08:25:00Z",
  sessionCount: 5,
  roundCount: 2,
  inLibrary: true,
  activeSec: 3600,
  round: { roundId: "r2", roundNumber: 2, status: "active", provenance: "current", startedAt: "2026-09-29T00:00:00Z", completedAt: null, progress: progress(3) },
  listening: { transcriptId: "tr", coverageRatio: null, listenedThrough: false, hasHistory: false },
  ...over,
});

const round = (over: Partial<HistoryRound>): HistoryRound => ({
  roundId: "r2",
  roundNumber: 2,
  status: "active",
  provenance: "current",
  transcriptId: "tr-B",
  startedAt: "2026-09-29T00:00:00Z",
  completedAt: null,
  sessionCount: 2,
  unattributedAnswers: 0,
  unattributedTakes: 0,
  progress: progress(3),
  ...over,
});

const ROUNDS: HistoryVideoRounds = {
  videoId: "vidA",
  defaultRoundId: "r2",
  rounds: [
    round({}),
    round({
      roundId: "r1",
      roundNumber: 1,
      status: "completed",
      transcriptId: "tr-A",
      completedAt: "2026-09-20T00:00:00Z",
      sessionCount: 3,
      unattributedAnswers: 14,
      progress: progress(10),
    }),
  ],
  hasMore: false,
  roundlessSessionCount: 1,
};

const sessionRow = (over: Partial<HistoryVideoSession>): HistoryVideoSession => ({
  studySessionId: "s1",
  videoId: "vidA",
  roundId: "r1",
  startedAt: "2026-09-20T08:00:00Z",
  lastActivityAt: "2026-09-20T08:25:00Z",
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

/** A minimal whole-round report — what fn_round_report returns for the selected round. */
const report = (roundId: string, roundNumber: number, firstSentence: string): RoundReport =>
  ({
    round: {
      roundId,
      videoId: "vidA",
      title: "Video A",
      transcriptId: roundId === "r1" ? "tr-A" : "tr-B",
      status: roundId === "r1" ? "completed" : "active",
      provenance: "current",
      roundNumber,
      requiredSentenceCount: 10,
      startedAt: "2026-09-01T00:00:00Z",
      updatedAt: "2026-09-03T00:00:00Z",
      completedAt: roundId === "r1" ? "2026-09-20T00:00:00Z" : null,
      completedAtApproximate: false,
      currentSegmentIndex: 0,
    },
    historyComplete: true,
    progress: progress(roundId === "r1" ? 10 : 3),
    dictation: {
      practicedSentences: roundId === "r1" ? 10 : 3,
      latestCorrect: roundId === "r1" ? 9 : 1,
      needsReview: roundId === "r1" ? 1 : 2,
      corrected: 0,
      submissions: 12,
      invalidSubmissions: 0,
      bestStreak: roundId === "r1" ? 7 : 1,
      firstTry: { available: true, correct: 5, correctWithHint: 0, correctHintUnknown: 0 },
      accuracy: { correct: roundId === "r1" ? 9 : 1, practiced: roundId === "r1" ? 10 : 3, excludedUnverified: 0 },
    },
    shadowing: {
      takes: 0,
      practicedSentences: 0,
      attemptedSentences: 0,
      azure: { evaluatedSentences: 0, pronunciation: null, accuracy: null, completeness: null, fluency: null, prosody: null },
      wordMatch: { evaluatedSentences: 0, accuracy: null, completeness: null },
    },
    activity: { activeSec: 600, trackedSince: null, sessionCount: 1, unattributedAnswers: 0, unattributedTakes: 0 },
    sentences: [
      {
        segmentIndex: 0,
        text: firstSentence,
        eligible: true,
        category: "needs_review",
        dictation: {
          submissions: 1,
          practiceSubmissions: 1,
          first: { correct: false, hintLevel: 0, userText: "x" },
          latest: { correct: false, userText: "x", errorType: null, attemptId: "a", createdAt: "2026-09-02T00:00:00Z" },
          everIncorrect: true,
        },
        shadowing: null,
      },
    ],
  }) as RoundReport;

const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
let pages: Record<string, HistoryVideosPage>;
let calls: Array<{ url: string; method: string }>;
let qc: QueryClient;

beforeEach(() => {
  window.sessionStorage.clear();
  calls = [];
  pages = {
    first: {
      items: [
        video({}),
        video({
          videoId: "vidL",
          title: "Listening video",
          sessionCount: 1,
          roundCount: 0,
          round: null,
          inLibrary: false,
          activeSec: 130,
          listening: { transcriptId: "tr", coverageRatio: 0.42, listenedThrough: false, hasHistory: true },
        }),
      ],
      hasMore: true,
      total: 3,
    },
    second: { items: [video({ videoId: "vidZ", title: "Video Z", sessionCount: 1, roundCount: 1 })], hasMore: false, total: 3 },
  };
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET" });
    if (url.startsWith("/api/history/videos?")) return json(url.includes("beforeVideoId") ? pages.second : pages.first);
    if (url === "/api/history/videos/vidA/rounds") return json(ROUNDS);
    if (url.startsWith("/api/history/videos/vidA/sessions?roundId=r1")) return json({ items: [sessionRow({})], hasMore: false });
    if (url.startsWith("/api/history/videos/vidA/sessions?roundId=none"))
      return json({
        items: [
          sessionRow({
            studySessionId: "sL",
            roundId: null,
            modesUsed: ["listening"],
            dictationSentences: 0,
            shadowingSentences: 0,
            overlapSentences: 0,
            uniqueSentences: 0,
            newlyCoveredInRound: 0,
            listeningObservedSec: 240,
            listeningNewlyCoveredSec: 95,
          }),
        ],
        hasMore: false,
      });
    if (url === "/api/session/r2/report") return json({ round: report("r2", 2, "Revision B sentence") });
    if (url === "/api/session/r1/report") return json({ round: report("r1", 1, "Revision A sentence") });
    if (url.startsWith("/api/history/mistakes")) return json({ items: [], total: 0, hasMore: false });
    if (url.startsWith("/api/dashboard/summary")) return json({ completedVideos: 3, activeTime: { activeSec: 7200, trackedSince: null, sessionCount: 4 } });
    return json({});
  }) as typeof fetch;
});

function renderPage() {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <HistoryPage />
    </QueryClientProvider>
  );
}
const expandVideo = async (videoId: string) => {
  const card = await screen.findByTestId(`history-video-${videoId}`);
  fireEvent.click(within(card).getByRole("button", { name: "Rounds and sessions" }));
  return card;
};

it("one card per video: last practiced, session and round counts, the default round's own coverage, actions", async () => {
  renderPage();
  const card = await screen.findByTestId("history-video-vidA");
  expect(screen.getAllByTestId(/^history-video-/)).toHaveLength(2);
  expect(card).toHaveTextContent("5 study sessions · 2 rounds");
  expect(card).toHaveTextContent("Round 2: In progress");
  expect(within(card).getByTestId("history-round-coverage")).toHaveTextContent("Round 2 coverage: 3/10 sentences practiced");
  expect(card).toHaveTextContent("Est. active 1h (all sessions)");
  expect(within(card).getByRole("link", { name: /View report/ })).toHaveAttribute("href", "/results/r2");
  expect(within(card).getByRole("link", { name: /Continue/ })).toHaveAttribute("href", "/dictation/vidA");
  // Nothing per round/session is fetched until the card is expanded.
  expect(calls.some((c) => c.url.includes("/rounds") || c.url.includes("/sessions?") || c.url.includes("/report"))).toBe(false);
});

it("Listening-only history: no round, no report link, revision-scoped Listening, and a removed video is labeled — not re-added", async () => {
  renderPage();
  const card = await screen.findByTestId("history-video-vidL");
  expect(card).toHaveTextContent("Listening only — no practice round");
  expect(card).toHaveTextContent("Listening (current script): 42%");
  expect(card).toHaveTextContent("Not in your Library");
  expect(within(card).queryByRole("link", { name: /View report/ })).toBeNull();
  expect(within(card).getByRole("link", { name: /Continue/ })).toHaveAttribute("href", "/dictation/vidL?mode=listening");
});

it("expanding shows the selected round explicitly with its own report; choosing an older round loads THAT round's report", async () => {
  renderPage();
  const card = await expandVideo("vidA");
  expect(await within(card).findByTestId("history-selected-round")).toHaveTextContent("Round 2 — In progress");
  expect(await within(card).findByTestId("history-round-report-r2")).toHaveTextContent("Revision B sentence");

  const older = within(card).getByRole("button", { name: /Round 1 · Completed · 10\/10 sentences practiced/ });
  expect(within(card).getByRole("button", { name: /Round 2 · In progress/ })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(older);
  expect(older).toHaveAttribute("aria-pressed", "true");
  expect(within(card).getByTestId("history-selected-round")).toHaveTextContent("Round 1 — Completed");
  const oldReport = await within(card).findByTestId("history-round-report-r1");
  expect(oldReport).toHaveTextContent("Revision A sentence"); // its own pinned transcript
  expect(within(oldReport).getByTestId("report-accuracy")).toHaveTextContent("90%"); // its own metrics
  expect(within(oldReport).getByRole("link", { name: /Open full report/ })).toHaveAttribute("href", "/results/r1");
  // Practice from the card still opens the video normally — the selection never changes practice state.
  expect(within(card).getByRole("link", { name: /Continue/ })).toHaveAttribute("href", "/dictation/vidA");
  expect(within(card).getByTestId("history-unattributed")).toHaveTextContent("Not grouped into a study session: 14 answers");
});

it("study sessions sit in a collapsed section of the selected round; round-less Listening sittings stay separate", async () => {
  renderPage();
  const card = await expandVideo("vidA");
  fireEvent.click(await within(card).findByRole("button", { name: /Round 1 · Completed/ }));
  const sessionsSummary = await within(card).findByText("Study sessions in round 1 (3)");
  expect(calls.some((c) => c.url.includes("/sessions?"))).toBe(false); // collapsed: not loaded
  const details = sessionsSummary.closest("details")!;
  await act(async () => {
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
  });
  const row = await within(card).findByTestId("history-session-s1");
  expect(within(row).getByTestId("history-sentences")).toHaveTextContent(
    "10 sentences practiced (Dictation 8 · Shadowing 5 · 3 in both) · 6 new to the round · 6/8 correct on the latest answer this session"
  );
  expect(row).toHaveTextContent("Est. active 22m");
  expect(row).toHaveTextContent("span 25m");
  expect(within(row).queryByRole("img")).toBeNull(); // no repeated thumbnail per session
  expect(within(row).queryByRole("link")).toBeNull(); // no repeated report link per session

  const roundless = within(card).getByText("Listening without a practice round (1)").closest("details")!;
  await act(async () => {
    roundless.open = true;
    roundless.dispatchEvent(new Event("toggle"));
  });
  expect(await within(card).findByTestId("history-session-sL")).toHaveTextContent(
    "Listened to 4m of video (replays included) · 2m newly covered"
  );
  expect(calls.map((c) => c.url)).toContain("/api/history/videos/vidA/sessions?roundId=none&limit=10");
});

it("Load more pages by video with the server cursor; reading History makes no writes", async () => {
  renderPage();
  await screen.findByTestId("history-video-vidA");
  fireEvent.click(screen.getByRole("button", { name: "Load more" }));
  await screen.findByTestId("history-video-vidZ");
  expect(screen.getAllByTestId(/^history-video-/).map((el) => el.getAttribute("data-testid"))).toEqual([
    "history-video-vidA",
    "history-video-vidL",
    "history-video-vidZ",
  ]);
  expect(calls.map((c) => c.url)).toContain(
    "/api/history/videos?limit=10&beforeLastActivityAt=2026-09-30T08%3A25%3A00Z&beforeVideoId=vidL"
  );
  await expandVideo("vidA");
  await screen.findByTestId("history-round-report-r2");
  expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  expect(screen.getByText("3 videos")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Mistakes" })).toBeInTheDocument();
});

it("after a confirmed save/flush (account-scoped History invalidation) the list refetches with the new order and summary", async () => {
  renderPage();
  await screen.findByTestId("history-video-vidA");
  pages.first = {
    items: [video({ videoId: "vidL", title: "Listening video", sessionCount: 2, roundCount: 1 }), video({})],
    hasMore: false,
    total: 2,
  };
  await act(async () => {
    await qc.invalidateQueries({ queryKey: historySessionsKeys.allForUser("user-1") });
  });
  await waitFor(() =>
    expect(screen.getAllByTestId(/^history-video-/).map((el) => el.getAttribute("data-testid"))).toEqual([
      "history-video-vidL",
      "history-video-vidA",
    ])
  );
  expect(screen.getByTestId("history-video-vidL")).toHaveTextContent("2 study sessions · 1 round");
});

it("Shadowing in an older round: its report names the round, its feedback stays collapsed (no detail download) until opened", async () => {
  const withShadowing = (r: RoundReport): RoundReport => ({
    ...r,
    progress: { ...r.progress, coveredSentences: { ...r.progress.coveredSentences, shadowing: 4 } },
    shadowing: {
      takes: 5,
      practicedSentences: 4,
      attemptedSentences: 4,
      azure: { evaluatedSentences: 2, pronunciation: 84.5, accuracy: 80, completeness: 90, fluency: 70, prosody: null },
      wordMatch: { evaluatedSentences: 0, accuracy: null, completeness: null },
    },
  });
  const inner = global.fetch;
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/session/r1/report") {
      calls.push({ url, method: init?.method ?? "GET" });
      return json({ round: withShadowing(report("r1", 1, "Revision A sentence")) });
    }
    if (url.startsWith("/api/practice/attempts?roundId=r1")) {
      calls.push({ url, method: init?.method ?? "GET" });
      return json({ roundId: "r1", youtubeVideoId: "vidA", transcriptId: "tr-A", roundStatus: "completed", evaluationTimeoutSec: 120, segments: [] });
    }
    return inner(input, init);
  }) as typeof fetch;
  renderPage();
  const card = await expandVideo("vidA");
  fireEvent.click(await within(card).findByRole("button", { name: /Round 1 · Completed/ }));
  const oldReport = await within(card).findByTestId("history-round-report-r1");
  expect(within(oldReport).getByTestId("report-shadowing-azure")).toHaveTextContent("84.5");
  expect(within(oldReport).getByTestId("report-shadowing-azure")).toHaveTextContent("2 of 10 sentences scored by Azure");
  const toggle = within(oldReport).getByRole("button", { name: /Shadowing summary · Round 1/ });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(calls.some((c) => c.url.startsWith("/api/practice/attempts"))).toBe(false);
  fireEvent.click(toggle);
  await waitFor(() => expect(calls.map((c) => c.url)).toContain("/api/practice/attempts?roundId=r1"));
  expect(calls.some((c) => c.url.includes("roundId=r2") && c.url.startsWith("/api/practice/attempts"))).toBe(false);
  expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
});
