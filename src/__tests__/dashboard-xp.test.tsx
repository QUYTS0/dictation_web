/**
 * Phase 5 of the dashboard redesign (.claude/dashboard-redesign-plan.md §1,
 * §3.3, §4.5.5, §4.5.7): the level curve, the hero's level bar, XP on the
 * weekly track and the full day details, goal-met / level-up celebrations
 * and the Monday recap.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { User } from "@supabase/supabase-js";
import type { DashboardSummary, DashboardWeek, DashboardWeekDay, LibraryPage } from "@/lib/types/learning";
import type { XpDay, XpSummary } from "@/lib/types/xp";
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
// The app shell (incl. the header XP pill) is covered by app-shell.test.tsx.
jest.mock("@/components/AppFooter", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/AppHeader", () => ({ __esModule: true, default: () => null }));

import DashboardPage from "@/app/dashboard/page";
import { ToastProvider } from "@/components/ToastProvider";
import { WeeklyTrack } from "@/app/dashboard/components/WeeklyTrack";
import { LevelProgress } from "@/app/dashboard/components/LevelProgress";
import { weeklyRecapText } from "@/app/dashboard/components/WeeklyRecapBanner";
import { pickCelebrations } from "@/lib/dashboard/celebrations";
import { dayDetails } from "@/lib/dashboard/week";
import { levelForXp, levelProgress, xpForLevel } from "@/lib/xp/levels";
import { addDaysToKey } from "@/lib/utils/streak";

// ---------------------------------------------------------------- fixtures

function weekOf(over: Partial<DashboardWeek> = {}, dayOver: Record<string, Partial<DashboardWeekDay>> = {}): DashboardWeek {
  const days = Array.from({ length: 14 }, (_, i): DashboardWeekDay => {
    const date = addDaysToKey("2026-11-12", i);
    return { date, practiced: false, activeSec: 0, ...dayOver[date] };
  });
  return { timeZone: "Asia/Ho_Chi_Minh", today: "2026-11-25", weekStart: "2026-11-23", days, goalMinutes: 15, goalIsDefault: true, ...over };
}
const WEEK = weekOf({}, { "2026-11-23": { practiced: true, activeSec: 1325 }, "2026-11-24": { practiced: true, activeSec: 0 }, "2026-11-25": { practiced: true, activeSec: 660 } });

const NONE = { dictationSentences: 0, shadowingSentences: 0, wordsReviewed: 0, listeningMin: 0 };
function xpOf(over: Partial<XpSummary> = {}, dayOver: Record<string, Partial<XpDay>> = {}): XpSummary {
  const days = Array.from({ length: 14 }, (_, i): XpDay => {
    const date = addDaysToKey("2026-11-12", i);
    return { date, xp: 0, activity: NONE, ...dayOver[date] };
  });
  const totalXp = over.totalXp ?? 4850;
  const { level, levelStartXp, nextLevelXp } = levelProgress(totalXp);
  return {
    rulesVersion: 1,
    timeZone: "Asia/Ho_Chi_Minh",
    xpTimeZone: "Asia/Ho_Chi_Minh",
    today: "2026-11-25",
    totalXp,
    todayXp: 40,
    level,
    levelStartXp,
    nextLevelXp,
    leagueWeekStart: "2026-11-23T00:00:00+00:00",
    leagueWeekXp: 300,
    lastLeagueWeek: { weekStart: "2026-11-16", xp: 1240, activeSec: 5760, wordsReviewed: 41 },
    days,
    ...over,
  };
}
const XP = xpOf(
  {},
  {
    "2026-11-23": { xp: 140, activity: { dictationSentences: 18, shadowingSentences: 6, wordsReviewed: 12, listeningMin: 0 } },
    "2026-11-24": { xp: 13, activity: { ...NONE, wordsReviewed: 1 } },
    "2026-11-25": { xp: 40, activity: { ...NONE, dictationSentences: 1 } },
  }
);

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
  streakDays: 3,
  streakTimeZone: "Asia/Ho_Chi_Minh",
  streakToday: "2026-11-25",
  streakActiveToday: true,
  streakIncludesUtcFallback: false,
  recentVocabulary: [],
  ...over,
});

// ---------------------------------------------------------------- page harness

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
const emptyPage: LibraryPage = { items: [], total: 0, limit: 1, offset: 0, filter: "continue", hasMore: false };
let weekResponse: DashboardWeek;
let xpResponse: XpSummary | "unavailable";

beforeEach(() => {
  weekResponse = WEEK;
  xpResponse = XP;
  window.localStorage.clear();
  window.sessionStorage.clear();
  Element.prototype.scrollIntoView = jest.fn();
  window.matchMedia = jest.fn().mockReturnValue({ matches: false }) as unknown as typeof window.matchMedia;
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/dashboard/summary")) return json(summaryOf());
    if (url.startsWith("/api/dashboard/week")) return json(weekResponse);
    if (url.startsWith("/api/xp")) return xpResponse === "unavailable" ? json({ code: "learning_data_unavailable" }, 503) : json(xpResponse);
    if (url.startsWith("/api/videos/library?")) return json(emptyPage);
    if (url.startsWith("/api/dashboard/error-patterns")) return json({ total: 0, patterns: [] });
    if (url.startsWith("/api/vocabulary/stats")) return json({ total: 0, new: 0, learning: 0, due: 0, reviewable: 0 } satisfies VocabularyStatsResponse);
    if (url.startsWith("/api/vocabulary/review")) return json({ items: [] });
    return json({}, 404);
  }) as typeof fetch;
});

const renderDashboard = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <DashboardPage />
      </ToastProvider>
    </QueryClientProvider>
  );
const memory = () => JSON.parse(window.localStorage.getItem("dictalearn:celebrations:user-1") ?? "null");
const confettiPieces = (hero: HTMLElement) => hero.querySelectorAll("span.rounded-sm").length;

// ---------------------------------------------------------------- levels

describe("level curve (50·L·(L−1))", () => {
  it("thresholds and boundaries", () => {
    expect([1, 2, 5, 10, 20].map(xpForLevel)).toEqual([0, 100, 1000, 4500, 19000]);
    expect([0, 99, 100, 999, 1000, 4499, 4500, 18999, 19000, 1_000_000].map(levelForXp)).toEqual([1, 1, 2, 4, 5, 9, 10, 19, 20, 141]);
    // Every exact threshold up to level 200 lands on its level (no float off-by-one).
    for (let l = 1; l <= 200; l++) {
      expect(levelForXp(xpForLevel(l))).toBe(l);
      if (l > 1) expect(levelForXp(xpForLevel(l) - 1)).toBe(l - 1);
    }
  });

  it("progress through the current level", () => {
    expect(levelProgress(4850)).toEqual({ level: 10, levelStartXp: 4500, nextLevelXp: 5500, pct: 35 });
    expect(levelProgress(0)).toMatchObject({ level: 1, levelStartXp: 0, nextLevelXp: 100, pct: 0 });
    expect(levelProgress(-5).level).toBe(1);
  });

  it("the hero's level bar: 'Level 10 · 4,850 / 5,500 XP'", () => {
    render(<LevelProgress xp={XP} />);
    const bar = screen.getByTestId("hero-level");
    expect(bar).toHaveTextContent("Level 10");
    expect(screen.getByTestId("hero-level-xp")).toHaveTextContent("4,850 XP of 5,500 for level 11");
  });
});

// ---------------------------------------------------------------- weekly track

describe("WeeklyTrack with XP (plan §4.5.5, full)", () => {
  it("each day shows its XP; buttons are named with the time and the XP", () => {
    render(<WeeklyTrack week={WEEK} xp={XP} />);
    expect(screen.getByTestId("track-day-2026-11-23")).toHaveTextContent("+140");
    expect(screen.getByTestId("track-day-2026-11-25")).toHaveTextContent("+40");
    expect(screen.getByTestId("track-day-2026-11-26")).not.toHaveTextContent("+");
    expect(screen.getByRole("button", { name: "Mon, Nov 23: practiced, 22 min, +140 XP" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tue, Nov 24: practiced, +13 XP" })).toBeInTheDocument();
  });

  it("the day details list time, sentences and words, then the XP; zero values are left out", () => {
    render(<WeeklyTrack week={WEEK} xp={XP} />);
    fireEvent.mouseEnter(screen.getByRole("button", { name: /^Mon, Nov 23/ }));
    const details = screen.getByTestId("day-details");
    expect(details).toHaveTextContent("Mon, Nov 23");
    expect(details).toHaveTextContent("22 min · 18 Dictation sentences · 6 Shadowing sentences · 12 words reviewed");
    expect(details).toHaveTextContent("+140 XP");
    expect(details).not.toHaveTextContent("Active");

    fireEvent.mouseEnter(screen.getByRole("button", { name: /^Tue, Nov 24/ }));
    expect(screen.getByTestId("day-details")).toHaveTextContent(/^Tue, Nov 241 word reviewed\+13 XP$/);
  });

  it("dayDetails: only time → 'Active'; nothing → 'Active'; no XP → no XP line", () => {
    const day = { date: "2026-11-23", practiced: true, activeSec: 1325 };
    expect(dayDetails(day, { date: day.date, xp: 22, activity: NONE })).toEqual({ parts: ["22 min", "Active"], xpLabel: "+22 XP" });
    expect(dayDetails({ ...day, activeSec: 0 }, undefined)).toEqual({ parts: ["Active"], xpLabel: null });
    expect(dayDetails(day, { date: day.date, xp: 0, activity: { ...NONE, dictationSentences: 1 } })).toEqual({ parts: ["22 min", "1 Dictation sentence"], xpLabel: null });
  });
});

// ---------------------------------------------------------------- celebrations

describe("pickCelebrations (plan §4.5.7)", () => {
  const empty = { goalDate: null, level: null };
  it("the goal is celebrated once per local date", () => {
    const first = pickCelebrations(empty, { today: "2026-11-25", goalMet: true, level: null });
    expect(first).toMatchObject({ goal: true, next: { goalDate: "2026-11-25" } });
    expect(pickCelebrations(first.next, { today: "2026-11-25", goalMet: true, level: null }).goal).toBe(false);
    expect(pickCelebrations(first.next, { today: "2026-11-26", goalMet: true, level: null }).goal).toBe(true);
    expect(pickCelebrations(empty, { today: "2026-11-25", goalMet: false, level: null }).goal).toBe(false);
    expect(pickCelebrations(empty, { today: null, goalMet: true, level: null }).goal).toBe(false);
  });

  it("the first level seen is only remembered; a gain is celebrated once; a drop is followed silently", () => {
    const seen = pickCelebrations(empty, { today: null, goalMet: false, level: 10 });
    expect(seen).toMatchObject({ levelUp: null, next: { level: 10 } });
    const up = pickCelebrations(seen.next, { today: null, goalMet: false, level: 11 });
    expect(up).toMatchObject({ levelUp: 11, next: { level: 11 } });
    expect(pickCelebrations(up.next, { today: null, goalMet: false, level: 11 }).levelUp).toBeNull();
    expect(pickCelebrations(up.next, { today: null, goalMet: false, level: 9 })).toMatchObject({ levelUp: null, next: { level: 9 } });
    // XP unavailable: the remembered level is kept.
    expect(pickCelebrations(up.next, { today: null, goalMet: false, level: null }).next.level).toBe(11);
  });
});

describe("celebrations on the Dashboard", () => {
  it("goal met and a new level: two toasts and one confetti burst in the hero — once; the next visit is quiet", async () => {
    window.localStorage.setItem("dictalearn:celebrations:user-1", JSON.stringify({ goalDate: "2026-11-24", level: 9 }));
    weekResponse = weekOf({ goalMinutes: 10 }, { "2026-11-25": { practiced: true, activeSec: 660 } });
    const first = renderDashboard();
    expect(await screen.findByText("Daily goal met!")).toBeInTheDocument();
    expect(await screen.findByText("Level 10 reached")).toBeInTheDocument();
    const hero = screen.getByTestId("dashboard-welcome");
    await waitFor(() => expect(confettiPieces(hero)).toBeGreaterThan(0));
    expect(memory()).toEqual({ goalDate: "2026-11-25", level: 10 });
    first.unmount();

    renderDashboard();
    await screen.findByTestId("hero-level");
    await act(async () => {});
    expect(screen.queryByText("Daily goal met!")).toBeNull();
    expect(screen.queryByText("Level 10 reached")).toBeNull();
    expect(confettiPieces(screen.getByTestId("dashboard-welcome"))).toBe(0);
  });

  it("a learner's first visit only remembers their level — no level-up for the level they already had", async () => {
    renderDashboard();
    await screen.findByTestId("hero-level");
    await waitFor(() => expect(memory()).toMatchObject({ level: 10 }));
    expect(screen.queryByText(/reached/)).toBeNull();
  });

  it("reduced motion: the toast still shows, nothing animates", async () => {
    window.matchMedia = jest.fn().mockReturnValue({ matches: true }) as unknown as typeof window.matchMedia;
    weekResponse = weekOf({ goalMinutes: 10 }, { "2026-11-25": { practiced: true, activeSec: 660 } });
    renderDashboard();
    expect(await screen.findByText("Daily goal met!")).toBeInTheDocument();
    await act(async () => {});
    expect(confettiPieces(screen.getByTestId("dashboard-welcome"))).toBe(0);
  });

  it("the hero shows the level bar and XP under each day; without XP (048 not applied) both are left out", async () => {
    const view = renderDashboard();
    const hero = await screen.findByTestId("dashboard-welcome");
    expect(await within(hero).findByTestId("hero-level")).toHaveTextContent("Level 10");
    expect(within(hero).getByTestId("track-day-2026-11-23")).toHaveTextContent("+140");
    view.unmount();

    xpResponse = "unavailable";
    renderDashboard();
    const hero2 = await screen.findByTestId("dashboard-welcome");
    await within(hero2).findByTestId("weekly-track");
    await act(async () => {});
    expect(within(hero2).queryByTestId("hero-level")).toBeNull();
    expect(within(hero2).getByTestId("track-day-2026-11-23")).toHaveTextContent("22m"); // minutes instead
  });
});

// ---------------------------------------------------------------- Monday recap

describe("Monday recap (plan §4.5.7, XP part)", () => {
  it("text: XP, minutes and words, zero parts left out", () => {
    expect(weeklyRecapText(XP.lastLeagueWeek)).toBe("Last week: 1,240 XP · 96 min · 41 words reviewed");
    expect(weeklyRecapText({ weekStart: "2026-11-16", xp: 13, activeSec: 30, wordsReviewed: 1 })).toBe("Last week: 13 XP · 1 word reviewed");
  });

  it("shown above the hero on the first visit of a league week, dismissible; not again that week", async () => {
    const first = renderDashboard();
    const recap = await screen.findByTestId("weekly-recap");
    expect(recap).toHaveTextContent("Last week: 1,240 XP · 96 min · 41 words reviewed");
    expect(recap.compareDocumentPosition(screen.getByTestId("dashboard-welcome")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(within(recap).getByRole("button", { name: "Dismiss last week's summary" }));
    expect(screen.queryByTestId("weekly-recap")).toBeNull();
    first.unmount();

    renderDashboard();
    await screen.findByTestId("hero-level");
    await act(async () => {});
    expect(screen.queryByTestId("weekly-recap")).toBeNull();
  });

  it("a new league week shows it again; a week without activity never shows it", async () => {
    window.localStorage.setItem("dictalearn:weekly-recap-seen:user-1", "2026-11-16");
    const view = renderDashboard();
    expect(await screen.findByTestId("weekly-recap")).toBeInTheDocument();
    view.unmount();

    window.localStorage.clear();
    xpResponse = xpOf({ lastLeagueWeek: { weekStart: "2026-11-16", xp: 0, activeSec: 0, wordsReviewed: 0 } });
    renderDashboard();
    await screen.findByTestId("hero-level");
    await act(async () => {});
    expect(screen.queryByTestId("weekly-recap")).toBeNull();
    expect(window.localStorage.getItem("dictalearn:weekly-recap-seen:user-1")).toBeNull();
  });
});
