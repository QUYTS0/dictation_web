import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { VocabularyItem, VocabularyStatsResponse } from "@/lib/types";

let mockUser: { id: string } | null = { id: "user-1" };
jest.mock("@/context/auth", () => ({
  useAuth: () => ({ user: mockUser, loading: false, openAuthModal: jest.fn() }),
}));

// Sidesteps next/link's internal app-router prefetch wiring (which needs a
// full router context this test doesn't set up) — the page only needs these
// to render as plain links, never actually navigated in these tests.
jest.mock("next/link", () => {
  return function MockLink({
    href,
    children,
    ...rest
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; children: React.ReactNode }) {
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  };
});

import { vocabularyKeys } from "@/lib/queries/vocabulary";
import VocabularyPage from "@/app/vocabulary/page";

const NOW = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;
const PAST = (days: number) => new Date(NOW - days * DAY_MS).toISOString();
const FUTURE = (days: number) => new Date(NOW + days * DAY_MS).toISOString();

function makeItem(overrides: Partial<VocabularyItem> = {}): VocabularyItem {
  return {
    id: "item-1",
    user_id: "user-1",
    video_id: "video-1",
    segment_index: 0,
    term: "reimburse",
    normalized_term: "reimburse",
    canonical_form: null,
    learning_pattern: null,
    sentence_context: "The company will reimburse your travel expenses.",
    note: null,
    translation: "hoàn trả",
    translation_language: "vi",
    translation_source: "azure",
    phonetic: null,
    part_of_speech: null,
    definition: null,
    definition_source: null,
    audio_url: null,
    pronunciation_audio_asset_id: null,
    image_url: null,
    image_thumbnail_url: null,
    image_attribution: null,
    image_source_url: null,
    created_at: PAST(10),
    next_review_at: PAST(1),
    interval_days: 0,
    ease_factor: 2.5,
    repetitions: 0,
    last_reviewed_at: null,
    ...overrides,
  };
}

const STATS_ZERO: VocabularyStatsResponse = { total: 0, new: 0, learning: 0, due: 0, reviewable: 0 };

function jsonResponse(body: unknown, ok = true): Promise<Response> {
  return Promise.resolve({ ok, json: async () => body } as Response);
}

function mockFetchFor(items: VocabularyItem[], stats: VocabularyStatsResponse) {
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("/api/vocabulary/stats")) return jsonResponse(stats);
    if (url.startsWith("/api/vocabulary")) return jsonResponse({ items });
    return Promise.reject(new Error(`Unhandled fetch in test: ${url}`));
  }) as unknown as typeof fetch;
}

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
}

function renderPage(queryClient: QueryClient = makeQueryClient()) {
  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <VocabularyPage />
      </QueryClientProvider>
    ),
  };
}

