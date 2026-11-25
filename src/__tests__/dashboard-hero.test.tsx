/**
 * Phase 2 of the dashboard redesign (.claude/dashboard-redesign-plan.md
 * §4.5.1–4.5.3, §4.5.6): the streak status line, the first-run Dashboard,
 * the Continue card's per-mode bars + resume point, Learning performance,
 * and formatLastActive.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { User } from "@supabase/supabase-js";
import type { DashboardSummary, LibraryItem, LibraryPage } from "@/lib/types/learning";
import type { VocabularyStatsResponse } from "@/lib/types";

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
// The app shell is covered by app-shell.test.tsx.
jest.mock("@/components/AppFooter", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/AppHeader", () => ({ __esModule: true, default: () => null }));

import DashboardPage from "@/app/dashboard/page";
import { STREAK_URGENT_HOUR, StreakStatusLine, streakStatus } from "@/app/dashboard/components/StreakStatusLine";
import { ContinueLearningCard } from "@/app/dashboard/components/ContinueLearningCard";
import { LearningPerformance } from "@/app/dashboard/components/LearningPerformance";
import { formatLastActive } from "@/lib/utils/time";

// ---------------------------------------------------------------- fixtures

const summaryOf = (over: Partial<DashboardSummary> = {}): DashboardSummary => ({
  completedVideos: 0,
  legacyCompletedVideos: 0,
  inProgressVideos: 1,
  listenedThroughVideos: 0,
  libraryVideos: 2,
  sentenceAccuracy: { correct: 3, practiced: 4, excludedUnverified: 0 },
  shadowing: {
    takes: 0,
    practicedSentences: 0,
    attemptedSentences: 0,
    azure: { evaluatedSentences: 0, pronunciation: null, accuracy: null, completeness: null, fluency: null, prosody: null },
    wordMatch: { evaluatedSentences: 0, accuracy: null, completeness: null },
  },
  activeTime: { activeSec: 1200, trackedSince: "2026-09-30T00:00:00Z", sessionCount: 3 },
  vocabularyCount: 4,
  streakDays: 0,
  streakTimeZone: "UTC",
  streakToday: "2026-11-25",
  streakActiveToday: false,
  streakIncludesUtcFallback: false,
  recentVocabulary: [],
  ...over,
});

const EMPTY = summaryOf({ libraryVideos: 0, vocabularyCount: 0, inProgressVideos: 0, activeTime: { activeSec: 0, trackedSince: null, sessionCount: 0 } });

function item(over: Partial<LibraryItem> = {}): LibraryItem {
  return {
    videoId: "vid1",
    title: "Why do some people have a better sense of direction?",
    addedAt: "2026-11-01T00:00:00Z",
    lastActivityAt: "2026-11-24T10:00:00Z",
    lastMode: "dictation",
    state: "in_progress",
    hasCompletedRound: false,
    hasLegacyCompletion: false,
    completedRoundCount: 1,
    round: {
      roundId: "round-1",
      status: "active",
      provenance: "current",
      roundNumber: 2,
      transcriptId: "tr",
      startedAt: "2026-11-01T00:00:00Z",
      completedAt: null,
      currentSegmentIndex: 12,
      progress: {
        requiredSentenceCount: 58,
        coveredSentences: { dictation: 12, shadowing: 8, overall: 15 },
        coverage: { dictation: 12 / 58, shadowing: 8 / 58, overall: 15 / 58 },
        attemptCount: 14,
        sentenceAccuracy: { correct: 10, practiced: 12, percent: null },
      },
    },
    listening: { transcriptId: "tr", coverageRatio: 0.57, listenedThrough: false, lastPositionSec: 120, hasHistory: true, historyOnOtherRevision: false },
    ...over,
  };
}

// ---------------------------------------------------------------- page harness

const page = (items: LibraryItem[]): LibraryPage => ({ items, total: items.length, limit: 1, offset: 0, filter: "continue", hasMore: false });
const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
let summaryResponse: DashboardSummary | "fail" | Promise<void>;
let continueItems: LibraryItem[];
let summaryGate: Promise<void> | null;

beforeEach(() => {
  authUser = { id: "user-1", email: "learner@example.test" } as User;
  summaryResponse = summaryOf();
  continueItems = [item()];
  summaryGate = null;
  window.sessionStorage.clear();
  Element.prototype.scrollIntoView = jest.fn();
  window.matchMedia = jest.fn().mockReturnValue({ matches: false }) as unknown as typeof window.matchMedia;
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/dashboard/summary")) {
      if (summaryGate) await summaryGate;
      return summaryResponse === "fail" ? json({ error: "boom" }, 500) : json(summaryResponse);
    }
    if (url.startsWith("/api/videos/library?")) return json(page(continueItems));
    if (url.startsWith("/api/dashboard/error-patterns")) return json({ total: 0, patterns: [] });
    if (url.startsWith("/api/vocabulary/stats")) return json({ total: 0, new: 0, learning: 0, due: 0, reviewable: 0 } satisfies VocabularyStatsResponse);
    return json({}, 404);
  }) as typeof fetch;
});

const renderDashboard = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <DashboardPage />
    </QueryClientProvider>
  );

// ---------------------------------------------------------------- streak status line

describe("streakStatus (plan §4.5.2)", () => {
  // 2026-11-25 in Asia/Ho_Chi_Minh (UTC+7): 10:00 local = 03:00Z, 19:00 local = 12:00Z.
  const morning = new Date("2026-11-25T03:00:00Z");
  const evening = new Date("2026-11-25T12:00:00Z");
  const base = { streakDays: 12, streakActiveToday: false, streakToday: "2026-11-25", streakTimeZone: "Asia/Ho_Chi_Minh" };

  it("no streak → a neutral line with no streak claim", () => {
    expect(streakStatus({ ...base, streakDays: 0 }, morning)).toEqual({ tone: "neutral", text: "Ready for today's practice?" });
  });

  it("already practiced today → done", () => {
    expect(streakStatus({ ...base, streakActiveToday: true }, evening)).toEqual({ tone: "done", text: "12-day streak · today is done" });
  });

  it(`not practiced yet: a nudge before ${STREAK_URGENT_HOUR}:00 local, the urgent line from then on`, () => {
    expect(streakStatus(base, morning)).toEqual({ tone: "nudge", text: "Keep your 12-day streak going today." });
    expect(streakStatus(base, evening).tone).toBe("urgent");
    expect(streakStatus(base, evening).text).toBe("Your 12-day streak ends at midnight. One sentence or one word review keeps it going.");
    // 17:59 local is still a nudge; 18:00 local is urgent.
    expect(streakStatus(base, new Date("2026-11-25T10:59:00Z")).tone).toBe("nudge");
    expect(streakStatus(base, new Date("2026-11-25T11:00:00Z")).tone).toBe("urgent");
  });

  it("the hour is the streak's own zone, not the machine's", () => {
    // 12:00Z is 07:00 in New York — morning there.
    expect(streakStatus({ ...base, streakTimeZone: "America/New_York" }, new Date("2026-11-25T12:00:00Z")).tone).toBe("nudge");
  });

  it("the page outlived the summary's day (past midnight) → no streak claim until it refetches", () => {
    expect(streakStatus(base, new Date("2026-11-26T03:00:00Z"))).toEqual({ tone: "neutral", text: "Ready for today's practice?" });
  });

  it("the rendered line re-reads the clock when the learner returns to the tab", () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] });
    try {
      jest.setSystemTime(morning);
      render(<StreakStatusLine summary={summaryOf({ ...base })} />);
      expect(screen.getByTestId("streak-status")).toHaveAttribute("data-tone", "nudge");
      jest.setSystemTime(evening);
      act(() => {
        fireEvent.focus(window);
      });
      expect(screen.getByTestId("streak-status")).toHaveAttribute("data-tone", "urgent");
    } finally {
      jest.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------- first run

describe("first-run Dashboard (plan §4.5.3)", () => {
  it("nothing yet (no videos, sessions or words) → only the first-run hero with the link box and three steps", async () => {
    summaryResponse = EMPTY;
    continueItems = [];
    renderDashboard();
    const hero = await screen.findByTestId("first-run");
    expect(within(hero).getByRole("heading", { name: "Welcome to DictaLearn" })).toBeInTheDocument();
    const input = within(hero).getByRole("textbox", { name: "YouTube URL" });
    expect(input).toHaveAttribute("id", "add-video-url");
    expect(document.activeElement).not.toBe(input); // not autofocused on page load
    expect(within(within(hero).getByRole("list", { name: "How it works" })).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      expect.stringContaining("Listen"),
      expect.stringContaining("Type what you hear"),
      expect.stringContaining("Repeat aloud"),
    ]);
    for (const gone of ["dashboard-welcome", "continue-learning", "dashboard-focus", "your-progress", "vocabulary-card", "needs-attention"]) {
      expect(screen.queryByTestId(gone)).toBeNull();
    }
  });

  it("history but no videos (all removed) → the normal Dashboard", async () => {
    summaryResponse = { ...EMPTY, activeTime: { activeSec: 300, trackedSince: "2026-09-30T00:00:00Z", sessionCount: 1 } };
    continueItems = [];
    renderDashboard();
    expect(await screen.findByTestId("dashboard-welcome")).toBeInTheDocument();
    expect(screen.queryByTestId("first-run")).toBeNull();
  });

  it("saved words but no videos or sessions → the normal Dashboard", async () => {
    summaryResponse = { ...EMPTY, vocabularyCount: 3 };
    continueItems = [];
    renderDashboard();
    expect(await screen.findByTestId("dashboard-welcome")).toBeInTheDocument();
    expect(screen.queryByTestId("first-run")).toBeNull();
  });

  it("summary failed → never first-run (unknown is not 'nothing yet')", async () => {
    summaryResponse = "fail";
    continueItems = [];
    renderDashboard();
    expect(await screen.findByText(/Failed to load your progress/)).toBeInTheDocument();
    expect(screen.queryByTestId("first-run")).toBeNull();
    expect(screen.getByTestId("dashboard-welcome")).toBeInTheDocument();
  });

  it("while the summary loads, the hero is a placeholder — never a premature 'Welcome back'", async () => {
    let release!: () => void;
    summaryGate = new Promise<void>((r) => (release = r));
    summaryResponse = EMPTY;
    continueItems = [];
    renderDashboard();
    expect(screen.getByLabelText("Loading your dashboard")).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText(/Welcome back/)).toBeNull();
    await act(async () => release());
    expect(await screen.findByTestId("first-run")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------- Continue card

describe("Continue card: per-mode bars + resume point (plan §1, §4.5.6)", () => {
  it("Dictation, Shadowing and Listening each show their own coverage; the round's overall number heads the panel", () => {
    render(<ContinueLearningCard item={item()} />);
    const card = screen.getByTestId("continue-card-vid1");
    expect(within(card).getByTestId("continue-coverage")).toHaveTextContent("15/58 sentences practiced");
    expect(card).toHaveTextContent("Round 2 progress");
    expect(card).toHaveTextContent(/Dictation\s*12\/58/);
    expect(card).toHaveTextContent(/Shadowing\s*8\/58/);
    expect(within(card).getByTestId("continue-listening")).toHaveTextContent("Listened 57%");
  });

  it("resume point is the 0-based index shown +1, without a total (the required count skips empty segments)", () => {
    render(<ContinueLearningCard item={item()} />);
    expect(screen.getByTestId("continue-resume")).toHaveTextContent("Resume at sentence 13");
    expect(screen.getByTestId("continue-resume").textContent).not.toMatch(/of \d/);
  });

  it("no resume point for an untouched round or a Listening-only item", () => {
    const fresh = item();
    fresh.round = { ...fresh.round!, currentSegmentIndex: 0, progress: { ...fresh.round!.progress, coveredSentences: { dictation: 0, shadowing: 0, overall: 0 } } };
    const { unmount } = render(<ContinueLearningCard item={fresh} />);
    expect(screen.queryByTestId("continue-resume")).toBeNull();
    unmount();

    render(<ContinueLearningCard item={item({ round: null, state: "listening", lastMode: null })} />);
    expect(screen.queryByTestId("continue-resume")).toBeNull();
    expect(screen.queryByTestId("continue-coverage")).toBeNull();
    expect(screen.getByTestId("continue-listening")).toHaveTextContent("Listened 57%");
    expect(screen.getByRole("link", { name: /Continue learning/ })).toHaveAttribute("href", "/dictation/vid1?mode=listening");
  });

  it("meta line: last mode · round · when last practiced", () => {
    render(<ContinueLearningCard item={item({ lastActivityAt: new Date().toISOString() })} />);
    expect(screen.getByTestId("continue-meta")).toHaveTextContent("Dictation · Round 2 · Last practiced today");
  });
});

// ---------------------------------------------------------------- Learning performance

describe("Learning performance", () => {
  it("three cards with their own numbers, a tracked-since line, and '/ 100' only next to a real score", () => {
    const { unmount } = render(<LearningPerformance summary={summaryOf()} />);
    const section = screen.getByTestId("your-progress");
    expect(within(section).getByRole("heading", { name: "Learning performance" })).toBeInTheDocument();
    expect(section).toHaveTextContent("Tracked since");
    expect(screen.getByTestId("progress-active")).toHaveTextContent("Across 3 study sessions");
    expect(screen.getByTestId("progress-pronunciation")).toHaveTextContent("—");
    expect(screen.getByTestId("progress-pronunciation")).not.toHaveTextContent("/ 100");
    unmount();

    const scored = summaryOf();
    scored.shadowing = { ...scored.shadowing, azure: { ...scored.shadowing.azure, evaluatedSentences: 5, pronunciation: 82.94 } };
    render(<LearningPerformance summary={scored} />);
    expect(screen.getByTestId("progress-pronunciation")).toHaveTextContent("82.9");
    expect(screen.getByTestId("progress-pronunciation")).toHaveTextContent("/ 100");
  });
});

// ---------------------------------------------------------------- formatLastActive

describe("formatLastActive", () => {
  const now = new Date(2026, 10, 25, 9, 0); // local Nov 25, 09:00
  it("local calendar days, not 24-hour blocks", () => {
    expect(formatLastActive(new Date(2026, 10, 25, 0, 5).toISOString(), now)).toBe("today");
    expect(formatLastActive(new Date(2026, 10, 24, 23, 55).toISOString(), now)).toBe("yesterday");
    expect(formatLastActive(new Date(2026, 10, 20, 12, 0).toISOString(), now)).toBe("5 days ago");
  });
  it("a date from 30 days on; future (clock skew) is today; invalid is null", () => {
    expect(formatLastActive(new Date(2026, 8, 1).toISOString(), now)).toMatch(/2026/);
    expect(formatLastActive(new Date(2026, 10, 26).toISOString(), now)).toBe("today");
    expect(formatLastActive("not a date", now)).toBeNull();
  });
});
