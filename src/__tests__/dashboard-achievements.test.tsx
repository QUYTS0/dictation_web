/**
 * Phase 6 of the dashboard redesign (.claude/dashboard-redesign-plan.md §1,
 * §3.4): the trophy case and its detail dialog, unlock toasts, the
 * diagnostics/achievements row, and the header streak popover's goal status
 * and next milestone.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import type { User } from "@supabase/supabase-js";
import type { DashboardSummary, DashboardWeek, DashboardWeekDay, LibraryPage } from "@/lib/types/learning";
import type { AchievementsResponse, AchievementTrack } from "@/lib/types/achievements";
import type { VocabularyStatsResponse } from "@/lib/types";

const authUser = { id: "user-1", email: "learner@example.test", user_metadata: {} } as unknown as User;
jest.mock("@/context/auth", () => ({
  useAuth: () => ({ user: authUser, loading: false, openAuthModal: jest.fn(), signOut: jest.fn() }),
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
jest.mock("@/components/AppFooter", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/AppHeader", () => ({ __esModule: true, default: () => null }));

import DashboardPage from "@/app/dashboard/page";
import { AchievementsCase } from "@/app/dashboard/components/AchievementsCase";
import { AchievementUnlockNotifier, unlockToasts } from "@/components/AchievementUnlockNotifier";
import { StreakPill } from "@/components/StreakPill";
import { ToastProvider } from "@/components/ToastProvider";
import { TRACKS, nextStreakMilestone, trackStatus } from "@/lib/achievements/catalog";
import { useAchievementsQuery } from "@/lib/queries/achievements";
import { addDaysToKey } from "@/lib/utils/streak";

// ---------------------------------------------------------------- fixtures

const UNLOCKED = "2026-11-20T08:00:00Z";
const tiers = (thresholds: number[], unlocked: number) =>
  thresholds.map((threshold, i) => ({ tier: (i + 1) as 1 | 2 | 3 | 4, threshold, unlockedAt: i < unlocked ? UNLOCKED : null }));
const TRACK_LIST: AchievementTrack[] = [
  { track: "flame_keeper", value: 9, tiers: tiers([3, 7, 14, 30], 2) },
  { track: "precision_typist", value: 140, tiers: tiers([25, 100, 250, 500], 2) },
  { track: "shadow_master", value: 4, tiers: tiers([10, 50, 150, 400], 0) },
  { track: "lexicon", value: 520, tiers: tiers([25, 100, 250, 500], 4) },
  { track: "immersion", value: 1.02, tiers: tiers([1, 5, 20, 50], 1) },
];
const response = (over: Partial<AchievementsResponse> = {}): AchievementsResponse => ({ tracks: TRACK_LIST, newlyUnlocked: [], ...over });

function weekOf(dayOver: Record<string, Partial<DashboardWeekDay>> = {}): DashboardWeek {
  const days = Array.from({ length: 14 }, (_, i): DashboardWeekDay => {
    const date = addDaysToKey("2026-11-12", i);
    return { date, practiced: false, activeSec: 0, ...dayOver[date] };
  });
  return { timeZone: "UTC", today: "2026-11-25", weekStart: "2026-11-23", days, goalMinutes: 15, goalIsDefault: true };
}

const summaryOf = (): DashboardSummary => ({
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
  streakDays: 3,
  streakTimeZone: "UTC",
  streakToday: "2026-11-25",
  streakActiveToday: true,
  streakIncludesUtcFallback: false,
  recentVocabulary: [],
});

// ---------------------------------------------------------------- harness

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
const emptyPage: LibraryPage = { items: [], total: 0, limit: 1, offset: 0, filter: "continue", hasMore: false };
let achievementsResponses: Array<AchievementsResponse | "unavailable">;
let weekResponse: DashboardWeek | "unavailable";
let calls: string[];

beforeEach(() => {
  achievementsResponses = [response()];
  weekResponse = weekOf({ "2026-11-25": { practiced: true, activeSec: 660 } });
  calls = [];
  window.localStorage.clear();
  window.sessionStorage.clear();
  Element.prototype.scrollIntoView = jest.fn();
  window.matchMedia = jest.fn().mockReturnValue({ matches: false }) as unknown as typeof window.matchMedia;
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith("/api/achievements")) {
      const next = achievementsResponses.length > 1 ? achievementsResponses.shift()! : achievementsResponses[0];
      return next === "unavailable" ? json({ code: "learning_data_unavailable" }, 503) : json(next);
    }
    if (url.startsWith("/api/dashboard/week")) return weekResponse === "unavailable" ? json({}, 503) : json(weekResponse);
    if (url.startsWith("/api/dashboard/summary")) return json(summaryOf());
    if (url.startsWith("/api/videos/library?")) return json(emptyPage);
    if (url.startsWith("/api/dashboard/error-patterns")) return json({ total: 0, patterns: [] });
    if (url.startsWith("/api/vocabulary/stats")) return json({ total: 0, new: 0, learning: 0, due: 0, reviewable: 0 } satisfies VocabularyStatsResponse);
    if (url.startsWith("/api/vocabulary/review")) return json({ items: [] });
    return json({}, 404);
  }) as typeof fetch;
});

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const withProviders = (ui: React.ReactNode, client = newClient()) => (
  <QueryClientProvider client={client}>
    <ToastProvider>
      <AchievementUnlockNotifier />
      {ui}
    </ToastProvider>
  </QueryClientProvider>
);
const achievementCalls = () => calls.filter((c) => c.startsWith("/api/achievements")).length;

// ---------------------------------------------------------------- catalog

describe("catalog helpers (presentation only)", () => {
  it("trackStatus: the highest unlocked tier, the next locked one, progress toward it", () => {
    expect(trackStatus(TRACK_LIST[0])).toMatchObject({ current: { tier: 2 }, next: { tier: 3, threshold: 14 } });
    expect(trackStatus(TRACK_LIST[0]).pct).toBeCloseTo((100 * 9) / 14);
    expect(trackStatus(TRACK_LIST[2])).toMatchObject({ current: null, next: { tier: 1 }, pct: 40 });
    expect(trackStatus(TRACK_LIST[3])).toMatchObject({ current: { tier: 4 }, next: null, pct: 100 });
  });

  it("formats: hours round down for the value and up for what's left", () => {
    expect(TRACKS.immersion.format(4.99)).toBe("4.9 h");
    expect(TRACKS.immersion.formatToGo!(3.98)).toBe("4 h");
    expect(TRACKS.flame_keeper.format(1)).toBe("1 day");
    expect(TRACKS.lexicon.format(1200)).toBe("1,200 words");
  });

  it("nextStreakMilestone: the first Flame Keeper threshold above the CURRENT streak", () => {
    expect(nextStreakMilestone(0, TRACK_LIST[0])).toEqual({ days: 3, toGo: 3 });
    expect(nextStreakMilestone(3, TRACK_LIST[0])).toEqual({ days: 7, toGo: 4 });
    expect(nextStreakMilestone(30, TRACK_LIST[0])).toBeNull();
    expect(nextStreakMilestone(5, undefined)).toBeNull();
  });

  it("unlock toasts: one each for one or two; a single summary for more", () => {
    expect(unlockToasts([])).toEqual([]);
    expect(unlockToasts([{ track: "lexicon", tier: 2, unlockedAt: UNLOCKED }])).toEqual([{ message: "Achievement unlocked", sub: "Lexicon · Silver" }]);
    const many = unlockToasts(
      (["flame_keeper", "precision_typist", "shadow_master", "lexicon", "immersion"] as const).map((track) => ({ track, tier: 1 as const, unlockedAt: UNLOCKED }))
    );
    expect(many).toEqual([{ message: "5 achievements unlocked", sub: "Flame Keeper · Bronze, Precision Typist · Bronze, Shadow Master · Bronze and 2 more" }]);
  });
});

// ---------------------------------------------------------------- trophy case

describe("AchievementsCase + detail dialog", () => {
  it("one tile per track: its tier (or Locked) and progress, named for screen readers; the tiers count", () => {
    render(<AchievementsCase tracks={TRACK_LIST} />);
    expect(screen.getByTestId("achievements-count")).toHaveTextContent("9/20 tiers");
    expect(screen.getByRole("button", { name: "Flame Keeper: Silver, 9 days of 14 days for Gold" })).toHaveAttribute("data-unlocked", "true");
    expect(screen.getByRole("button", { name: "Shadow Master: Locked, 4 sentences of 10 sentences for Bronze" })).toHaveAttribute("data-unlocked", "false");
    expect(screen.getByRole("button", { name: "Lexicon: Diamond, every tier unlocked" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Immersion: Bronze, 1 h of 5 h for Silver" })).toBeInTheDocument();
  });

  it("a tile opens its details — every tier with its date or what's left; Escape closes and returns focus to the tile", () => {
    render(<AchievementsCase tracks={TRACK_LIST} />);
    const tile = screen.getByTestId("achievement-flame_keeper");
    act(() => tile.focus());
    fireEvent.click(tile);
    const dialog = screen.getByRole("dialog", { name: "Flame Keeper" });
    expect(within(dialog).getByTestId("achievement-value")).toHaveTextContent("Longest streak: 9 days");
    expect(within(dialog).getByTestId("achievement-tier-1")).toHaveTextContent(/Bronze · 3 days\s*Unlocked Nov 20, 2026/);
    expect(within(dialog).getByTestId("achievement-tier-3")).toHaveTextContent("Gold · 14 days5 days to go");
    expect(within(dialog).getByTestId("achievement-tier-4")).toHaveTextContent("Diamond · 30 days21 days to go");
    expect(within(dialog).queryByText(/XP/)).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(tile);
  });
});

// ---------------------------------------------------------------- unlock toasts

function Reader({ id }: { id: string }) {
  const q = useAchievementsQuery("user-1");
  return <span data-testid={id}>{q.data ? "ready" : "…"}</span>;
}
function Refetch() {
  const qc = useQueryClient();
  return <button onClick={() => void qc.invalidateQueries({ queryKey: ["achievements"] })}>refetch</button>;
}

describe("AchievementUnlockNotifier", () => {
  it("toasts a response's unlocks once, however many components read it; a later response without unlocks toasts nothing", async () => {
    achievementsResponses = [response({ newlyUnlocked: [{ track: "flame_keeper", tier: 2, unlockedAt: UNLOCKED }] }), response()];
    render(
      withProviders(
        <>
          <Reader id="a" />
          <Reader id="b" />
          <Refetch />
        </>
      )
    );
    expect(await screen.findByText("Flame Keeper · Silver")).toBeInTheDocument();
    expect(screen.getAllByText("Achievement unlocked")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "refetch" }));
    await waitFor(() => expect(achievementCalls()).toBe(2));
    await act(async () => {});
    expect(screen.getAllByText("Achievement unlocked")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- the page

describe("Dashboard: diagnostics beside achievements", () => {
  it("the row is 8/4 with the trophy case on the right", async () => {
    render(withProviders(<DashboardPage />));
    const cases = await screen.findByTestId("achievements");
    const row = screen.getByTestId("dashboard-diagnostics-row");
    expect(row).toHaveClass("lg:grid-cols-12");
    expect(row).toContainElement(cases);
    expect(row).toContainElement(screen.getByTestId("needs-attention"));
    expect(screen.getByTestId("needs-attention").compareDocumentPosition(cases) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("achievements unavailable (049 not applied): no case, diagnostics take the row alone", async () => {
    achievementsResponses = ["unavailable"];
    render(withProviders(<DashboardPage />));
    await screen.findByTestId("needs-attention");
    await waitFor(() => expect(screen.queryByLabelText("Loading achievements")).toBeNull());
    expect(screen.queryByTestId("achievements")).toBeNull();
    expect(screen.getByTestId("dashboard-diagnostics-row")).not.toHaveClass("lg:grid-cols-12");
  });

  it("unlocks recorded by the Dashboard's sync are announced", async () => {
    achievementsResponses = [response({ newlyUnlocked: [{ track: "immersion", tier: 1, unlockedAt: UNLOCKED }] })];
    render(withProviders(<DashboardPage />));
    expect(await screen.findByText("Immersion · Bronze")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------- header popover

describe("StreakPill popover: today's goal and the next milestone", () => {
  it("loads them only once opened; shows minutes toward the goal and the next Flame Keeper threshold", async () => {
    render(withProviders(<StreakPill streakDays={3} userId="user-1" />));
    expect(achievementCalls()).toBe(0);
    fireEvent.click(screen.getByTestId("header-streak"));
    expect(await screen.findByTestId("streak-goal")).toHaveTextContent("Today's goal11 / 15 min");
    expect(await screen.findByTestId("streak-milestone")).toHaveTextContent("Next milestone7 days · 4 to go");
  });

  it("goal met → 'Met ✓'; past every threshold → 'All passed ✓'", async () => {
    weekResponse = weekOf({ "2026-11-25": { practiced: true, activeSec: 900 } });
    render(withProviders(<StreakPill streakDays={31} userId="user-1" />));
    fireEvent.click(screen.getByTestId("header-streak"));
    expect(await screen.findByTestId("streak-goal")).toHaveTextContent("Met ✓");
    expect(await screen.findByTestId("streak-milestone")).toHaveTextContent("All passed ✓");
  });

  it("both unavailable → just the explanation, as before", async () => {
    weekResponse = "unavailable";
    achievementsResponses = ["unavailable"];
    render(withProviders(<StreakPill streakDays={3} userId="user-1" />));
    fireEvent.click(screen.getByTestId("header-streak"));
    await waitFor(() => expect(achievementCalls()).toBe(1));
    await act(async () => {});
    expect(screen.getByText("Days in a row with practice in any mode. Practice every day to keep it going.")).toBeInTheDocument();
    expect(screen.queryByTestId("streak-goal")).toBeNull();
    expect(screen.queryByTestId("streak-milestone")).toBeNull();
  });
});
