/**
 * The Dashboard (component tests, fetch mocked — not a real browser):
 *   - wide shared shell; the resume card beside the league, the review deck
 *     full width (the league joins it when there is no resume card);
 *   - each task has ONE home (plan §4.5.9): the sentences to look at again
 *     in the Continue card, the words in the review deck; the hero's Today
 *     list only says what's left and jumps there — no Next up card;
 *   - unknown data is never "nothing left"; "All done for today" only when
 *     every source answered;
 *   - exact cold-load request counts, no writes, no AI/provider calls;
 *   - cached data during background refetch; invalidation; account isolation.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { User } from "@supabase/supabase-js";
import type { DashboardSummary, DashboardWeek, LibraryItem, LibraryPage } from "@/lib/types/learning";
import type { VocabularyStatsResponse } from "@/lib/types";
import type { LeagueWeekBoard } from "@/lib/types/leaderboard";
import type { XpSummary } from "@/lib/types/xp";
import { PAGE_PADDING_CLASS, PAGE_WIDTH_CLASS } from "@/lib/layout/pageWidth";
import { invalidateLearningViews } from "@/lib/queries/learningInvalidation";
import { invalidateVocabularyQueries } from "@/lib/queries/vocabulary";
import { videoLibraryKeys } from "@/lib/queries/videoLibrary";

let authUser: User = { id: "user-1", email: "learner@example.test" } as User;
jest.mock("@/context/auth", () => ({
  useAuth: () => ({ user: authUser, loading: false, openAuthModal: jest.fn() }),
}));
jest.mock("next/navigation", () => ({
  usePathname: () => "/dashboard",
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
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
// The app shell (header + footer, incl. its streak request) is covered by app-shell.test.tsx.
jest.mock("@/components/AppFooter", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/AppHeader", () => function AppHeader() {
  return null;
});

import DashboardPage from "@/app/dashboard/page";

// ---------------------------------------------------------------- fixtures

function item(videoId: string, acc: { correct: number; practiced: number } | null, over: Partial<LibraryItem> = {}, roundOver: Partial<NonNullable<LibraryItem["round"]>> = {}): LibraryItem {
  return {
    videoId,
    title: `Title ${videoId}`,
    addedAt: "2026-09-01T00:00:00Z",
    lastActivityAt: "2026-09-02T00:00:00Z",
    lastMode: "dictation",
    state: acc ? "in_progress" : "not_started",
    hasCompletedRound: false,
    hasLegacyCompletion: false,
    completedRoundCount: 1,
    round: acc
      ? {
          roundId: `round-${videoId}`,
          status: "active",
          provenance: "current",
          roundNumber: 2,
          transcriptId: "tr",
          startedAt: "2026-09-01T00:00:00Z",
          completedAt: null,
          currentSegmentIndex: 0,
          progress: {
            requiredSentenceCount: 20,
            coveredSentences: { dictation: acc.practiced, shadowing: 0, overall: acc.practiced },
            coverage: { dictation: acc.practiced / 20, shadowing: 0, overall: acc.practiced / 20 },
            attemptCount: acc.practiced,
            sentenceAccuracy: { ...acc, percent: null },
          },
          ...roundOver,
        }
      : null,
    listening: { transcriptId: "tr", coverageRatio: null, listenedThrough: false, lastPositionSec: null, hasHistory: false, historyOnOtherRevision: false },
    ...over,
  };
}
const page = (items: LibraryItem[], filter: LibraryPage["filter"] = "all"): LibraryPage => ({ items, total: items.length, limit: 12, offset: 0, filter, hasMore: false });
const summaryOf = (over: Partial<DashboardSummary> = {}): DashboardSummary => ({
  completedVideos: 1,
  legacyCompletedVideos: 0,
  inProgressVideos: 1,
  listenedThroughVideos: 0,
  libraryVideos: 3,
  sentenceAccuracy: { correct: 3, practiced: 4, excludedUnverified: 0 },
  shadowing: {
    takes: 0,
    practicedSentences: 0,
    attemptedSentences: 0,
    azure: { evaluatedSentences: 0, pronunciation: null, accuracy: null, completeness: null, fluency: null, prosody: null },
    wordMatch: { evaluatedSentences: 0, accuracy: null, completeness: null },
  },
  activeTime: { activeSec: 0, trackedSince: null, sessionCount: 0 },
  vocabularyCount: 12,
  streakDays: 0,
  streakTimeZone: "UTC",
  streakToday: "2026-10-01",
  streakActiveToday: false,
  streakIncludesUtcFallback: false,
  recentVocabulary: [],
  ...over,
});
const statsOf = (over: Partial<VocabularyStatsResponse> = {}): VocabularyStatsResponse => ({ total: 12, new: 0, learning: 12, due: 0, reviewable: 0, ...over });

const TODAY = "2026-11-25";
const weekOf = (todaySec: number, goalMinutes = 15): DashboardWeek => ({
  timeZone: "UTC",
  today: TODAY,
  weekStart: "2026-11-23",
  goalMinutes,
  goalIsDefault: false,
  days: [{ date: TODAY, practiced: todaySec > 0, activeSec: todaySec }],
});
const xpOf = (wordsReviewed: number): XpSummary => ({
  rulesVersion: 1,
  timeZone: "UTC",
  xpTimeZone: "UTC",
  today: TODAY,
  totalXp: 120,
  todayXp: 20,
  level: 2,
  levelStartXp: 100,
  nextLevelXp: 300,
  leagueWeekStart: "2026-11-23T00:00:00Z",
  leagueWeekXp: 20,
  lastLeagueWeek: { weekStart: "2026-11-16", xp: 0, activeSec: 0, wordsReviewed: 0 },
  days: [{ date: TODAY, xp: 20, activity: { dictationSentences: 0, shadowingSentences: 0, wordsReviewed, listeningMin: 0 } }],
});
const LEAGUE: LeagueWeekBoard = {
  scope: "week",
  status: "member",
  tier: 1,
  weekStart: "2026-11-23",
  weekEndsAt: "2026-11-30T00:00:00Z",
  displayName: "Learner 1",
  lastWeek: null,
  rows: [{ rank: 1, memberKey: "m1", name: "Learner 1", initials: "L1", weekXp: 50, streakDays: 1, kudos: 0, youGaveKudos: false, isYou: true, zone: "safe" }],
  you: { rank: 1, weekXp: 50, zone: "safe", gapToPromotionXp: null },
};

const NEEDS = item("vNeeds", { correct: 5, practiced: 8 }); // 3 sentences need another look
const CLEAN = item("vClean", { correct: 8, practiced: 8 });

// ---------------------------------------------------------------- fetch mock with per-source gates

type Source = "summary" | "continue" | "library" | "errors" | "vocab";
const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
let responses: { summary: DashboardSummary; continue: LibraryPage; library: LibraryPage; vocab: VocabularyStatsResponse };
/** Optional parts: unanswered (404) unless set, so the hero and rows leave them out. */
let extras: { week?: DashboardWeek; xp?: XpSummary; league?: LeagueWeekBoard };
let failing: Set<Source>;
let gates: Partial<Record<Source, Promise<void>>>;
let errorPatterns: { total: number; patterns: Array<{ errorType: string; count: number; percentage: number }> };
const calls: string[] = [];

