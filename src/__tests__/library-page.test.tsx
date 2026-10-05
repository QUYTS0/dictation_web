/**
 * My Learning (/library) — the user's Library as its own page (component
 * tests, fetch mocked — not a real browser):
 *   - loads the Library only here (fn_video_library via /api/videos/library);
 *   - every state including added-but-not-started; the five status filters;
 *   - Open/Continue/Start routes; Load more pagination;
 *   - removal: confirmation, membership-only DELETE, the card disappears;
 *     nothing else (History, rounds) is written;
 *   - another account never sees this account's cached Library.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { User } from "@supabase/supabase-js";
import type { LibraryFilter, LibraryItem, LibraryPage } from "@/lib/types/learning";
import { videoLibraryKeys } from "@/lib/queries/videoLibrary";

let authUser: User = { id: "user-1", email: "learner@example.test" } as User;
jest.mock("@/context/auth", () => ({
  useAuth: () => ({ user: authUser, loading: false, openAuthModal: jest.fn() }),
}));
jest.mock("next/navigation", () => ({
  usePathname: () => "/library",
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
jest.mock("@/components/AppHeader", () => function AppHeader({ active }: { active: string }) {
  return <div data-testid="app-header" data-active={active} />;
});

import MyLearningPage from "@/app/library/page";

const LISTENING: LibraryItem["listening"] = { transcriptId: "tr", coverageRatio: null, listenedThrough: false, lastPositionSec: null, hasHistory: false, historyOnOtherRevision: false };
const progress = (covered: number, required: number) => ({
  requiredSentenceCount: required,
  coveredSentences: { dictation: covered, shadowing: 0, overall: covered },
  coverage: { dictation: covered / required, shadowing: 0, overall: covered / required },
  attemptCount: covered,
  sentenceAccuracy: { correct: covered, practiced: covered, percent: 100 },
});
function item(videoId: string, state: LibraryItem["state"], over: Partial<LibraryItem> = {}): LibraryItem {
  return {
    videoId,
    title: `Title ${videoId}`,
    addedAt: "2026-09-01T00:00:00Z",
    lastActivityAt: "2026-09-02T00:00:00Z",
    lastMode: null,
    state,
    hasCompletedRound: state === "completed",
    hasLegacyCompletion: false,
    completedRoundCount: state === "completed" ? 1 : 0,
    round:
      state === "in_progress" || state === "completed"
        ? { roundId: `r-${videoId}`, status: state === "completed" ? "completed" : "active", provenance: "current", roundNumber: 1, transcriptId: "tr", startedAt: "2026-09-01T00:00:00Z", completedAt: null, currentSegmentIndex: 0, progress: progress(state === "completed" ? 10 : 3, 10) }
        : null,
    listening: state === "listening" ? { ...LISTENING, coverageRatio: 0.4, hasHistory: true } : LISTENING,
    ...over,
  };
}
const ALL = [item("vNew", "not_started"), item("vProg", "in_progress"), item("vDone", "completed"), item("vListen", "listening")];
const page = (items: LibraryItem[], filter: LibraryFilter, extra: Partial<LibraryPage> = {}): LibraryPage => ({ items, total: items.length, limit: 12, offset: 0, filter, hasMore: false, ...extra });
const BY_FILTER: Record<string, (i: LibraryItem) => boolean> = {
  all: () => true,
  in_progress: (i) => i.state === "in_progress",
  not_started: (i) => i.state === "not_started",
  completed: (i) => i.state === "completed",
  listening: (i) => i.state === "listening",
};

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
let library: LibraryItem[];
let pageTwo: LibraryItem[] | null;
const calls: string[] = [];

beforeEach(() => {
  jest.clearAllMocks();
  calls.length = 0;
  authUser = { id: "user-1", email: "learner@example.test" } as User;
  library = [...ALL];
  pageTwo = null;
  window.sessionStorage.clear();
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);
    if (method === "DELETE" && url.startsWith("/api/videos/library/")) {
      const id = decodeURIComponent(url.split("/").pop()!);
      library = library.filter((i) => i.videoId !== id);
      return json({ removed: true });
    }
    if (url.startsWith("/api/videos/library?")) {
      const q = new URLSearchParams(url.split("?")[1]);
      const filter = q.get("filter") as LibraryFilter;
      const items = library.filter(BY_FILTER[filter]);
      const offset = Number(q.get("offset"));
      if (pageTwo && offset > 0) return json(page(pageTwo, filter, { offset, total: items.length + pageTwo.length }));
      return json(page(items, filter, pageTwo ? { hasMore: true, total: items.length + pageTwo.length } : {}));
    }
    return json({}, 404);
  }) as typeof fetch;
});

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
const renderPage = (client = newClient()) => render(<QueryClientProvider client={client}><MyLearningPage /></QueryClientProvider>);

describe("My Learning", () => {
  it("is the Library page: header marks it active, loads the Library, shows every state incl. added-but-not-started", async () => {
    renderPage();
    expect(screen.getByTestId("app-header")).toHaveAttribute("data-active", "library");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("My Learning");
    const grid = await screen.findByTestId("library-grid");
    expect(within(grid).getAllByRole("article")).toHaveLength(4);
    expect(calls).toEqual(["GET /api/videos/library?filter=all&offset=0&limit=12"]);
    const fresh = within(grid).getByTestId("library-card-vNew");
    expect(fresh).toHaveTextContent("Not started");
    expect(within(fresh).getByRole("link", { name: "Start" })).toHaveAttribute("href", "/dictation/vNew");
    expect(within(within(grid).getByTestId("library-card-vProg")).getByRole("link", { name: "Continue" })).toHaveAttribute("href", "/dictation/vProg");
    expect(within(within(grid).getByTestId("library-card-vListen")).getByRole("link", { name: "Continue" })).toHaveAttribute("href", "/dictation/vListen?mode=listening");
    const done = within(grid).getByTestId("library-card-vDone");
    expect(within(done).getByRole("link", { name: "Open" })).toHaveAttribute("href", "/dictation/vDone");
    expect(within(done).getByRole("link", { name: "Review report" })).toHaveAttribute("href", "/results/r-vDone");
  });

  it.each([
    ["In progress", "in_progress", ["vProg"]],
    ["Not started", "not_started", ["vNew"]],
    ["Completed", "completed", ["vDone"]],
    ["Listening", "listening", ["vListen"]],
    ["All", "all", ["vNew", "vProg", "vDone", "vListen"]],
  ])("filter %s requests filter=%s and shows only matching videos", async (label, filter, ids) => {
    renderPage();
    await screen.findByTestId("library-grid");
    const tabs = screen.getByRole("tablist", { name: "Filter my learning" });
    expect(within(tabs).getAllByRole("tab").map((t) => t.textContent)).toEqual(["All", "In progress", "Not started", "Completed", "Listening"]);
    if (filter !== "all") fireEvent.click(within(tabs).getByRole("tab", { name: "All" })); // start from All
    fireEvent.click(within(tabs).getByRole("tab", { name: label }));
    expect(within(tabs).getByRole("tab", { name: label })).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(calls).toContain(`GET /api/videos/library?filter=${filter}&offset=0&limit=12`));
    await waitFor(() => expect(within(screen.getByTestId("library-grid")).getAllByRole("article").map((a) => a.getAttribute("data-testid"))).toEqual(ids.map((id) => `library-card-${id}`)));
  });

  it("Load more fetches the next page and appends it", async () => {
    pageTwo = [item("vMore", "not_started")];
    renderPage();
    await screen.findByTestId("library-grid");
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByTestId("library-card-vMore")).toBeInTheDocument();
    expect(calls).toContain("GET /api/videos/library?filter=all&offset=4&limit=12"); // next offset = items already shown
    expect(screen.getByTestId("library-card-vNew")).toBeInTheDocument();
  });

  it("remove asks first, says what is kept, deletes membership only, then the card disappears; History/rounds are not written", async () => {
    renderPage();
    const grid = await screen.findByTestId("library-grid");
    fireEvent.click(within(grid).getByLabelText("Remove Title vDone from your library"));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("rounds, answers, recordings, reports and listening progress are kept");
    fireEvent.click(within(dialog).getByText("Remove"));
    await waitFor(() => expect(calls).toContain("DELETE /api/videos/library/vDone"));
    await waitFor(() => expect(screen.queryByTestId("library-card-vDone")).toBeNull());
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(calls.filter((c) => !c.startsWith("GET "))).toEqual(["DELETE /api/videos/library/vDone"]);
  });

  it("cancelling the confirmation removes nothing", async () => {
    renderPage();
    const grid = await screen.findByTestId("library-grid");
    fireEvent.click(within(grid).getByLabelText("Remove Title vNew from your library"));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByText("Cancel"));
    expect(screen.getByTestId("library-card-vNew")).toBeInTheDocument();
    expect(calls.some((c) => c.startsWith("DELETE"))).toBe(false);
  });

  it("an empty Library points to adding a video from the Dashboard", async () => {
    library = [];
    renderPage();
    expect(await screen.findByText(/haven.t saved any videos yet/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Add one from the Dashboard" })).toHaveAttribute("href", "/dashboard");
  });

  it("another account never sees this account's cached Library", async () => {
    const client = newClient();
    client.setQueryData(videoLibraryKeys.list("user-1", "all"), { pages: [page(ALL, "all")], pageParams: [0] });
    authUser = { id: "user-2", email: "other@example.test" } as User;
    library = [item("vOther", "not_started")];
    renderPage(client);
    await screen.findByTestId("library-card-vOther");
    expect(screen.queryByTestId("library-card-vDone")).toBeNull();
  });
});
