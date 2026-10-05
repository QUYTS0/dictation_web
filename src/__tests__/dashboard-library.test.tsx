/**
 * Dashboard without a Library section (component tests, fetch mocked — not a
 * real browser), plus the generic LibraryCard's own semantics:
 *   - the Dashboard never renders or fetches the Library grid (it is not a
 *     browsing page); Continue Learning shows ONE resume item;
 *   - practice coverage is the only progress bar; accuracy is never drawn as
 *     progress; Listening-only and prior-revision states are distinct from
 *     "not started"; legacy completions are labeled separately;
 *   - Add Video has no mode choice and opens the practice page;
 *   - background refresh keeps the current card on screen;
 *   - another account never sees this account's cached Continue item.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { User } from "@supabase/supabase-js";
import type { DashboardSummary, LibraryItem, LibraryPage } from "@/lib/types/learning";
import { videoLibraryKeys } from "@/lib/queries/videoLibrary";

let authUser: User = { id: "user-1", email: "learner@example.test" } as User;
jest.mock("@/context/auth", () => ({
  useAuth: () => ({ user: authUser, loading: false, openAuthModal: jest.fn() }),
}));
const push = jest.fn();
jest.mock("next/navigation", () => ({
  usePathname: () => "/dashboard",
  useRouter: () => ({ push, replace: jest.fn() }),
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

import DashboardPage from "@/app/dashboard/page";
import { LibraryCard } from "@/components/library/LibraryCard";

const EMPTY_LISTENING: LibraryItem["listening"] = {
  transcriptId: "tr",
  coverageRatio: null,
  listenedThrough: false,
  lastPositionSec: null,
  hasHistory: false,
  historyOnOtherRevision: false,
};
function progress(covered: number, required: number, correct: number, practiced: number) {
  return {
    requiredSentenceCount: required,
    coveredSentences: { dictation: covered, shadowing: 0, overall: covered },
    coverage: { dictation: covered / required, shadowing: 0, overall: covered / required },
    attemptCount: practiced,
    sentenceAccuracy: { correct, practiced, percent: practiced ? Math.round((100 * correct) / practiced) : null },
  };
}
function item(videoId: string, over: Partial<LibraryItem> = {}): LibraryItem {
  return {
    videoId,
    title: `Title ${videoId}`,
    addedAt: "2026-09-01T00:00:00Z",
    lastActivityAt: "2026-09-02T00:00:00Z",
    lastMode: null,
    state: "not_started",
    hasCompletedRound: false,
    hasLegacyCompletion: false,
    completedRoundCount: 0,
    round: null,
    listening: EMPTY_LISTENING,
    ...over,
  };
}
const round = (over: Partial<NonNullable<LibraryItem["round"]>> = {}): NonNullable<LibraryItem["round"]> => ({
  roundId: "round-1",
  status: "active",
  provenance: "current",
  roundNumber: 1,
  transcriptId: "tr",
  startedAt: "2026-09-01T00:00:00Z",
  completedAt: null,
  currentSegmentIndex: 0,
  progress: progress(1, 10, 1, 1),
  ...over,
});
const page = (items: LibraryItem[], extra: Partial<LibraryPage> = {}): LibraryPage => ({
  items,
  total: items.length,
  limit: 1,
  offset: 0,
  filter: "continue",
  hasMore: false,
  ...extra,
});
const SUMMARY: DashboardSummary = {
  completedVideos: 1,
  legacyCompletedVideos: 2,
  inProgressVideos: 1,
  listenedThroughVideos: 0,
  libraryVideos: 6,
  sentenceAccuracy: { correct: 3, practiced: 4, excludedUnverified: 0 },
  shadowing: {
    takes: 0,
    practicedSentences: 0,
    attemptedSentences: 0,
    azure: { evaluatedSentences: 0, pronunciation: null, accuracy: null, completeness: null, fluency: null, prosody: null },
    wordMatch: { evaluatedSentences: 0, accuracy: null, completeness: null },
  },
  activeTime: { activeSec: 0, trackedSince: null, sessionCount: 0 },
  vocabularyCount: 0,
  streakDays: 2,
  streakTimeZone: "UTC",
  streakToday: "2026-10-01",
  streakIncludesUtcFallback: false,
  recentVocabulary: [],
};

const PROGRESS_ITEM = item("vProgress", { state: "in_progress", round: round({ progress: progress(1, 10, 1, 1) }), hasCompletedRound: true, completedRoundCount: 1, lastMode: "shadowing" });
const LISTEN_ITEM = item("vListen", { state: "listening", listening: { ...EMPTY_LISTENING, coverageRatio: 0.45, lastPositionSec: 30, hasHistory: true } });

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
let continueResponse: LibraryPage;
let continueGate: Promise<void> | null;
const calls: string[] = [];

beforeEach(() => {
  jest.clearAllMocks();
  calls.length = 0;
  authUser = { id: "user-1", email: "learner@example.test" } as User;
  continueResponse = page([PROGRESS_ITEM]);
  continueGate = null;
  window.sessionStorage.clear();
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.startsWith("/api/dashboard/summary")) return json(SUMMARY);
    if (url.startsWith("/api/dashboard/error-patterns")) return json({ total: 0, patterns: [] });
    if (url.startsWith("/api/vocabulary/stats")) return json({ total: 0, new: 0, learning: 0, due: 0, reviewable: 0 });
    if (url.startsWith("/api/videos/library?")) {
      if (continueGate) await continueGate;
      return json(continueResponse);
    }
    if (url.startsWith("/api/video/resolve")) return json({ videoId: "dQw4w9WgXcQ", status: "ok", libraryAdded: true });
    return json({});
  }) as typeof fetch;
});

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
function renderDashboard(client = newClient()) {
  return { client, ...render(<QueryClientProvider client={client}><DashboardPage /></QueryClientProvider>) };
}

describe("Dashboard is not a Library browser", () => {
  it("no Library heading, filters, grid, Load more or remove controls — and never the all-library request", async () => {
    renderDashboard();
    await screen.findByTestId("continue-card-vProgress");
    await screen.findByTestId("your-progress");
    expect(screen.queryByRole("heading", { name: /^Library/ })).toBeNull();
    expect(screen.queryByRole("tablist", { name: "Filter library" })).toBeNull();
    for (const label of ["All", "Not started", "Load more"]) expect(screen.queryByText(label)).toBeNull();
    expect(screen.queryByTestId("library-grid")).toBeNull();
    expect(screen.queryByLabelText(/from your library/)).toBeNull();
    expect(calls.filter((c) => c.includes("/api/videos/library"))).toEqual(["GET /api/videos/library?filter=continue&offset=0&limit=1"]);
  });

  it("metrics stay separate: verified completions with a separate 'started before detailed tracking' note; missing metrics show '—'", async () => {
    renderDashboard();
    const progress = await screen.findByTestId("your-progress");
    expect(within(progress).getByTestId("progress-videos")).toHaveTextContent(
      "1 video in progress · 1 completed · +2 completed in rounds started before detailed tracking"
    );
    expect(within(progress).getByTestId("progress-accuracy")).toHaveTextContent("3/4 latest answers");
    expect(within(progress).getByTestId("progress-pronunciation")).toHaveTextContent("—");
    expect(within(progress).getByTestId("progress-active")).toHaveTextContent("—");
  });
});

describe("Continue Learning: one resume item", () => {
  it("only the first canonical item renders; its coverage is truthful; one CTA; no report link", async () => {
    continueResponse = page([PROGRESS_ITEM, LISTEN_ITEM], { limit: 3 }); // even if the server returned more
    renderDashboard();
    const cont = await screen.findByTestId("continue-learning");
    expect(within(cont).getByTestId("continue-card-vProgress")).toBeInTheDocument();
    expect(screen.queryByTestId("continue-card-vListen")).toBeNull();
    expect(within(cont).getByTestId("continue-coverage")).toHaveTextContent("1/10 sentences practiced");
    expect(within(cont).getByText("Shadowing")).toBeInTheDocument();
    expect(within(cont).getByRole("link", { name: "Continue learning" })).toHaveAttribute("href", "/dictation/vProgress");
    expect(within(cont).getAllByRole("link").filter((a) => a.getAttribute("tabindex") !== "-1")).toHaveLength(1);
    expect(within(cont).queryByRole("link", { name: /report/i })).toBeNull(); // completedRoundCount 1 — still no report link here
  });

  it("a Listening-only item opens Listening and shows its own listening progress", async () => {
    continueResponse = page([LISTEN_ITEM]);
    renderDashboard();
    const cont = await screen.findByTestId("continue-learning");
    expect(within(cont).getByTestId("continue-listening")).toHaveTextContent("Listened 45%");
    expect(within(cont).getByRole("link", { name: "Continue learning" })).toHaveAttribute("href", "/dictation/vListen?mode=listening");
  });

  it("no unfinished work → no resume card; saved videos are one small link away in My Learning", async () => {
    continueResponse = page([]);
    renderDashboard();
    await screen.findByTestId("your-progress");
    const empty = await screen.findByTestId("continue-empty");
    expect(screen.queryByTestId("continue-learning")).toBeNull();
    expect(within(empty).getByRole("link", { name: "Browse My Learning" })).toHaveAttribute("href", "/library");
  });
});

describe("Add Video", () => {
  it("collapsed by default; once opened: one URL field, no mode choice; opens the practice page without ?mode=", async () => {
    renderDashboard();
    await screen.findByTestId("continue-learning");
    expect(screen.queryByLabelText("YouTube URL")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add a video" }));
    expect(screen.queryByText("Dictation Practice")).toBeNull();
    expect(screen.queryByText("Listening Practice")).toBeNull();
    fireEvent.change(screen.getByLabelText("YouTube URL"), { target: { value: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" } });
    fireEvent.click(screen.getByText("Add video"));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/dictation/dQw4w9WgXcQ"));
  });
});

describe("cache behavior", () => {
  it("a background refresh keeps the current Continue card on screen", async () => {
    const { client } = renderDashboard();
    await screen.findByTestId("continue-card-vProgress");
    let release!: () => void;
    continueGate = new Promise<void>((r) => (release = r));
    await act(async () => {
      void client.invalidateQueries({ queryKey: videoLibraryKeys.allForUser("user-1") });
    });
    expect(screen.getByTestId("continue-card-vProgress")).toBeInTheDocument(); // still visible while refetching
    await act(async () => {
      release();
    });
  });

  it("another account never sees this account's cached Continue item", async () => {
    const client = newClient();
    client.setQueryData(videoLibraryKeys.continueLearning("user-1"), page([PROGRESS_ITEM]));
    authUser = { id: "user-2", email: "other@example.test" } as User;
    continueResponse = page([item("vOther", { state: "in_progress", round: round({ roundId: "r-other" }) })]);
    renderDashboard(client);
    await screen.findByTestId("continue-card-vOther");
    expect(screen.queryByTestId("continue-card-vProgress")).toBeNull();
  });
});

// ---------------------------------------------------------------- the generic LibraryCard's own semantics

describe("LibraryCard", () => {
  it("each state distinct; coverage is the only bar (never accuracy)", () => {
    const { unmount } = render(<LibraryCard item={item("vNew")} />);
    expect(screen.getByTestId("library-card-vNew")).toHaveTextContent("Not started");
    expect(screen.getByText("Start")).toHaveAttribute("href", "/dictation/vNew");
    unmount();

    const p = render(<LibraryCard item={PROGRESS_ITEM} />);
    const prog = screen.getByTestId("library-card-vProgress");
    expect(prog).toHaveTextContent("1/10 sentences practiced");
    expect(prog).toHaveTextContent("Completed before");
    expect(prog.querySelector('[style*="width"]')?.getAttribute("style")).toContain("width: 10%");
    expect(within(prog).queryByTestId("library-accuracy")).toBeNull(); // 100% accuracy never shown as progress
    p.unmount();

    const l = render(<LibraryCard item={LISTEN_ITEM} />);
    expect(screen.getByTestId("library-card-vListen")).toHaveTextContent("Listened 45%");
    expect(screen.getByText("Continue")).toHaveAttribute("href", "/dictation/vListen?mode=listening");
    expect(screen.getByTestId("library-card-vListen")).not.toHaveTextContent("Not started");
    l.unmount();

    const o = render(<LibraryCard item={item("vOldRev", { state: "listening_prior_revision", listening: { ...EMPTY_LISTENING, hasHistory: true, historyOnOtherRevision: true } })} />);
    expect(screen.getByTestId("library-card-vOldRev")).toHaveTextContent("Previously listened (script updated)");
    o.unmount();

    const g = render(<LibraryCard item={item("vLegacy", { state: "completed", hasLegacyCompletion: true, round: round({ status: "completed", provenance: "legacy_unverified", roundId: "r-leg" }) })} />);
    expect(screen.getByTestId("library-card-vLegacy")).toHaveTextContent("Completed · started before detailed tracking");
    g.unmount();

    render(<LibraryCard item={item("vDone", { state: "completed", hasCompletedRound: true, round: round({ status: "completed", roundId: "r-done", progress: progress(10, 10, 8, 10) }) })} />);
    const done = screen.getByTestId("library-card-vDone");
    expect(done).toHaveTextContent("Practice complete");
    expect(within(done).getByTestId("library-accuracy")).toHaveTextContent("Sentence accuracy 80% (8/10 latest answers)");
    expect(within(done).getByText("Review report")).toHaveAttribute("href", "/results/r-done");
  });

  it("round 1 completed, round 2 in progress: 'Review report' (never 'Past report') opens the card's default round, where the round selector reaches round 1", () => {
    render(
      <LibraryCard
        item={item("vidA", { state: "in_progress", hasCompletedRound: true, completedRoundCount: 1, round: round({ roundId: "round-2", roundNumber: 2 }) })}
      />
    );
    expect(screen.getByRole("link", { name: "Review report" })).toHaveAttribute("href", "/results/round-2");
    expect(screen.queryByText(/Past report/i)).toBeNull();
  });

  it("a completed current round keeps its own target; a legacy completion also offers it; nothing completed → no report link", () => {
    const { unmount } = render(
      <LibraryCard item={item("vidA", { state: "completed", hasCompletedRound: true, completedRoundCount: 1, round: round({ status: "completed" }) })} />
    );
    expect(screen.getByRole("link", { name: "Review report" })).toHaveAttribute("href", "/results/round-1");
    unmount();
    const legacy = render(<LibraryCard item={item("vidL", { state: "in_progress", hasLegacyCompletion: true, round: round({ roundId: "round-7" }) })} />);
    expect(screen.getByRole("link", { name: "Review report" })).toHaveAttribute("href", "/results/round-7");
    legacy.unmount();
    render(<LibraryCard item={item("vidB", { state: "in_progress", round: round({}) })} />);
    expect(screen.queryByRole("link", { name: /report/i })).toBeNull();
  });
});