function gate(source: Source): () => void {
  let release!: () => void;
  gates[source] = new Promise<void>((r) => (release = r));
  return () => {
    delete gates[source];
    release();
  };
}

beforeEach(() => {
  calls.length = 0;
  authUser = { id: "user-1", email: "learner@example.test" } as User;
  responses = { summary: summaryOf(), continue: page([NEEDS], "continue"), library: page([NEEDS, CLEAN]), vocab: statsOf() };
  extras = {};
  failing = new Set();
  gates = {};
  errorPatterns = { total: 0, patterns: [] };
  window.sessionStorage.clear();
  window.localStorage.clear();
  Element.prototype.scrollIntoView = jest.fn();
  window.matchMedia = jest.fn().mockReturnValue({ matches: false }) as unknown as typeof window.matchMedia;
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    const source: Source | null = url.startsWith("/api/dashboard/summary")
      ? "summary"
      : url.startsWith("/api/dashboard/error-patterns")
        ? "errors"
        : url.startsWith("/api/vocabulary/stats")
          ? "vocab"
          : url.startsWith("/api/videos/library?")
            ? url.includes("filter=continue")
              ? "continue"
              : "library"
            : null;
    // The review deck's batch and the diagnostics example (Phase 3); plain answers here.
    if (url.startsWith("/api/vocabulary/review")) return json({ items: [] });
    if (url.startsWith("/api/dashboard/mistake-example")) return json({ example: null });
    if (url.startsWith("/api/dashboard/week")) return extras.week ? json(extras.week) : json({}, 404);
    if (url.startsWith("/api/xp")) return extras.xp ? json(extras.xp) : json({}, 404);
    if (url.startsWith("/api/leaderboard")) return extras.league ? json(extras.league) : json({}, 404);
    if (!source) return json({}, 404);
    const g = gates[source];
    if (g) await g;
    if (failing.has(source)) return json({ error: "boom" }, 500);
    if (source === "errors") return json(errorPatterns);
    return json(responses[source]);
  }) as typeof fetch;
});

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
function renderDashboard(client = newClient()) {
  return { client, ...render(<QueryClientProvider client={client}><DashboardPage /></QueryClientProvider>) };
}
const hero = () => screen.getByTestId("dashboard-welcome");
const todayRow = (kind: "sentences" | "words") => screen.queryByTestId(`today-row-${kind}`);
const settle = () => waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(4));

