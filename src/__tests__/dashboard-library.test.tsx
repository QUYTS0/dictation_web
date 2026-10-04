/**
 * Phase 6 Dashboard (component tests, fetch mocked — not a real browser):
 * Continue Learning + compact Add Video + one-card-per-video Library.
 *   - practice coverage is the only progress bar; accuracy is never drawn as
 *     progress;
 *   - Listening-only and prior-revision states are distinct from "not started";
 *   - completions in rounds started before detailed tracking are labeled separately;
 *   - removal is explicit, explains what is kept, and refreshes the Library;
 *   - Add Video has no mode choice and opens the practice page;
 *   - background refresh keeps the current cards on screen;
 *   - another account never sees this account's cached Library.
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
  limit: 12,
  offset: 0,
  filter: "all",
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

const LIBRARY = [
  item("vNew"),
  // 100% accuracy on ONE sentence of ten: coverage 10%, never a full bar.
  item("vProgress", { state: "in_progress", round: round({ progress: progress(1, 10, 1, 1) }), hasCompletedRound: true, lastMode: "shadowing" }),
  item("vListen", { state: "listening", listening: { ...EMPTY_LISTENING, coverageRatio: 0.45, lastPositionSec: 30, hasHistory: true } }),
  item("vOldRev", { state: "listening_prior_revision", listening: { ...EMPTY_LISTENING, hasHistory: true, historyOnOtherRevision: true } }),
  item("vLegacy", { state: "completed", hasLegacyCompletion: true, round: round({ status: "completed", provenance: "legacy_unverified", roundId: "r-leg" }) }),
  item("vDone", { state: "completed", hasCompletedRound: true, round: round({ status: "completed", roundId: "r-done", progress: progress(10, 10, 8, 10) }) }),
];

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
let libraryResponse: LibraryPage;
let continueResponse: LibraryPage;
let libraryGate: Promise<void> | null;
const calls: string[] = [];

beforeEach(() => {
  jest.clearAllMocks();
  calls.length = 0;
  authUser = { id: "user-1", email: "learner@example.test" } as User;
  libraryResponse = page(LIBRARY);
  continueResponse = page([LIBRARY[1], LIBRARY[2]], { filter: "continue" });
  libraryGate = null;
  window.sessionStorage.clear();
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.startsWith("/api/dashboard/summary")) return json(SUMMARY);
    if (url.startsWith("/api/dashboard/error-patterns")) return json({ total: 0, patterns: [] });
    if (url.startsWith("/api/videos/library?")) {
      if (url.includes("filter=continue")) return json(continueResponse);
      if (libraryGate) await libraryGate;
      return json(libraryResponse);
    }
    if (url.startsWith("/api/videos/library/")) return json({ removed: true });
    if (url.startsWith("/api/video/resolve")) return json({ videoId: "dQw4w9WgXcQ", status: "ok", libraryAdded: true });
    return json({});
  }) as typeof fetch;
});

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
function renderDashboard(client = newClient()) {
  return { client, ...render(<QueryClientProvider client={client}><DashboardPage /></QueryClientProvider>) };
}

describe("Library cards", () => {
  it("one card per video, each state distinct; coverage is the only bar (never accuracy)", async () => {
    renderDashboard();
    const grid = await screen.findByTestId("library-grid");
    expect(within(grid).getAllByRole("article")).toHaveLength(LIBRARY.length);

    const fresh = within(grid).getByTestId("library-card-vNew");
    expect(fresh).toHaveTextContent("Not started");
    expect(within(fresh).getByText("Start")).toHaveAttribute("href", "/dictation/vNew");

    const prog = within(grid).getByTestId("library-card-vProgress");
    expect(prog).toHaveTextContent("1/10 sentences practiced");
    expect(prog).toHaveTextContent("Completed before");
    expect(prog.querySelector('[style*="width"]')?.getAttribute("style")).toContain("width: 10%");
    expect(within(prog).queryByTestId("library-accuracy")).toBeNull(); // 100% accuracy never shown as progress

    const listen = within(grid).getByTestId("library-card-vListen");
    expect(listen).toHaveTextContent("Listened 45%");
    expect(within(listen).getByText("Continue")).toHaveAttribute("href", "/dictation/vListen?mode=listening");
    expect(listen).not.toHaveTextContent("Not started");

    const old = within(grid).getByTestId("library-card-vOldRev");
    expect(old).toHaveTextContent("Previously listened (script updated)");
    expect(old).not.toHaveTextContent("Not started");

    expect(within(grid).getByTestId("library-card-vLegacy")).toHaveTextContent("Completed · started before detailed tracking");
    const done = within(grid).getByTestId("library-card-vDone");
    expect(done).toHaveTextContent("Practice complete");
    expect(within(done).getByTestId("library-accuracy")).toHaveTextContent("Sentence accuracy 80% (8/10 latest answers)");
    expect(within(done).getByText("Review report")).toHaveAttribute("href", "/results/r-done");
  });

  it("Continue Learning shows real unfinished work in any mode — including Listening-only", async () => {
    renderDashboard();
    const cont = await screen.findByTestId("continue-learning");
    expect(within(cont).getByTestId("library-card-vProgress")).toBeInTheDocument();
    expect(within(cont).getByTestId("library-card-vListen")).toBeInTheDocument();
    expect(calls).toContain("GET /api/videos/library?filter=continue&offset=0&limit=3");
  });

  it("metrics stay separate: verified completions with a separate 'started before detailed tracking' note; missing metrics show '—'", async () => {
    renderDashboard();
    await screen.findByText("Completed videos");
    expect(screen.getByText("+2 in rounds started before detailed tracking")).toBeInTheDocument();
    expect(screen.getByText("3/4 latest answers")).toBeInTheDocument();
    const pron = screen.getByText("Pronunciation").closest("div")!.parentElement!;
    expect(pron).toHaveTextContent("—");
    const time = screen.getByText("Est. active practice").closest("div")!.parentElement!;
    expect(time).toHaveTextContent("—");
  });
});

describe("Remove from library", () => {
  it("asks first, says what is kept, removes only membership, then refreshes the Library", async () => {
    renderDashboard();
    const grid = await screen.findByTestId("library-grid");
    fireEvent.click(within(grid).getByLabelText("Remove Title vDone from your library"));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("rounds, answers, recordings, reports and listening progress are kept");
    libraryResponse = page(LIBRARY.filter((i) => i.videoId !== "vDone"));
    fireEvent.click(within(dialog).getByText("Remove"));
    await waitFor(() => expect(calls).toContain("DELETE /api/videos/library/vDone"));
    await waitFor(() => expect(screen.queryByTestId("library-card-vDone")).toBeNull());
  });
});

describe("Add Video", () => {
  it("one URL field, no mode choice; opens the practice page without ?mode=", async () => {
    renderDashboard();
    await screen.findByTestId("library-grid");
    expect(screen.queryByText("Dictation Practice")).toBeNull();
    expect(screen.queryByText("Listening Practice")).toBeNull();
    fireEvent.change(screen.getByLabelText("YouTube URL"), { target: { value: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" } });
    fireEvent.click(screen.getByText("Add video"));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/dictation/dQw4w9WgXcQ"));
  });
});

describe("cache behavior", () => {
  it("a background refresh keeps the current cards on screen", async () => {
    const { client } = renderDashboard();
    await screen.findByTestId("library-card-vDone");
    let release!: () => void;
    libraryGate = new Promise<void>((r) => (release = r));
    await act(async () => {
      void client.invalidateQueries({ queryKey: videoLibraryKeys.allForUser("user-1") });
    });
    expect(screen.getByTestId("library-card-vDone")).toBeInTheDocument(); // still visible while refetching
    await act(async () => {
      release();
    });
  });

  it("another account never sees this account's cached Library", async () => {
    const client = newClient();
    client.setQueryData(videoLibraryKeys.list("user-1", "all"), { pages: [page(LIBRARY)], pageParams: [0] });
    authUser = { id: "user-2", email: "other@example.test" } as User;
    libraryResponse = page([item("vOther")]);
    continueResponse = page([], { filter: "continue" });
    renderDashboard(client);
    await screen.findByTestId("library-card-vOther");
    expect(screen.queryByTestId("library-card-vDone")).toBeNull();
  });
});

// ---------------------------------------------------------------- earlier rounds' reports

import { LibraryCard } from "@/components/library/LibraryCard";

describe("one report link on every card: Review report", () => {
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
