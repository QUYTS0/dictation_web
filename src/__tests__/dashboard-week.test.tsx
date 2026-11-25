/**
 * Phase 4 of the dashboard redesign (.claude/dashboard-redesign-plan.md §1,
 * §4.5.5, D3): the weekly consistency track and its day details, Today's
 * target, the 7-day bars, and the daily goal in Profile & preferences.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { User } from "@supabase/supabase-js";
import type { DashboardSummary, DashboardWeek, DashboardWeekDay, LibraryPage } from "@/lib/types/learning";
import type { UserProfile } from "@/lib/types/profile";
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
// The app shell is covered by app-shell.test.tsx.
jest.mock("@/components/AppFooter", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/AppHeader", () => ({ __esModule: true, default: () => null }));

import DashboardPage from "@/app/dashboard/page";
import UserButton from "@/components/UserButton";
import { ToastProvider } from "@/components/ToastProvider";
import { WeeklyTrack } from "@/app/dashboard/components/WeeklyTrack";
import { TodayTarget } from "@/app/dashboard/components/TodayTarget";
import { formatDayMinutesLong, formatDayMinutesShort, goalProgress, lastSevenDays, weeklyTrack } from "@/lib/dashboard/week";
import { addDaysToKey, mondayOfKey, weekdayIndexMonday0 } from "@/lib/utils/streak";

// ---------------------------------------------------------------- fixtures

/** Wed 25 Nov 2026 is today; the week started Mon 23 Nov. */
function weekOf(over: Partial<DashboardWeek> = {}, dayOver: Record<string, Partial<DashboardWeekDay>> = {}): DashboardWeek {
  const days = Array.from({ length: 14 }, (_, i): DashboardWeekDay => {
    const date = addDaysToKey("2026-11-12", i);
    return { date, practiced: false, activeSec: 0, ...dayOver[date] };
  });
  return { timeZone: "Asia/Ho_Chi_Minh", today: "2026-11-25", weekStart: "2026-11-23", days, goalMinutes: 15, goalIsDefault: true, ...over };
}
const WEEK = weekOf(
  {},
  {
    "2026-11-19": { practiced: true, activeSec: 600 },
    "2026-11-23": { practiced: true, activeSec: 1325 }, // Mon: 22 min
    "2026-11-25": { practiced: true, activeSec: 660 }, // today: 11 min
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
  streakDays: 1,
  streakTimeZone: "Asia/Ho_Chi_Minh",
  streakToday: "2026-11-25",
  streakActiveToday: true,
  streakIncludesUtcFallback: false,
  recentVocabulary: [],
  ...over,
});

const PROFILE: UserProfile = { publicName: null, nickname: "Learner ABCDE", leaderboardHidden: false, dailyGoalMinutes: null };

// ---------------------------------------------------------------- page harness

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
const emptyPage: LibraryPage = { items: [], total: 0, limit: 1, offset: 0, filter: "continue", hasMore: false };
let weekResponse: DashboardWeek | "unavailable";
let profileResponse: UserProfile | "unavailable";
let patchFails: boolean;
let calls: Array<{ method: string; url: string; body?: unknown }>;

beforeEach(() => {
  weekResponse = WEEK;
  profileResponse = PROFILE;
  patchFails = false;
  calls = [];
  window.sessionStorage.clear();
  Element.prototype.scrollIntoView = jest.fn();
  window.matchMedia = jest.fn().mockReturnValue({ matches: false }) as unknown as typeof window.matchMedia;
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.startsWith("/api/dashboard/summary")) return json(summaryOf());
    if (url.startsWith("/api/dashboard/week")) {
      return weekResponse === "unavailable" ? json({ error: "This feature is not available yet.", code: "learning_data_unavailable" }, 503) : json(weekResponse);
    }
    if (url === "/api/profile" && method === "GET") return profileResponse === "unavailable" ? json({ error: "n/a" }, 503) : json(profileResponse);
    if (url === "/api/profile" && method === "PATCH") {
      if (patchFails) return json({ error: "boom" }, 500);
      const patch = JSON.parse(String(init?.body)) as Partial<UserProfile>;
      profileResponse = { ...PROFILE, ...patch };
      weekResponse = { ...WEEK, goalMinutes: patch.dailyGoalMinutes ?? 15, goalIsDefault: patch.dailyGoalMinutes == null };
      return json(profileResponse);
    }
    if (url.startsWith("/api/videos/library?")) return json(emptyPage);
    if (url.startsWith("/api/dashboard/error-patterns")) return json({ total: 0, patterns: [] });
    if (url.startsWith("/api/vocabulary/stats")) return json({ total: 0, new: 0, learning: 0, due: 0, reviewable: 0 } satisfies VocabularyStatsResponse);
    if (url.startsWith("/api/vocabulary/review")) return json({ items: [] });
    return json({}, 404);
  }) as typeof fetch;
});

