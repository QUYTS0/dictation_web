/**
 * Dashboard follow-up to the redesign (approved 2026-11-26): the goal ring
 * replaces the ember as today's marker; motion only on change (count-ups,
 * the XP gain float, a one-time streak flicker, the flashcard turn, the
 * kudos pop); Next up names its sentences when the round report agrees.
 */
import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DashboardWeek, DashboardWeekDay, ReportSentence } from "@/lib/types/learning";
import type { VocabularyItem } from "@/lib/types";
import type { XpSummary } from "@/lib/types/xp";
import type { LeagueWeekRow } from "@/lib/types/leaderboard";
import { WeeklyTrack } from "@/app/dashboard/components/WeeklyTrack";
import { FocusCard } from "@/app/dashboard/components/FocusCard";
import { LevelProgress } from "@/app/dashboard/components/LevelProgress";
import { StreakPill } from "@/components/StreakPill";
import { ToastProvider } from "@/components/ToastProvider";
import { LeagueWeekRows } from "@/components/league/LeagueRows";
import { ReviewCard } from "@/components/vocabulary/ReviewCard";
import { useCountUp } from "@/hooks/useCountUp";
import { addDaysToKey } from "@/lib/utils/streak";

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
let reportBody: unknown;
let reportStatus: number;
let animate: jest.Mock;

beforeEach(() => {
  reportBody = null;
  reportStatus = 200;
  window.localStorage.clear();
  window.matchMedia = jest.fn().mockReturnValue({ matches: false }) as unknown as typeof window.matchMedia;
  animate = jest.fn();
  // jsdom has no Web Animations API; record what playOnce would play.
  (Element.prototype as unknown as { animate: jest.Mock }).animate = animate;
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/session/")) return json(reportBody, reportStatus);
    return json({}, 404);
  }) as typeof fetch;
});
afterEach(() => {
  delete (Element.prototype as unknown as { animate?: jest.Mock }).animate;
});

const withClient = (ui: React.ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ToastProvider>{ui}</ToastProvider>
  </QueryClientProvider>
);

// ---------------------------------------------------------------- goal ring

function weekWithToday(activeSec: number, practiced = activeSec > 0): DashboardWeek {
  const days = Array.from({ length: 14 }, (_, i): DashboardWeekDay => {
    const date = addDaysToKey("2026-11-12", i);
    return { date, practiced: date === "2026-11-23" || (date === "2026-11-25" && practiced), activeSec: date === "2026-11-25" ? activeSec : date === "2026-11-23" ? 900 : 0 };
  });
  return { timeZone: "UTC", today: "2026-11-25", weekStart: "2026-11-23", days, goalMinutes: 20, goalIsDefault: false };
}