// ---------------------------------------------------------------- layout

describe("wide shell and layout", () => {
  it("Dashboard main uses the shared wide width + padding tokens (same as AppHeader), never max-w-6xl", async () => {
    renderDashboard();
    const main = screen.getByRole("main");
    for (const cls of `${PAGE_WIDTH_CLASS.wide} ${PAGE_PADDING_CLASS.wide}`.split(" ")) expect(main.classList).toContain(cls);
    expect(main.className).not.toContain("max-w-6xl");
    await settle();
  });

  it("'Pick up where you left off' (8/12) above the deck (8/12), this week's league running beside both (4/12, two rows); phone order resume → league → deck", async () => {
    extras.league = LEAGUE;
    responses.continue = page([NEEDS, CLEAN], "continue");
    renderDashboard();
    const league = await screen.findByTestId("league-card");
    const grid = screen.getByTestId("dashboard-learning");
    expect(grid).toHaveClass("grid", "lg:grid-cols-12");
    const cont = within(grid).getByTestId("continue-learning");
    const deck = within(grid).getByTestId("vocabulary-card");
    expect(cont.parentElement).toHaveClass("lg:col-span-8", "lg:col-start-1", "lg:row-start-1");
    expect(deck.parentElement).toHaveClass("lg:col-span-8", "lg:col-start-1", "lg:row-start-2");
    expect(league.parentElement).toHaveClass("relative", "lg:col-span-4", "lg:col-start-9", "lg:row-start-1", "lg:row-span-2");
    // It takes the two cards' height and lists as many rows as fit (LeagueCard fill, leaderboard tests).
    expect(league).toHaveAttribute("data-fill", "true");
    expect([...grid.children]).toEqual([cont.parentElement, league.parentElement, deck.parentElement]);
    expect(within(cont).getByTestId("continue-card-vNeeds")).toBeInTheDocument();
    expect(screen.queryByTestId("continue-card-vClean")).toBeNull(); // only the first item
    expect(screen.queryByTestId("dashboard-focus")).toBeNull(); // no Next up card any more
  });

  it("no league → the resume card alone at a readable width, not a full-width banner; the deck below on its own", async () => {
    responses.continue = page([CLEAN], "continue");
    renderDashboard();
    const cont = await screen.findByTestId("continue-learning");
    await waitFor(() => expect(screen.queryByLabelText("Loading your league")).toBeNull());
    expect(screen.getByTestId("dashboard-learning")).not.toHaveClass("lg:grid-cols-12");
    expect(cont.parentElement).toHaveClass("max-w-3xl");
    expect(cont.parentElement!.className).not.toMatch(/col-span/);
    expect(screen.getByTestId("vocabulary-card").parentElement!.className).not.toMatch(/col-span/);
  });

  it("nothing unfinished → a small 'Browse My Learning' pointer replaces the resume card, and the league sits beside the deck only, as a plain card (never alone)", async () => {
    extras.league = LEAGUE;
    responses.continue = page([], "continue");
    renderDashboard();
    const empty = await screen.findByTestId("continue-empty");
    expect(empty).toHaveTextContent("Nothing unfinished right now.");
    expect(within(empty).getByRole("link", { name: "Browse My Learning" })).toHaveAttribute("href", "/library");
    const league = await screen.findByTestId("league-card");
    expect(empty.parentElement).toHaveClass("max-w-3xl", "lg:col-span-12", "lg:row-start-1");
    expect(league.parentElement).toHaveClass("lg:col-span-4", "lg:col-start-9", "lg:row-start-2");
    expect(league.parentElement).not.toHaveClass("lg:row-span-2");
    expect(league).not.toHaveAttribute("data-fill");
    expect(screen.getByTestId("vocabulary-card").parentElement).toHaveClass("lg:col-span-8", "lg:col-start-1", "lg:row-start-2");
  });

  it("the cards are never rebuilt when the layout changes as data arrives (the deck keeps its card)", async () => {
    // Continue and the league load while the deck is already on screen: the
    // layout moves from 'league beside both' to 'no league' (and to 'beside
    // the deck only'), but the deck stays the same element.
    responses.continue = page([CLEAN], "continue");
    const first = renderDashboard();
    const deck = await screen.findByTestId("vocabulary-card");
    await waitFor(() => expect(screen.queryByLabelText("Loading your league")).toBeNull());
    await screen.findByTestId("continue-learning");
    expect(screen.getByTestId("vocabulary-card")).toBe(deck);
    first.unmount();

    extras.league = LEAGUE;
    responses.continue = page([], "continue");
    renderDashboard();
    const deck2 = await screen.findByTestId("vocabulary-card");
    await screen.findByTestId("continue-empty");
    await screen.findByTestId("league-card");
    expect(screen.getByTestId("vocabulary-card")).toBe(deck2);
  });

  it("nothing to resume and an empty library → no resume row at all", async () => {
    responses.continue = page([], "continue");
    responses.summary = summaryOf({ libraryVideos: 0, vocabularyCount: 3 });
    renderDashboard();
    await screen.findByTestId("your-progress");
    await waitFor(() => expect(screen.queryByLabelText("Loading continue learning")).toBeNull());
    expect(screen.queryByTestId("continue-learning")).toBeNull();
    expect(screen.queryByTestId("continue-empty")).toBeNull();
    await waitFor(() => expect(screen.queryByLabelText("Loading your league")).toBeNull());
    expect([...screen.getByTestId("dashboard-learning").children]).toEqual([screen.getByTestId("vocabulary-card").parentElement]);
  });

  it("no six metric cards, no Library, no rail, no sticky; the deck and diagnostics are full-width sections that size themselves (container queries)", async () => {
    renderDashboard();
    await screen.findByTestId("your-progress");
    expect(screen.queryByRole("region", { name: "Progress summary" })).toBeNull();
    const main = screen.getByRole("main");
    const learning = screen.getByTestId("dashboard-learning");
    expect(learning.parentElement).toBe(main);
    await waitFor(() => expect(screen.queryByLabelText("Loading your league")).toBeNull());
    expect(learning).not.toHaveClass("lg:grid-cols-12"); // no league here: each card takes the width alone
    expect(learning).toContainElement(screen.getByTestId("vocabulary-card"));
    // Diagnostics share a row with achievements (Phase 6); unavailable here, so the row is one column.
    const row = screen.getByTestId("dashboard-diagnostics-row");
    expect(row.parentElement).toBe(main);
    expect(row).not.toHaveClass("lg:grid-cols-12");
    expect(row).toContainElement(screen.getByTestId("needs-attention"));
    expect(screen.getByTestId("vocabulary-card")).toHaveClass("@container");
    expect(screen.getByTestId("needs-attention")).toHaveClass("@container");
    expect(document.querySelector('[class*="sticky"]')).toBeNull();
    for (const gone of ["dashboard-rail", "library-rail-grid", "library-grid", "dashboard-insights", "dashboard-focus"]) expect(screen.queryByTestId(gone)).toBeNull();
  });

  it("DOM order: hero (Today list, 'Start a new video') → Continue → review deck → Learning performance → Needs attention", async () => {
    extras.week = weekOf(300);
    renderDashboard();
    const welcome = await screen.findByTestId("dashboard-welcome");
    expect(within(welcome).getByRole("button", { name: "Start a new video" })).toBeInTheDocument();
    expect(await within(welcome).findByTestId("today-plan")).toBeInTheDocument();
    const order = [welcome, screen.getByTestId("continue-learning"), screen.getByTestId("vocabulary-card"), screen.getByTestId("your-progress"), screen.getByTestId("needs-attention")];
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });
});