describe("VocabularyPage", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    mockUser = { id: "user-1" };
    window.sessionStorage.clear();
    // matchMedia isn't implemented in jsdom; motion/react's reduced-motion
    // check reads it on mount.
    if (!window.matchMedia) {
      Object.defineProperty(window, "matchMedia", {
        writable: true,
        value: jest.fn().mockImplementation((query: string) => ({
          matches: false,
          media: query,
          addEventListener: jest.fn(),
          removeEventListener: jest.fn(),
        })),
      });
    }
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("learning status is independent of whether the item has a personal note", async () => {
    mockFetchFor(
      [
        makeItem({ id: "no-note", term: "postpone", note: null }),
        makeItem({ id: "with-note", term: "reimburse", note: "remember this one" }),
      ],
      { ...STATS_ZERO, total: 2, new: 2, reviewable: 2 }
    );

    renderPage();

    await waitFor(() => expect(screen.getAllByTestId("vocab-card")).toHaveLength(2));

    const noteless = screen.getByText("postpone").closest('[data-testid="vocab-card"]') as HTMLElement;
    const withNote = screen.getByText("reimburse").closest('[data-testid="vocab-card"]') as HTMLElement;
    expect(within(noteless).getByTestId("vocab-status-badge").textContent).toBe("New");
    expect(within(withNote).getByTestId("vocab-status-badge").textContent).toBe("New");
  });

  it("renders the stat header and the review-session count from server-computed stats", async () => {
    mockFetchFor([makeItem()], { total: 10, new: 4, learning: 3, due: 3, reviewable: 7 });

    renderPage();

    await waitFor(() => expect(screen.getByTestId("vocab-stat-total-words")).toHaveTextContent("10"));
    expect(screen.getByTestId("vocab-stat-new")).toHaveTextContent("4");
    expect(screen.getByTestId("vocab-stat-learning")).toHaveTextContent("3");
    expect(screen.getByTestId("vocab-stat-due")).toHaveTextContent("3");
    expect(screen.getByRole("link", { name: /Start review session \(7\)/ })).toBeInTheDocument();
  });

  it("status filter shows only cards matching the selected status", async () => {
    mockFetchFor(
      [
        makeItem({ id: "new-1", term: "alpha", last_reviewed_at: null }),
        makeItem({ id: "learning-1", term: "beta", last_reviewed_at: PAST(5), next_review_at: FUTURE(5) }),
        makeItem({ id: "due-1", term: "gamma", last_reviewed_at: PAST(5), next_review_at: PAST(1) }),
      ],
      { ...STATS_ZERO, total: 3 }
    );

    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getAllByTestId("vocab-card")).toHaveLength(3));

    await user.click(screen.getByRole("button", { name: /^Filter$/ }));
    await user.click(screen.getByRole("button", { name: "Due" }));

    await waitFor(() => {
      const cards = screen.getAllByTestId("vocab-card");
      expect(cards).toHaveLength(1);
      expect(cards[0]).toHaveAttribute("data-item-id", "due-1");
    });
  });

  it("type filter uses the shared word/phrase inference and shows only matching cards", async () => {
    mockFetchFor(
      [
        makeItem({ id: "word-1", term: "run", sentence_context: "I like to run every morning." }),
        makeItem({
          id: "phrase-1",
          term: "give up the fight",
          sentence_context: "He refused to give up the fight.",
        }),
      ],
      { ...STATS_ZERO, total: 2 }
    );

    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getAllByTestId("vocab-card")).toHaveLength(2));

    await user.click(screen.getByRole("button", { name: /^Filter$/ }));
    await user.click(screen.getByRole("button", { name: "Phrases" }));

    await waitFor(() => {
      const cards = screen.getAllByTestId("vocab-card");
      expect(cards).toHaveLength(1);
      expect(cards[0]).toHaveAttribute("data-item-id", "phrase-1");
    });
  });

  it("distinguishes a genuinely empty account from a filtered-to-empty result", async () => {
    mockFetchFor([], STATS_ZERO);
    renderPage();
    await waitFor(() => expect(screen.getByText("No saved vocabulary yet.")).toBeInTheDocument());
  });

  it("shows filtered-empty copy (not the true-empty copy) when a search matches nothing", async () => {
    mockFetchFor([makeItem({ term: "postpone" })], { ...STATS_ZERO, total: 1 });
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getAllByTestId("vocab-card")).toHaveLength(1));

    await user.type(screen.getByPlaceholderText("Search words, notes, or sentences..."), "zzz-no-match");

    await waitFor(() => expect(screen.getByText("No results match your search or filters.")).toBeInTheDocument());
    expect(screen.queryByText("No saved vocabulary yet.")).not.toBeInTheDocument();
  });

  it("keeps previously loaded cards and stats visible during a background refetch, with no loading flash", async () => {
    const queryClient = makeQueryClient();
    const cachedItems = [makeItem({ id: "cached-1", term: "cached-word" })];
    const cachedStats: VocabularyStatsResponse = { total: 1, new: 1, learning: 0, due: 0, reviewable: 1 };
    queryClient.setQueryData(vocabularyKeys.items("user-1"), cachedItems);
    queryClient.setQueryData(vocabularyKeys.stats("user-1"), cachedStats);

    // Background refetch that never resolves within this test — simulates
    // "still fetching" without ever completing.
    global.fetch = jest.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;

    renderPage(queryClient);

    // Cached content renders immediately; no "Loading vocabulary…" flash.
    expect(screen.getByText("cached-word")).toBeInTheDocument();
    expect(screen.queryByText("Loading vocabulary…")).not.toBeInTheDocument();
    expect(screen.getByTestId("vocab-stat-total-words")).toHaveTextContent("1");
  });

  it("does not persist search text across a remount — a bare nav-tab return always starts from Search empty", async () => {
    mockFetchFor([makeItem({ term: "postpone" })], { ...STATS_ZERO, total: 1 });
    const user = userEvent.setup();
    const { unmount } = renderPage();
    await waitFor(() => expect(screen.getAllByTestId("vocab-card")).toHaveLength(1));

    await user.type(screen.getByPlaceholderText("Search words, notes, or sentences..."), "postpone");
    expect((screen.getByPlaceholderText("Search words, notes, or sentences...") as HTMLInputElement).value).toBe(
      "postpone"
    );

    // Nothing is ever written to sessionStorage for this page anymore.
    expect(window.sessionStorage.getItem("vocab-viewstate:user-1")).toBeNull();

    unmount();
    renderPage();
    await waitFor(() => expect(screen.getAllByTestId("vocab-card")).toHaveLength(1));
    expect((screen.getByPlaceholderText("Search words, notes, or sentences...") as HTMLInputElement).value).toBe("");
  });

  it("resets Type and Status filters to All on remount, even though the underlying query cache stays warm", async () => {
    const queryClient = makeQueryClient();
    mockFetchFor(
      [
        makeItem({ id: "new-1", term: "alpha", last_reviewed_at: null }),
        makeItem({ id: "due-1", term: "gamma", last_reviewed_at: PAST(5), next_review_at: PAST(1) }),
      ],
      { ...STATS_ZERO, total: 2 }
    );

    const user = userEvent.setup();
    const { unmount } = renderPage(queryClient);
    await waitFor(() => expect(screen.getAllByTestId("vocab-card")).toHaveLength(2));

    await user.click(screen.getByRole("button", { name: /^Filter$/ }));
    await user.click(screen.getByRole("button", { name: "Due" }));
    await waitFor(() => expect(screen.getAllByTestId("vocab-card")).toHaveLength(1));

    unmount();
    // Same QueryClient (same warm cache) — only the component remounts, the
    // way a nav-tab click would.
    renderPage(queryClient);

    // Cached data renders immediately (no fetch needed — see the
    // background-refetch test above for the no-cache-yet case), but the
    // filter selection itself is not remembered: both filters are back to
    // "All" and both items are visible again.
    await waitFor(() => expect(screen.getAllByTestId("vocab-card")).toHaveLength(2));
    await user.click(screen.getByRole("button", { name: /^Filter$/ }));
    // Both the Type and Status pill groups are back on "All".
    for (const allPill of screen.getAllByRole("button", { name: "All" })) {
      expect(allPill).toHaveAttribute("aria-pressed", "true");
    }
  });

  it("resets scroll position on remount — the page itself has no persisted scroll state to restore", async () => {
    mockFetchFor([makeItem({ term: "postpone" })], { ...STATS_ZERO, total: 1 });
    renderPage();
    await waitFor(() => expect(screen.getAllByTestId("vocab-card")).toHaveLength(1));

    // No scroll:* key is ever written for this route.
    expect(window.sessionStorage.getItem("scroll:/vocabulary:user-1")).toBeNull();
  });
});