const withProviders = (ui: React.ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ToastProvider>{ui}</ToastProvider>
  </QueryClientProvider>
);
const weekGets = () => calls.filter((c) => c.method === "GET" && c.url.startsWith("/api/dashboard/week")).length;

// ---------------------------------------------------------------- pure helpers

describe("local week arithmetic", () => {
  it("adds days across months and years, finds the weekday and the week's Monday", () => {
    expect(addDaysToKey("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDaysToKey("2026-03-01", -1)).toBe("2026-02-28");
    expect(weekdayIndexMonday0("2026-11-23")).toBe(0); // Monday
    expect(weekdayIndexMonday0("2026-11-29")).toBe(6); // Sunday
    expect(mondayOfKey("2026-11-29")).toBe("2026-11-23");
    expect(mondayOfKey("2026-11-23")).toBe("2026-11-23");
    expect(mondayOfKey("2027-01-01")).toBe("2026-12-28");
    // DST in many zones that week — calendar arithmetic doesn't care.
    expect(mondayOfKey("2026-03-08")).toBe("2026-03-02");
  });

  it("weeklyTrack: Monday–Sunday with done / missed / today / future, today's index and the active count", () => {
    const { days, activeCount, todayIndex } = weeklyTrack(WEEK);
    expect(days.map((d) => [d.weekday, d.date, d.state])).toEqual([
      ["Mon", "2026-11-23", "done"],
      ["Tue", "2026-11-24", "missed"],
      ["Wed", "2026-11-25", "today"],
      ["Thu", "2026-11-26", "future"],
      ["Fri", "2026-11-27", "future"],
      ["Sat", "2026-11-28", "future"],
      ["Sun", "2026-11-29", "future"],
    ]);
    expect(activeCount).toBe(2); // last week's Thursday is not this week
    expect(todayIndex).toBe(2);
  });

  it("goalProgress: whole minutes rounded down — met only once the goal is really reached", () => {
    const at = (sec: number, goalMinutes = 15) => goalProgress(weekOf({ goalMinutes }, { "2026-11-25": { practiced: true, activeSec: sec } }));
    expect(at(660)).toMatchObject({ minutes: 11, goalMinutes: 15, met: false });
    expect(at(899)).toMatchObject({ minutes: 14, met: false });
    expect(at(900)).toMatchObject({ minutes: 15, met: true, pct: 100 });
    expect(at(5000).pct).toBe(100);
    expect(at(0)).toMatchObject({ minutes: 0, pct: 0, met: false });
  });

  it("lastSevenDays: the 7 local days ending today, oldest first", () => {
    expect(lastSevenDays(WEEK).map((d) => d.date)).toEqual(["2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22", "2026-11-23", "2026-11-24", "2026-11-25"]);
  });

  it("minute labels", () => {
    expect([0, 30, 1325, 3900, 7200].map(formatDayMinutesShort)).toEqual(["—", "<1m", "22m", "1h05", "2h"]);
    expect([0, 30, 1325, 3900].map(formatDayMinutesLong)).toEqual(["0 min", "less than a minute", "22 min", "1 h 5 min"]);
  });
});

// ---------------------------------------------------------------- weekly track

describe("WeeklyTrack + day details (plan §4.5.5, Phase 4)", () => {
  it("count, markers and minute labels; only practiced days are buttons, each named with its date and time", () => {
    render(<WeeklyTrack week={WEEK} />);
    expect(screen.getByTestId("weekly-track-count")).toHaveTextContent("· 2/7 active");
    const list = screen.getByRole("list", { name: "This week, Monday to Sunday" });
    expect(within(list).getAllByRole("listitem").map((li) => li.dataset.state)).toEqual(["done", "missed", "today", "future", "future", "future", "future"]);
    expect(within(list).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual([
      "Mon, Nov 23: practiced, 22 min",
      "Today, Wed, Nov 25: practiced, 11 min",
    ]);
    expect(screen.getByTestId("track-day-2026-11-24")).toHaveTextContent("Tue, Nov 24: no practice");
    expect(screen.getByTestId("track-day-2026-11-24")).toHaveTextContent("—");
    expect(screen.getByTestId("track-day-2026-11-27")).toHaveTextContent("Fri, Nov 27: upcoming");
    expect(screen.getByTestId("track-day-2026-11-23")).toHaveTextContent("22m");
    expect(screen.queryByTestId("day-details")).toBeNull();
  });

  it("keyboard: focus opens the day's details (date, minutes, Active); Escape and blur close them", () => {
    render(<WeeklyTrack week={WEEK} />);
    const monday = screen.getByRole("button", { name: /^Mon, Nov 23/ });
    act(() => monday.focus());
    const details = screen.getByTestId("day-details");
    expect(details).toHaveTextContent("Mon, Nov 23");
    expect(details).toHaveTextContent("22 min · Active");
    expect(monday).toHaveAttribute("aria-expanded", "true");
    expect(monday).toHaveAttribute("aria-controls", details.id);
    fireEvent.keyDown(monday, { key: "Escape" });
    expect(screen.queryByTestId("day-details")).toBeNull();
    act(() => monday.blur());
    act(() => monday.focus());
    expect(screen.getByTestId("day-details")).toBeInTheDocument();
    act(() => monday.blur());
    expect(screen.queryByTestId("day-details")).toBeNull();
  });

  it("today is labelled as today; a practiced day with no timed minutes (word reviews only) leaves the zero out", () => {
    render(<WeeklyTrack week={weekOf({}, { "2026-11-24": { practiced: true, activeSec: 0 }, "2026-11-25": { practiced: true, activeSec: 660 } })} />);
    fireEvent.mouseEnter(screen.getByRole("button", { name: "Tue, Nov 24: practiced" }));
    expect(screen.getByTestId("day-details")).toHaveTextContent(/^Tue, Nov 24Active$/);
    fireEvent.mouseEnter(screen.getByRole("button", { name: /^Today/ }));
    expect(screen.getByTestId("day-details")).toHaveTextContent("Today · Wed, Nov 25");
  });

  it("mouse: hover shows, leaving hides; a click pins it open until clicked again or a tap outside", () => {
    render(<WeeklyTrack week={WEEK} />);
    const monday = screen.getByRole("button", { name: /^Mon, Nov 23/ });
    fireEvent.mouseEnter(monday);
    expect(screen.getByTestId("day-details")).toBeInTheDocument();
    fireEvent.mouseLeave(monday);
    expect(screen.queryByTestId("day-details")).toBeNull();

    fireEvent.mouseEnter(monday);
    fireEvent.click(monday);
    fireEvent.mouseLeave(monday);
    expect(screen.getByTestId("day-details")).toBeInTheDocument();
    fireEvent.click(monday);
    expect(screen.queryByTestId("day-details")).toBeNull();

    fireEvent.click(monday);
    expect(screen.getByTestId("day-details")).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId("day-details")).toBeNull();
  });

  it("a practiced day from last week isn't on this week's track", () => {
    render(<WeeklyTrack week={WEEK} />);
    expect(screen.queryByTestId("track-day-2026-11-19")).toBeNull();
  });
});

// ---------------------------------------------------------------- today's target

describe("TodayTarget (D3)", () => {
  it("minutes of the goal, a bar, and a way to change the goal — no 'met' label before it's met", () => {
    const onChangeGoal = jest.fn();
    render(<TodayTarget week={WEEK} onChangeGoal={onChangeGoal} changeGoalRef={null} />);
    const target = screen.getByTestId("today-target");
    expect(target).toHaveAttribute("data-met", "false");
    expect(screen.getByTestId("today-target-value")).toHaveTextContent("11 of 15 minutes");
    expect(within(target).queryByText(/Goal met/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Change daily goal" }));
    expect(onChangeGoal).toHaveBeenCalledTimes(1);
  });

  it("met: teal, with 'Goal met today ✓'", () => {
    render(<TodayTarget week={weekOf({ goalMinutes: 10 }, { "2026-11-25": { practiced: true, activeSec: 600 } })} onChangeGoal={jest.fn()} changeGoalRef={null} />);
    expect(screen.getByTestId("today-target")).toHaveAttribute("data-met", "true");
    expect(screen.getByText("Goal met today ✓")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------- the page

describe("Dashboard hero and Learning performance with the week", () => {
  it("the hero shows the track and Today's target; Est. active practice gets the 7-day bars", async () => {
    render(withProviders(<DashboardPage />));
    const hero = await screen.findByTestId("dashboard-welcome");
    await within(hero).findByTestId("weekly-track");
    expect(within(hero).getByTestId("today-target-value")).toHaveTextContent("11 of 15 minutes");
    expect(within(hero).getByRole("button", { name: /Start today/ })).toBeInTheDocument();

    const bars = await screen.findByTestId("progress-week-bars");
    expect(within(screen.getByTestId("progress-active")).getByTestId("progress-week-bars")).toBe(bars);
    expect(within(bars).getByRole("img")).toHaveAccessibleName(
      "Active practice, last 7 days: Thu, Nov 19 10 min; Fri, Nov 20 0 min; Sat, Nov 21 0 min; Sun, Nov 22 0 min; Mon, Nov 23 22 min; Tue, Nov 24 0 min; Wed, Nov 25 11 min"
    );
  });

  it("week unavailable (047 not applied): no track, no target, no bars — the rest of the hero and the page still work", async () => {
    weekResponse = "unavailable";
    render(withProviders(<DashboardPage />));
    const hero = await screen.findByTestId("dashboard-welcome");
    await waitFor(() => expect(weekGets()).toBe(1));
    await waitFor(() => expect(within(hero).queryByTestId("weekly-track-pending")).toBeNull());
    expect(within(hero).queryByTestId("weekly-track")).toBeNull();
    expect(within(hero).queryByTestId("today-target")).toBeNull();
    expect(within(hero).getByRole("button", { name: /Start today/ })).toBeInTheDocument();
    await screen.findByTestId("your-progress");
    expect(screen.queryByTestId("progress-week-bars")).toBeNull();
  });

  it("changing the goal from Today's target: dialog → choose → Save → saved, toast, dialog closed, focus back, target refreshed", async () => {
    render(withProviders(<DashboardPage />));
    const change = await screen.findByRole("button", { name: "Change daily goal" });
    fireEvent.click(change);
    const dialog = await screen.findByRole("dialog", { name: "Profile & preferences" });
    const fifteen = await within(dialog).findByRole("radio", { name: "15 min" });
    expect(fifteen).toBeChecked();
    expect(within(dialog).getByText(/No goal saved yet — 15 min is the default/)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("radio", { name: "30 min" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.filter((c) => c.method === "PATCH")).toEqual([{ method: "PATCH", url: "/api/profile", body: { dailyGoalMinutes: 30 } }]);
    expect(await screen.findByText("Daily goal saved")).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Change daily goal" }));
    await waitFor(() => expect(screen.getByTestId("today-target-value")).toHaveTextContent("11 of 30 minutes"));
    expect(weekGets()).toBe(2);
  });

  it("saving the goal unchanged closes without a request; a failed save keeps the dialog open with an error", async () => {
    render(withProviders(<DashboardPage />));
    fireEvent.click(await screen.findByRole("button", { name: "Change daily goal" }));
    let dialog = await screen.findByRole("dialog", { name: "Profile & preferences" });
    await within(dialog).findByRole("radio", { name: "15 min" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);

    patchFails = true;
    fireEvent.click(screen.getByRole("button", { name: "Change daily goal" }));
    dialog = await screen.findByRole("dialog", { name: "Profile & preferences" });
    fireEvent.click(await within(dialog).findByRole("radio", { name: "45 min" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Couldn't save your daily goal");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------- account menu

describe("Profile & preferences from the account menu", () => {
  it("opens from the menu; Escape closes it and focus returns to the avatar button", async () => {
    render(withProviders(<UserButton />));
    const avatar = screen.getByRole("button", { name: "Account menu" });
    fireEvent.click(avatar);
    fireEvent.click(screen.getByRole("menuitem", { name: "Profile & preferences" }));
    const dialog = await screen.findByRole("dialog", { name: "Profile & preferences" });
    expect(screen.queryByRole("menu")).toBeNull();
    await within(dialog).findByRole("radio", { name: "15 min" });
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(avatar);
  });

  it("preferences unavailable → a plain message, nothing to save", async () => {
    profileResponse = "unavailable";
    render(withProviders(<UserButton />));
    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Profile & preferences" }));
    const dialog = await screen.findByRole("dialog", { name: "Profile & preferences" });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Your preferences aren't available right now");
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
  });
});