describe("welcome and Your progress", () => {
  it("the streak status sits under the heading; no streak → no streak claim (all states: dashboard-hero.test.tsx)", async () => {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    responses.summary = summaryOf({ streakDays: 12, streakActiveToday: true, streakToday: today });
    const first = renderDashboard();
    const welcome = await screen.findByTestId("dashboard-welcome");
    expect(within(welcome).getByRole("heading", { name: "Welcome back, learner" })).toBeInTheDocument();
    expect(await within(welcome).findByTestId("streak-status")).toHaveTextContent("12-day streak · today is done");
    first.unmount();
    responses.summary = summaryOf({ streakDays: 0, streakToday: today });
    renderDashboard();
    const w2 = await screen.findByTestId("dashboard-welcome");
    expect(await within(w2).findByTestId("streak-status")).toHaveTextContent("Ready for today's practice?");
    expect(w2.textContent).not.toMatch(/streak/i);
  });

  it("all six canonical values represented: three primary outcomes + non-zero video counts as one line", async () => {
    responses.summary = summaryOf({
      activeTime: { activeSec: 11400, trackedSince: "2026-08-01T00:00:00Z", sessionCount: 3 },
      sentenceAccuracy: { correct: 61, practiced: 80, excludedUnverified: 0 },
      shadowing: { ...summaryOf().shadowing, azure: { ...summaryOf().shadowing.azure, evaluatedSentences: 12, pronunciation: 82.94 } },
      inProgressVideos: 2,
      listenedThroughVideos: 1,
      completedVideos: 4,
      legacyCompletedVideos: 0,
    });
    renderDashboard();
    const progress = await screen.findByTestId("your-progress");
    expect(within(progress).getByTestId("progress-active")).toHaveTextContent("3h 10m");
    expect(within(progress).getByTestId("progress-accuracy")).toHaveTextContent("76%");
    expect(within(progress).getByTestId("progress-accuracy")).toHaveTextContent("61/80 latest answers");
    expect(within(progress).getByTestId("progress-pronunciation")).toHaveTextContent("82.9");
    expect(within(progress).getByTestId("progress-pronunciation")).toHaveTextContent("12 scored sentences");
    expect(within(progress).getByTestId("progress-videos")).toHaveTextContent("2 videos in progress · 1 listened through · 4 completed");
  });

  it("zero video counts are not emphasized; legacy completions stay labeled; missing outcomes show '—'", async () => {
    responses.summary = summaryOf({ inProgressVideos: 0, listenedThroughVideos: 0, completedVideos: 0, legacyCompletedVideos: 2, sentenceAccuracy: { correct: 0, practiced: 0, excludedUnverified: 0 } });
    renderDashboard();
    const progress = await screen.findByTestId("your-progress");
    expect(within(progress).getByTestId("progress-videos").textContent).toBe("+2 completed in rounds started before detailed tracking");
    expect(within(progress).getByTestId("progress-accuracy")).toHaveTextContent("—");
    expect(within(progress).getByTestId("progress-pronunciation")).toHaveTextContent("—");
    expect(progress.textContent).not.toMatch(/\b0 (videos|listened|completed)/);
  });
});

