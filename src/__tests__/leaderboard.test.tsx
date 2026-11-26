/**
 * Phase 7 of the dashboard redesign (.claude/dashboard-redesign-plan.md §1,
 * §3.5, §4.3, §4.4, D2/D5–D7): the League card, /leaderboard, kudos, the
 * privacy notice, public name and visibility in Profile & preferences, the
 * Monday recap's league result, the footer's league rank and the League
 * achievement copy.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { User } from "@supabase/supabase-js";
import type { DashboardSummary, LibraryPage } from "@/lib/types/learning";
import type { LeagueAllTimeBoard, LeagueWeekBoard, LeagueWeekRow } from "@/lib/types/leaderboard";
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
jest.mock("@/components/AppHeader", () => ({ __esModule: true, default: () => null }));

import DashboardPage from "@/app/dashboard/page";
import LeaderboardPage from "@/app/leaderboard/page";
import AppFooter from "@/components/AppFooter";
import { ProfileDialog } from "@/components/ProfileDialog";
import { ToastProvider } from "@/components/ToastProvider";
import { LeagueCard } from "@/app/dashboard/components/LeagueCard";
import { AchievementsCase } from "@/app/dashboard/components/AchievementsCase";
import { weeklyRecapText } from "@/app/dashboard/components/WeeklyRecapBanner";
import { formatLeagueReset, initialsOf, lastWeekResultText, zoneText } from "@/lib/leagues/tiers";
import { leaderboardKeys } from "@/lib/queries/leaderboard";

// ---------------------------------------------------------------- fixtures

const memberKey = (rank: number) => `00000000-0000-4000-8000-${String(rank).padStart(12, "0")}`;
function rowOf(rank: number, over: Partial<LeagueWeekRow> = {}): LeagueWeekRow {
  return {
    rank,
    memberKey: memberKey(rank),
    name: `Member ${rank}`,
    initials: `M${rank}`.slice(0, 2),
    weekXp: 500 - rank * 20,
    streakDays: rank,
    kudos: 0,
    youGaveKudos: false,
    isYou: false,
    zone: rank <= 3 ? "promotion" : rank > 9 ? "demotion" : "safe",
    ...over,
  };
}
function weekBoard(over: Partial<LeagueWeekBoard> = {}): LeagueWeekBoard {
  const rows = Array.from({ length: 12 }, (_, i) => rowOf(i + 1, i === 6 ? { isYou: true, name: "Linh Tran", initials: "LT" } : {}));
  return {
    scope: "week",
    status: "member",
    tier: 3,
    weekStart: "2026-11-23",
    weekEndsAt: "2026-11-30T00:00:00Z",
    displayName: "Linh Tran",
    lastWeek: { weekStart: "2026-11-16", tier: 2, outcome: "promoted", finalRank: 2, xp: 1240 },
    rows,
    you: { rank: 7, weekXp: 360, zone: "safe", gapToPromotionXp: 81 },
    ...over,
  };
}
const ALL: LeagueAllTimeBoard = {
  scope: "all",
  status: "member",
  tier: 3,
  weekStart: "2026-11-23",
  weekEndsAt: "2026-11-30T00:00:00Z",
  displayName: "Linh Tran",
  lastWeek: null,
  rows: [1, 2, 3, 4, 5].map((rank) => ({ rank, name: `Top ${rank}`, initials: `T${rank}`, totalXp: 10_000 - rank * 1000, isYou: false })),
  you: { rank: 14, totalXp: 2400 },
  refreshedAt: "2026-11-25T09:00:00Z",
};
const PROFILE: UserProfile = { publicName: null, nickname: "Learner 4F2A2", leaderboardHidden: false, dailyGoalMinutes: 20 };

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
let weekResponse: LeagueWeekBoard | "unavailable";
let profileResponse: UserProfile;
let kudosStatus: number;
let patchStatus: number;
let calls: Array<{ method: string; url: string; body?: unknown }>;

beforeEach(() => {
  weekResponse = weekBoard();
  profileResponse = PROFILE;
  kudosStatus = 200;
  patchStatus = 200;
  calls = [];
  window.localStorage.clear();
  window.sessionStorage.clear();
  Element.prototype.scrollIntoView = jest.fn();
  window.matchMedia = jest.fn().mockReturnValue({ matches: false }) as unknown as typeof window.matchMedia;
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.startsWith("/api/leaderboard/kudos")) return kudosStatus === 200 ? json({ ok: true, kudos: 1 }) : json({ error: "nope" }, kudosStatus);
    if (url.startsWith("/api/leaderboard?scope=all")) return json(ALL);
    if (url.startsWith("/api/leaderboard?scope=week")) return weekResponse === "unavailable" ? json({}, 503) : json(weekResponse);
    if (url === "/api/profile" && method === "PATCH") {
      if (patchStatus !== 200) return json({ error: "Invalid request." }, patchStatus);
      profileResponse = { ...profileResponse, ...(JSON.parse(String(init?.body)) as Partial<UserProfile>) };
      return json(profileResponse);
    }
    if (url === "/api/profile") return json(profileResponse);
    if (url.startsWith("/api/dashboard/summary")) return json(summaryOf());
    if (url.startsWith("/api/videos/library?")) return json({ items: [], total: 0, limit: 1, offset: 0, filter: "continue", hasMore: false } satisfies LibraryPage);
    if (url.startsWith("/api/dashboard/error-patterns")) return json({ total: 0, patterns: [] });
    if (url.startsWith("/api/vocabulary/stats")) return json({ total: 0, new: 0, learning: 0, due: 0, reviewable: 0 } satisfies VocabularyStatsResponse);
    if (url.startsWith("/api/vocabulary/review")) return json({ items: [] });
    return json({}, 404);
  }) as typeof fetch;
});

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const withProviders = (ui: React.ReactNode, client = newClient()) => (
  <QueryClientProvider client={client}>
    <ToastProvider>{ui}</ToastProvider>
  </QueryClientProvider>
);
const posts = () => calls.filter((c) => c.method !== "GET");

// ---------------------------------------------------------------- copy helpers

describe("league copy", () => {
  it("initials, last week's result and the zone line", () => {
    expect([initialsOf("Linh Tran"), initialsOf("Mai"), initialsOf("  trí   nguyễn văn "), initialsOf("")]).toEqual(["LT", "M", "TV", "?"]);
    expect(lastWeekResultText({ weekStart: "x", tier: 2, outcome: "promoted", finalRank: 2, xp: 1 })).toBe("finished #2 → promoted to Gold");
    expect(lastWeekResultText({ weekStart: "x", tier: 2, outcome: "demoted", finalRank: 28, xp: 1 })).toBe("finished #28 → moved down to Bronze");
    expect(lastWeekResultText({ weekStart: "x", tier: 4, outcome: "stayed", finalRank: 5, xp: 1 })).toBe("finished #5 in Platinum");
    expect(lastWeekResultText({ weekStart: "x", tier: 4, outcome: "stayed", finalRank: null, xp: null })).toBe("stayed in Platinum");
    expect(zoneText(weekBoard())).toBe("81 XP to the promotion zone (top 3 move up to Platinum).");
    expect(zoneText(weekBoard({ you: { rank: 2, weekXp: 460, zone: "promotion", gapToPromotionXp: null } }))).toBe("Promotion zone: the top 3 move up to Platinum.");
    expect(zoneText(weekBoard({ you: { rank: 11, weekXp: 280, zone: "demotion", gapToPromotionXp: 181 } }))).toBe("Demotion zone: the bottom 3 move down to Silver.");
    expect(zoneText(weekBoard({ tier: 6, you: { rank: 7, weekXp: 360, zone: "safe", gapToPromotionXp: null } }))).toBe("Master is the top league: keep your place.");
    expect(formatLeagueReset("2026-11-30T00:00:00Z")).toMatch(/^\S+ \d{2}:\d{2}$/);
  });

  it("the recap gains last week's league result (same week only)", () => {
    const xpWeek = { weekStart: "2026-11-16", xp: 1240, activeSec: 5760, wordsReviewed: 41 };
    expect(weeklyRecapText(xpWeek, weekBoard().lastWeek)).toBe("Last week: 1,240 XP · 96 min · 41 words reviewed · finished #2 → promoted to Gold");
    expect(weeklyRecapText(xpWeek, { ...weekBoard().lastWeek!, weekStart: "2026-11-09" })).toBe("Last week: 1,240 XP · 96 min · 41 words reviewed");
  });

  it("the League achievement reads in leagues, not numbers", () => {
    render(<AchievementsCase tracks={[{ track: "league", value: 2, tiers: [2, 3, 4, 5].map((threshold, i) => ({ tier: (i + 1) as 1 | 2 | 3 | 4, threshold, unlockedAt: i === 0 ? "2026-11-24T00:00:00Z" : null })) }]} />);
    expect(screen.getByRole("button", { name: "League: Bronze, Silver league now, Gold league needed for Silver" })).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("achievement-league"));
    expect(screen.getByTestId("achievement-tier-2")).toHaveTextContent("Silver · Gold league1 promotion to go");
  });
});

// ---------------------------------------------------------------- league card

describe("LeagueCard", () => {
  it("tier, reset time, the top 3 plus your row, the zone line and a link to the full board", () => {
    render(withProviders(<LeagueCard userId="user-1" board={weekBoard()} />));
    const card = screen.getByTestId("league-card");
    expect(within(card).getByRole("heading", { name: "Gold League" })).toBeInTheDocument();
    expect(screen.getByTestId("league-reset")).toHaveTextContent(/^Resets /);
    expect(within(card).getAllByRole("listitem").map((li) => li.getAttribute("data-testid"))).toEqual(
      ["league-row-1", "league-row-2", "league-row-3", "league-row-7"]
    );
    expect(screen.getByTestId("league-row-7")).toHaveAttribute("data-you", "true");
    expect(screen.getByTestId("league-zone")).toHaveTextContent("81 XP to the promotion zone");
    expect(within(card).getByRole("link", { name: /Full leaderboard/ })).toHaveAttribute("href", "/leaderboard");
    // Your own row has no kudos button.
    expect(within(screen.getByTestId("league-row-7")).queryByRole("button")).toBeNull();
  });

  it("kudos show at once and are sent once; a refusal rolls back with a toast", async () => {
    const client = newClient();
    client.setQueryData(leaderboardKeys.board("user-1", "week"), weekBoard());
    const { rerender } = render(withProviders(<LeagueCard userId="user-1" board={weekBoard()} />, client));
    const heart = screen.getByRole("button", { name: "Give kudos to Member 1" });
    fireEvent.click(heart);
    await waitFor(() => expect(client.getQueryData<LeagueWeekBoard>(leaderboardKeys.board("user-1", "week"))!.rows[0]).toMatchObject({ youGaveKudos: true, kudos: 1 }));
    expect(posts()).toEqual([{ method: "POST", url: "/api/leaderboard/kudos", body: { memberKey: memberKey(1) } }]);
    rerender(withProviders(<LeagueCard userId="user-1" board={client.getQueryData<LeagueWeekBoard>(leaderboardKeys.board("user-1", "week"))!} />, client));
    expect(screen.getByRole("button", { name: "You gave kudos to Member 1" })).toBeDisabled();

    kudosStatus = 400;
    fireEvent.click(screen.getByRole("button", { name: "Give kudos to Member 2" }));
    expect(await screen.findByText("Couldn't send kudos")).toBeInTheDocument();
    expect(client.getQueryData<LeagueWeekBoard>(leaderboardKeys.board("user-1", "week"))!.rows[1]).toMatchObject({ youGaveKudos: false, kudos: 0 });
  });

  it("All time: loaded on first open — the top 3, your rank below, 'Updated hourly'", async () => {
    render(withProviders(<LeagueCard userId="user-1" board={weekBoard()} />));
    expect(calls.some((c) => c.url.includes("scope=all"))).toBe(false);
    fireEvent.click(screen.getByRole("tab", { name: "All time" }));
    expect(await screen.findByTestId("alltime-row-1")).toHaveTextContent("Top 1");
    expect(screen.getByTestId("alltime-you")).toHaveTextContent("14You2,400 XP");
    expect(screen.getByText("Updated hourly.")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "All time" })).toHaveAttribute("aria-selected", "true");
  });

  it("not joined yet and hidden", () => {
    const { unmount } = render(withProviders(<LeagueCard userId="user-1" board={weekBoard({ status: "not_joined", tier: 1, rows: [], you: null })} />));
    expect(screen.getByTestId("league-not-joined")).toHaveTextContent("Practice anything this week to join this week's Bronze league.");
    unmount();
    render(withProviders(<LeagueCard userId="user-1" board={weekBoard({ status: "hidden", rows: [], you: null })} />));
    expect(screen.getByTestId("league-hidden")).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByTestId("league-privacy-notice")).toBeNull();
  });

  it("the one-time privacy notice: how you appear, Preferences opens the dialog, 'Got it' hides it for good", async () => {
    const { unmount } = render(withProviders(<LeagueCard userId="user-1" board={weekBoard({ displayName: "Learner 4F2A2" })} />));
    const notice = screen.getByTestId("league-privacy-notice");
    expect(notice).toHaveTextContent("You appear as Learner 4F2A2. Change your name or hide yourself in Preferences.");
    fireEvent.click(within(notice).getByRole("button", { name: "Preferences" }));
    expect(await screen.findByRole("dialog", { name: "Profile & preferences" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(within(screen.getByTestId("league-privacy-notice")).getByRole("button", { name: "Got it" }));
    expect(screen.queryByTestId("league-privacy-notice")).toBeNull();
    unmount();
    render(withProviders(<LeagueCard userId="user-1" board={weekBoard()} />));
    expect(screen.queryByTestId("league-privacy-notice")).toBeNull();
  });
});

// ---------------------------------------------------------------- /leaderboard

describe("/leaderboard", () => {
  it("the whole group with its zones, the ladder, last week, all time and the privacy box", async () => {
    render(withProviders(<LeaderboardPage />));
    expect(await screen.findByTestId("league-row-12")).toBeInTheDocument();
    expect(screen.getAllByTestId(/^league-row-/)).toHaveLength(12);
    expect(screen.getByTestId("league-row-1")).toHaveAttribute("data-zone", "promotion");
    expect(screen.getByTestId("league-row-1")).toHaveTextContent(/promotion zone/);
    expect(screen.getByTestId("league-row-12")).toHaveAttribute("data-zone", "demotion");
    expect(screen.getByTestId("leaderboard-zone")).toHaveTextContent("81 XP to the promotion zone");
    const ladder = screen.getByTestId("tier-ladder");
    expect(within(ladder).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Master", "Diamond", "Platinum", "GoldYou are here", "Silver", "Bronze"]);
    expect(within(ladder).getByText("Gold").closest("li")).toHaveAttribute("aria-current", "step");
    expect(screen.getByTestId("leaderboard-last-week")).toHaveTextContent("You finished #2 → promoted to Gold · 1,240 XP");
    expect(await screen.findByTestId("alltime-row-5")).toBeInTheDocument();
    const privacy = screen.getByTestId("leaderboard-privacy");
    expect(privacy).toHaveTextContent("never emails or photos");
    expect(within(privacy).getByTestId("league-privacy-notice")).toHaveTextContent("You appear as Linh Tran");
    expect(within(privacy).queryByRole("button", { name: "Got it" })).toBeNull(); // always shown here
  });

  it("hidden: no rows, no all-time request; the way back is in Preferences", async () => {
    weekResponse = weekBoard({ status: "hidden", rows: [], you: null });
    render(withProviders(<LeaderboardPage />));
    expect(await screen.findByTestId("leaderboard-hidden")).toBeInTheDocument();
    await act(async () => {});
    expect(calls.some((c) => c.url.includes("scope=all"))).toBe(false);
    expect(screen.queryAllByTestId(/^league-row-/)).toHaveLength(0);
    fireEvent.click(within(screen.getByTestId("leaderboard-privacy")).getByRole("button", { name: "Change name or visibility" }));
    expect(await screen.findByRole("dialog", { name: "Profile & preferences" })).toBeInTheDocument();
  });

  it("unavailable (050 not applied) → a plain message", async () => {
    weekResponse = "unavailable";
    render(withProviders(<LeaderboardPage />));
    expect(await screen.findByText("The leaderboard isn't available right now. Please try again later.")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------- preferences

describe("Profile & preferences: public name and visibility (D7)", () => {
  const open = async () => {
    render(withProviders(<ProfileDialog onClose={jest.fn()} />));
    return screen.findByRole("dialog", { name: "Profile & preferences" });
  };

  it("the nickname is the placeholder; a new name and hiding are sent — only what changed", async () => {
    const dialog = await open();
    const name = await within(dialog).findByRole("textbox", { name: "Public name" });
    await waitFor(() => expect(name).toHaveAttribute("placeholder", "Learner 4F2A2"));
    expect(within(dialog).getByText("Leave it empty to appear as Learner 4F2A2.")).toBeInTheDocument();
    fireEvent.change(name, { target: { value: "  Linh   Tran " } });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /Show me on leaderboards/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toEqual({ method: "PATCH", url: "/api/profile", body: { publicName: "Linh Tran", leaderboardHidden: true } });
    expect(await screen.findByText("Preferences saved")).toBeInTheDocument();
  });

  it("clearing a name sends null (back to the nickname)", async () => {
    profileResponse = { ...PROFILE, publicName: "Linh" };
    const dialog = await open();
    const name = await within(dialog).findByDisplayValue("Linh");
    fireEvent.change(name, { target: { value: "   " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body).toEqual({ publicName: null });
  });

  it("a one-letter name is caught before sending; a name the database refuses shows why", async () => {
    const dialog = await open();
    const name = await within(dialog).findByRole("textbox", { name: "Public name" });
    await waitFor(() => expect(name).not.toBeDisabled());
    fireEvent.change(name, { target: { value: "L" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Use 2–24 characters, or leave it empty.");
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(posts()).toHaveLength(0);

    patchStatus = 400;
    fireEvent.change(name, { target: { value: "me@example.com" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText(/That name can't be used/)).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------- dashboard + footer

describe("Dashboard and footer", () => {
  it("the deck shares its row with the league card; the welcome uses the public name", async () => {
    profileResponse = { ...PROFILE, publicName: "Linh" };
    render(withProviders(<DashboardPage />));
    const card = await screen.findByTestId("league-card");
    const row = screen.getByTestId("dashboard-deck-row");
    expect(row).toHaveClass("lg:grid-cols-12");
    expect(row).toContainElement(card);
    expect(row).toContainElement(screen.getByTestId("vocabulary-card"));
    expect(await screen.findByRole("heading", { name: "Welcome back, Linh" })).toBeInTheDocument();
  });

  it("league unavailable → no card; the deck takes the row alone", async () => {
    weekResponse = "unavailable";
    render(withProviders(<DashboardPage />));
    await screen.findByTestId("vocabulary-card");
    await waitFor(() => expect(screen.queryByLabelText("Loading your league")).toBeNull());
    expect(screen.queryByTestId("league-card")).toBeNull();
    expect(screen.getByTestId("dashboard-deck-row")).not.toHaveClass("lg:grid-cols-12");
  });

  it("the footer shows the league rank only from an already-loaded board — it never asks for one", async () => {
    const client = newClient();
    const { unmount } = render(withProviders(<AppFooter />, client));
    await act(async () => {});
    expect(screen.queryByTestId("footer-league")).toBeNull();
    expect(calls.some((c) => c.url.startsWith("/api/leaderboard"))).toBe(false);
    unmount();
    client.setQueryData(leaderboardKeys.board("user-1", "week"), weekBoard());
    render(withProviders(<AppFooter />, client));
    expect(await screen.findByTestId("footer-league")).toHaveTextContent("League: Gold #7");
  });
});