describe("goal ring (today's marker)", () => {
  it("no practice yet: an empty ring, no arc; the label names the goal", () => {
    const { container } = render(<WeeklyTrack week={weekWithToday(0)} />);
    const ring = screen.getByTestId("goal-ring");
    expect(ring).toHaveAttribute("data-met", "false");
    expect(container.querySelectorAll('[data-testid="goal-ring"] circle')).toHaveLength(1);
    expect(screen.getByTestId("track-day-2026-11-25")).toHaveTextContent("Today, Wed, Nov 25: no practice yet, goal 20 min");
  });

  it("part-way: an amber arc for the share of the goal (12 of 20 min = 60%)", () => {
    const { container } = render(<WeeklyTrack week={weekWithToday(12 * 60)} />);
    const arc = container.querySelectorAll('[data-testid="goal-ring"] circle')[1] as SVGCircleElement;
    expect(arc).toHaveClass("stroke-reward", "animate-ring-fill");
    const length = 2 * Math.PI * 13;
    expect(parseFloat(arc.style.strokeDashoffset)).toBeCloseTo(length * 0.4, 1);
    expect(screen.getByRole("button", { name: /^Today/ })).toHaveAccessibleName("Today, Wed, Nov 25: practiced, 12 min, goal 20 min");
  });

  it("goal met: the ring closes in teal around a check; the check pops only when met while open", () => {
    const { rerender } = render(<WeeklyTrack week={weekWithToday(12 * 60)} />);
    expect(animate).not.toHaveBeenCalled();
    rerender(<WeeklyTrack week={weekWithToday(24 * 60)} />);
    expect(screen.getByTestId("goal-ring")).toHaveAttribute("data-met", "true");
    expect(screen.getByRole("button", { name: /^Today/ })).toHaveAccessibleName("Today, Wed, Nov 25: practiced, 24 min, goal met");
    expect(animate).toHaveBeenCalledTimes(1);
  });

  it("already met on arrival: no pop (it isn't news)", () => {
    render(<WeeklyTrack week={weekWithToday(30 * 60)} />);
    expect(screen.getByTestId("goal-ring")).toHaveAttribute("data-met", "true");
    expect(animate).not.toHaveBeenCalled();
  });

  it("reduced motion: never pops", () => {
    window.matchMedia = jest.fn().mockReturnValue({ matches: true }) as unknown as typeof window.matchMedia;
    const { rerender } = render(<WeeklyTrack week={weekWithToday(60)} />);
    rerender(<WeeklyTrack week={weekWithToday(24 * 60)} />);
    expect(animate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- Next up sentences

const sentence = (segmentIndex: number, category: ReportSentence["category"], text: string | null = `Sentence text ${segmentIndex}`) =>
  ({ segmentIndex, text, eligible: true, category, dictation: null, shadowing: null }) as ReportSentence;
const reportWith = (sentences: ReportSentence[], needsReview = sentences.filter((s) => s.category === "needs_review").length) => ({
  round: { sentences, dictation: { needsReview } },
});
const focus = (needsReview: number) => ({ kind: "sentences" as const, roundId: "round-1", videoId: "v1", title: "T", needsReview });

describe("Next up names the sentences", () => {
  it("lists the needs-review sentences from the round report (3 by name, the rest counted)", async () => {
    reportBody = reportWith([sentence(0, "correct"), sentence(2, "needs_review"), sentence(4, "needs_review"), sentence(5, "needs_review", null), sentence(9, "needs_review")]);
    render(withClient(<FocusCard focus={focus(4)} onAddVideo={jest.fn()} userId="user-1" />));
    const list = await screen.findByTestId("focus-sentences");
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["#3Sentence text 2", "#5Sentence text 4", "#6Sentence 6"]);
    expect(list).toHaveTextContent("+1 more");
    expect(screen.getByRole("link", { name: /Review sentences/ })).toHaveAttribute("href", "/results/round-1");
  });

  it("left out when the report disagrees with the headline's count, or can't be loaded", async () => {
    reportBody = reportWith([sentence(2, "needs_review"), sentence(4, "needs_review")]);
    const { unmount } = render(withClient(<FocusCard focus={focus(3)} onAddVideo={jest.fn()} userId="user-1" />));
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByTestId("focus-sentences")).toBeNull();
    expect(screen.getByRole("heading", { name: "3 sentences need another look" })).toBeInTheDocument();
    unmount();

    reportStatus = 500;
    render(withClient(<FocusCard focus={focus(3)} onAddVideo={jest.fn()} userId="user-1" />));
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(screen.queryByTestId("focus-sentences")).toBeNull();
  });
});

// ---------------------------------------------------------------- XP count-up

const xpOf = (totalXp: number) => ({ totalXp }) as XpSummary;

describe("XP counts up on change", () => {
  it("useCountUp: the first value as is; a change ends on the new value", async () => {
    const { result, rerender } = renderHook(({ v }) => useCountUp(v, 50), { initialProps: { v: 100 } });
    expect(result.current).toBe(100);
    rerender({ v: 160 });
    await waitFor(() => expect(result.current).toBe(160));
  });

  it("level bar: a gain floats up once ('+60 XP'); the accessible text is the real total at once", async () => {
    const { rerender } = render(<LevelProgress xp={xpOf(2340)} />);
    expect(screen.queryByText("+60 XP")).toBeNull();
    rerender(<LevelProgress xp={xpOf(2400)} />);
    expect(screen.getByText("+60 XP")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByTestId("hero-level-xp")).toHaveTextContent("2,400 XP of 2,800 for level 8");
    await waitFor(() => expect(screen.getByTestId("hero-level-xp")).toHaveTextContent("2,400 / 2,800 XP"));
    fireEvent.animationEnd(screen.getByText("+60 XP"));
    expect(screen.queryByText("+60 XP")).toBeNull();
  });
});

// ---------------------------------------------------------------- streak flame

describe("header flame: still, one flicker when the streak grows", () => {
  it("first sight: no flicker, remembered; a longer streak later flickers once", () => {
    const { rerender } = render(withClient(<StreakPill streakDays={4} userId="user-1" />));
    expect(animate).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("dictalearn:streak-seen:user-1")).toBe("4");
    rerender(withClient(<StreakPill streakDays={5} userId="user-1" />));
    expect(animate).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem("dictalearn:streak-seen:user-1")).toBe("5");
  });

  it("a page opened after the streak grew elsewhere flickers too; the same streak again doesn't", () => {
    window.localStorage.setItem("dictalearn:streak-seen:user-1", "4");
    const { unmount } = render(withClient(<StreakPill streakDays={5} userId="user-1" />));
    expect(animate).toHaveBeenCalledTimes(1);
    unmount();
    render(withClient(<StreakPill streakDays={5} userId="user-1" />));
    expect(animate).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------- flashcard turn, kudos pop

const WORD = {
  id: "w1",
  term: "resilient",
  canonical_form: null,
  sentence_context: "I think this resilient plan will help.",
  definition: "Able to recover quickly.",
  translation: null,
  part_of_speech: null,
  phonetic: null,
  note: null,
} as unknown as VocabularyItem;

describe("flashcard turn", () => {
  it("a fresh card just appears; each flip turns the new face in", () => {
    let revealed = false;
    const { rerender } = render(withClient(<ReviewCard item={WORD} mode="gap" revealed={revealed} onFlip={() => (revealed = !revealed)} />));
    expect(screen.getByRole("button", { name: "Show the missing word" })).not.toHaveClass("animate-card-turn");
    rerender(withClient(<ReviewCard item={WORD} mode="gap" revealed onFlip={jest.fn()} />));
    expect(screen.getByRole("button", { name: "Flip back" }).parentElement).toHaveClass("animate-card-turn");
    rerender(withClient(<ReviewCard item={WORD} mode="gap" revealed={false} onFlip={jest.fn()} />));
    expect(screen.getByRole("button", { name: "Show the missing word" })).toHaveClass("animate-card-turn");
  });
});

describe("kudos pop", () => {
  it("giving kudos pops the heart once", () => {
    const row: LeagueWeekRow = { rank: 1, memberKey: "m1", name: "Lan", initials: "LA", weekXp: 900, streakDays: 0, kudos: 0, youGaveKudos: false, isYou: false, zone: "safe" };
    render(withClient(<LeagueWeekRows rows={[row]} userId="user-1" />));
    fireEvent.click(screen.getByRole("button", { name: "Give kudos to Lan" }));
    expect(animate).toHaveBeenCalledTimes(1);
  });
});