describe("Needs attention (existing error-pattern data, descriptive only)", () => {
  it("bars per recorded type and a factual 'most common' line; no cause/trend/prescription", async () => {
    errorPatterns = { total: 9, patterns: [{ errorType: "wrong_form", count: 5, percentage: 56 }, { errorType: "missing_word", count: 3, percentage: 33 }, { errorType: "extra_word", count: 1, percentage: 11 }] };
    renderDashboard();
    const card = await screen.findByTestId("needs-attention");
    await within(card).findByText("Wrong form is your most common recorded mistake.");
    expect(within(card).getAllByRole("listitem")).toHaveLength(3);
    expect(card.textContent).not.toMatch(/improv|better|worse|because|AI|should|try /i);
    // The one link is factual navigation to those mistakes in History (Phase 3), not advice.
    expect(within(card).getAllByRole("link")).toHaveLength(1);
    expect(within(card).getByRole("link", { name: "Review wrong form mistakes" })).toHaveAttribute("href", "/history?errorType=wrong_form");
  });

  it("selecting a type shows its meaning and latest example, and retargets the History link", async () => {
    errorPatterns = { total: 9, patterns: [{ errorType: "wrong_form", count: 5, percentage: 56 }, { errorType: "missing_word", count: 4, percentage: 44 }] };
    renderDashboard();
    const card = await screen.findByTestId("needs-attention");
    const missing = await within(card).findByRole("button", { name: /Missing word/ });
    expect(within(card).getByRole("button", { name: /Wrong form/ })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(missing);
    expect(missing).toHaveAttribute("aria-pressed", "true");
    expect(within(card).getByTestId("mistake-example-panel")).toHaveTextContent("Your answer has fewer words than the sentence");
    expect(within(card).getByRole("link", { name: "Review missing word mistakes" })).toHaveAttribute("href", "/history?errorType=missing_word");
    await waitFor(() => expect(calls).toContain("GET /api/dashboard/mistake-example?errorType=missing_word"));
    expect(await within(card).findByText("No example to show for this type yet.")).toBeInTheDocument();
  });

  it("a tie never names a single 'most common' type", async () => {
    errorPatterns = { total: 6, patterns: [{ errorType: "spelling", count: 3, percentage: 50 }, { errorType: "missing_word", count: 3, percentage: 50 }] };
    renderDashboard();
    const card = await screen.findByTestId("needs-attention");
    await within(card).findByText("Spelling and missing word are your most common recorded mistakes.");
  });
});

// ---------------------------------------------------------------- requests

describe("request contract", () => {
  const expected = [
    "GET /api/dashboard/summary",
    "GET /api/videos/library?filter=continue&offset=0&limit=1",
    "GET /api/dashboard/error-patterns",
    "GET /api/vocabulary/stats",
    // The review deck's current batch (Phase 3). No mistake example here:
    // with no recorded mistakes there is no type to show one for.
    "GET /api/vocabulary/review",
    // The hero's weekly track and Today list (Phase 4; unanswered here,
    // so the hero leaves them out).
    "GET /api/dashboard/week",
    // XP and level (Phase 5; unanswered here, so the hero leaves them out).
    "GET /api/xp",
    // Achievements (Phase 6; unanswered here, so diagnostics take the row alone).
    "GET /api/achievements",
    // This week's league (Phase 7; unanswered here) and the profile (the
    // welcome uses a public name when one is set).
    "GET /api/leaderboard?scope=week",
    "GET /api/profile",
  ];
  const normalize = (c: string) => c.replace(/[?&]tz=.*$/, "");

  // The sentence COUNT never waits for the round report (it comes from the
  // Continue item, plan D-2 Option B). With sentences to look at again, the
  // Continue card then reads that one round's report to name them.
  const report = `GET /api/session/${NEEDS.round!.roundId}/report`;
  it.each([
    ["with sentences to look at again: 11 GETs, the 11th being that round's report", [NEEDS], [report]],
    ["without: exactly 10 GETs, no round report", [CLEAN], [] as string[]],
  ])("cold load %s — no all-library request, no writes, no AI/provider calls", async (_label, items, extra) => {
    responses.continue = page(items, "continue");
    renderDashboard();
    await screen.findByTestId("your-progress");
    await screen.findByTestId("continue-learning");
    await act(async () => {});
    expect(calls.map(normalize).sort()).toEqual([...expected, ...extra].sort());
    expect(calls.some((c) => c.includes("filter=all"))).toBe(false);
    expect(calls.filter((c) => c !== report).some((c) => /explain|gemini|azure|assess|pronunciation|\/api\/dictation|\/api\/session/i.test(c))).toBe(false);
    expect(calls.every((c) => c.startsWith("GET "))).toBe(true);
  });
});

// ---------------------------------------------------------------- one home per task

describe("each task has one home; the Today list jumps to it", () => {
  it("sentences: counted in the Continue card with the ONE 'Review sentences' link; the Today row jumps there and focuses it", async () => {
    renderDashboard();
    const section = await screen.findByTestId("continue-sentences");
    expect(within(screen.getByTestId("continue-learning")).getByTestId("continue-sentences")).toBe(section);
    expect(section).toHaveTextContent("3 sentences need another look");
    expect(within(section).getByRole("link", { name: /Review sentences/ })).toHaveAttribute("href", "/results/round-vNeeds");
    expect(document.querySelectorAll('a[href="/results/round-vNeeds"]')).toHaveLength(1);
    expect(within(screen.getByTestId("continue-learning")).getByRole("link", { name: "Continue learning" })).toHaveAttribute("href", "/dictation/vNeeds");

    const row = await within(hero()).findByTestId("today-row-sentences");
    expect(row).toHaveAccessibleName("3 sentences need another look, go to the sentences");
    expect(row).toHaveAttribute("href", "#continue-sentences");
    fireEvent.click(row);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    expect(document.activeElement).toBe(section);
  });

  it("reduced motion → the jump doesn't animate", async () => {
    window.matchMedia = jest.fn().mockReturnValue({ matches: true }) as unknown as typeof window.matchMedia;
    renderDashboard();
    fireEvent.click(await screen.findByTestId("today-row-sentences"));
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ behavior: "auto", block: "start" });
  });

  it("a null title never renders 'null' or 'Untitled'; one sentence is singular", async () => {
    responses.continue = page([item("vX", { correct: 3, practiced: 4 }, { title: null })], "continue");
    renderDashboard();
    expect(await screen.findByTestId("continue-sentences")).toHaveTextContent("1 sentence needs another look");
    expect(await screen.findByTestId("today-row-sentences")).toHaveTextContent("1 sentence needs another look");
    expect(document.body.textContent).not.toMatch(/\bnull\b|Untitled/);
    expect(screen.getByTestId("continue-card-vX")).toHaveTextContent("Video vX"); // the card's own existing fallback
  });

  it("words due: the Today row jumps to the deck and focuses it (its keys work at once); the deck has the ONE 'Start review'", async () => {
    responses.continue = page([CLEAN], "continue");
    responses.vocab = statsOf({ due: 22, new: 233, reviewable: 255 });
    renderDashboard();
    const row = await screen.findByTestId("today-row-words");
    expect(hero()).toContainElement(row);
    expect(row).toHaveAccessibleName("22 words are due, go to the review deck");
    const deck = screen.getByTestId("vocabulary-card");
    expect(within(deck).getByTestId("vocab-nudge")).toHaveTextContent("22 words are due");
    expect(within(deck).getByRole("link", { name: "Start review" })).toHaveAttribute("href", "/vocabulary/review");
    expect(screen.getAllByRole("link", { name: "Start review" })).toHaveLength(1);
    fireEvent.click(row);
    expect(document.activeElement).toBe(deck);
    // No line claims an order or a batch size.
    const lines = [hero(), deck].flatMap((el) => Array.from(el.querySelectorAll("p, h2, a, li")).map((n) => n.textContent ?? ""));
    for (const line of lines) {
      for (const forbidden of [/Review due/i, /Review \d+/i, /Review all/i, /prioriti[sz]ed/i, /mixed in/i, /batch/i]) expect(line).not.toMatch(forbidden);
    }
  });

  it("new-only vocabulary has its own factual line", async () => {
    responses.continue = page([CLEAN], "continue");
    responses.vocab = statsOf({ new: 7, reviewable: 7 });
    renderDashboard();
    expect(await screen.findByTestId("today-row-words")).toHaveTextContent("New vocabulary is ready to practice");
  });

  it("Vocabulary surface: saved total, review context, at most six recent terms as chips — never a sentence table", async () => {
    responses.summary = summaryOf({
      vocabularyCount: 352,
      recentVocabulary: Array.from({ length: 8 }, (_, i) => ({ id: `w${i}`, term: `term${i}`, sentence_context: `context sentence ${i}`, created_at: "2026-10-01T00:00:00Z" })),
    });
    responses.vocab = statsOf({ total: 352, due: 42, reviewable: 42 });
    renderDashboard();
    const card = await screen.findByTestId("vocabulary-card");
    await within(card).findByText("352 words saved");
    await within(card).findByText("42 words are due");
    expect(within(card).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["term0", "term1", "term2", "term3", "term4", "term5"]);
    expect(card.querySelector("table")).toBeNull();
    expect(card).not.toHaveTextContent("context sentence");
  });
});

// ---------------------------------------------------------------- the Today list

describe("the Today list", () => {
  it("practice time first, then sentences, then words", async () => {
    extras.week = weekOf(300);
    responses.vocab = statsOf({ due: 2, reviewable: 2 });
    renderDashboard();
    const plan = await screen.findByTestId("today-plan");
    await within(plan).findByTestId("today-row-words");
    expect(within(plan).getByTestId("today-target-value")).toHaveTextContent("5 of 15 minutes");
    expect(within(plan).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "3 sentences need another look",
      "2 words are due",
    ]);
  });

  it("words reviewed today and none left → a ticked row, not a link", async () => {
    extras.week = weekOf(300);
    extras.xp = xpOf(5);
    responses.continue = page([CLEAN], "continue");
    renderDashboard();
    const row = await screen.findByTestId("today-row-words");
    expect(row).toHaveAttribute("data-done", "true");
    expect(row).toHaveTextContent("5 words reviewed today");
    expect(row.tagName).toBe("LI");
  });

  it("goal met and nothing else left → 'All done for today ✓'", async () => {
    extras.week = weekOf(20 * 60);
    responses.continue = page([CLEAN], "continue");
    renderDashboard();
    expect(await screen.findByTestId("today-all-done")).toHaveTextContent("All done for today ✓");
    expect(todayRow("sentences")).toBeNull();
    expect(todayRow("words")).toBeNull();
  });

  it("goal met but sentences left → 'Goal met today ✓' only, never 'All done'", async () => {
    extras.week = weekOf(20 * 60);
    renderDashboard();
    await screen.findByTestId("today-row-sentences");
    expect(within(hero()).getByText("Goal met today ✓")).toBeInTheDocument();
    expect(screen.queryByTestId("today-all-done")).toBeNull();
  });

  it("unknown is never 'nothing left': failed word stats → no words row and no 'All done'", async () => {
    extras.week = weekOf(20 * 60);
    responses.continue = page([CLEAN], "continue");
    failing.add("vocab");
    renderDashboard();
    await screen.findByTestId("today-plan");
    await waitFor(() => expect(calls.some((c) => c.includes("/api/vocabulary/stats"))).toBe(true));
    await act(async () => {});
    expect(todayRow("words")).toBeNull();
    expect(screen.queryByTestId("today-all-done")).toBeNull();
    expect(within(hero()).getByText("Goal met today ✓")).toBeInTheDocument();
  });

  it("Continue still loading → no sentences row and no 'All done' yet; they follow once it answers", async () => {
    extras.week = weekOf(20 * 60);
    const releaseContinue = gate("continue");
    renderDashboard();
    await screen.findByTestId("today-plan");
    await act(async () => {});
    expect(todayRow("sentences")).toBeNull();
    expect(screen.queryByTestId("today-all-done")).toBeNull();
    await act(async () => releaseContinue());
    expect(await screen.findByTestId("today-row-sentences")).toBeInTheDocument();
  });

  it("Continue failed: no sentences row, words still listed; never 'All done'", async () => {
    extras.week = weekOf(20 * 60);
    failing.add("continue");
    responses.vocab = statsOf({ due: 1, reviewable: 1 });
    renderDashboard();
    await screen.findByText(/Couldn.t load your unfinished videos/);
    expect(await screen.findByTestId("today-row-words")).toHaveTextContent("1 word is due");
    expect(todayRow("sentences")).toBeNull();
    expect(screen.queryByTestId("today-all-done")).toBeNull();
  });
});

// ---------------------------------------------------------------- start a new video

describe("'Start a new video' (the hero's button)", () => {
  it("opens the link box in place and focuses it; Escape collapses it, keeps the typed URL and returns focus to the button", async () => {
    const user = userEvent.setup();
    renderDashboard();
    await screen.findByTestId("your-progress");
    expect(document.getElementById("add-video")).toBeNull();
    const toggle = within(hero()).getByRole("button", { name: "Start a new video" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const input = document.getElementById("add-video-url") as HTMLInputElement;
    expect(hero()).toContainElement(input); // inside the hero, not elsewhere
    expect(document.activeElement).toBe(input);
    expect(screen.getAllByRole("textbox", { name: "YouTube URL" })).toHaveLength(1); // never a second form
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled(); // right under the button — no scroll jump
    await user.type(input, "https://youtu.be/abc");
    await user.keyboard("{Escape}");
    expect(document.getElementById("add-video")).toBeNull();
    expect(document.activeElement).toBe(toggle);
    await user.click(toggle);
    expect((document.getElementById("add-video-url") as HTMLInputElement).value).toBe("https://youtu.be/abc");
    // Clicking the button again collapses it too.
    await user.click(toggle);
    expect(document.getElementById("add-video")).toBeNull();
    expect(calls.some((c) => !c.startsWith("GET "))).toBe(false);
  });
});

// ---------------------------------------------------------------- cache, invalidation, isolation

describe("cache and invalidation", () => {
  it("background refetch keeps the sentences and the Today row (no placeholder while refetching)", async () => {
    const { client } = renderDashboard();
    await screen.findByTestId("today-row-sentences");
    const releaseContinue = gate("continue");
    const releaseVocab = gate("vocab");
    await act(async () => {
      invalidateLearningViews(client, "user-1");
      invalidateVocabularyQueries(client, "user-1");
    });
    expect(screen.getByTestId("today-row-sentences")).toBeInTheDocument();
    expect(screen.getByTestId("continue-sentences")).toHaveTextContent("3 sentences need another look");
    await act(async () => {
      releaseContinue();
      releaseVocab();
    });
  });

  it("a practice write's invalidateLearningViews (no roundIds needed) updates the count; clearing it removes the section and the row", async () => {
    const { client } = renderDashboard();
    expect(await screen.findByTestId("continue-sentences")).toHaveTextContent("3 sentences need another look");
    responses.continue = page([item("vNeeds", { correct: 7, practiced: 8 })], "continue");
    await act(async () => invalidateLearningViews(client, "user-1"));
    await waitFor(() => expect(screen.getByTestId("today-row-sentences")).toHaveTextContent("1 sentence needs another look"));
    expect(screen.getByTestId("continue-sentences")).toHaveTextContent("1 sentence needs another look");
    responses.continue = page([item("vNeeds", { correct: 8, practiced: 8 })], "continue");
    responses.vocab = statsOf({ due: 4, reviewable: 4 });
    await act(async () => {
      invalidateLearningViews(client, "user-1");
      invalidateVocabularyQueries(client, "user-1");
    });
    await waitFor(() => expect(screen.getByTestId("today-row-words")).toHaveTextContent("4 words are due"));
    expect(screen.queryByTestId("continue-sentences")).toBeNull();
    expect(todayRow("sentences")).toBeNull();
  });

  it("another account never sees this account's cached Continue round", async () => {
    const client = newClient();
    client.setQueryData(videoLibraryKeys.continueLearning("user-1"), page([NEEDS], "continue"));
    authUser = { id: "user-2", email: "other@example.test" } as User;
    responses.continue = page([CLEAN], "continue");
    renderDashboard(client);
    await screen.findByTestId("continue-card-vClean");
    expect(document.body.textContent).not.toContain("need another look");
  });
});
