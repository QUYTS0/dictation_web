import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import { PAGE_WIDTH_CLASS } from "@/lib/layout/pageWidth";
import { MAX_BULK_SELECTABLE_ITEMS } from "@/lib/utils/vocabulary";
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
    if (url.startsWith("/api/vocabulary/bulk-delete")) return jsonResponse({ deletedIds: [] });
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

  it("renders the stat strip from server-computed stats", async () => {
    mockFetchFor([makeItem()], { total: 10, new: 4, learning: 3, due: 3, reviewable: 7 });

    renderPage();

    await waitFor(() => expect(screen.getByTestId("vocab-stat-total-words")).toHaveTextContent("10"));
    expect(screen.getByTestId("vocab-stat-new")).toHaveTextContent("4");
    expect(screen.getByTestId("vocab-stat-learning")).toHaveTextContent("3");
    expect(screen.getByTestId("vocab-stat-due")).toHaveTextContent("3");
  });

  it("never prints a session-size count or an ordering claim on the primary CTA", async () => {
    mockFetchFor([makeItem()], { total: 254, new: 232, learning: 0, due: 22, reviewable: 254 });
    renderPage();

    await waitFor(() => expect(screen.getByText("22 words are due")).toBeInTheDocument());
    const cta = screen.getByRole("link", { name: "Start review" });
    expect(cta).toBeInTheDocument();
    expect(screen.queryByText(/\(\d+\)/)).not.toBeInTheDocument();
    expect(screen.queryByText(/prioriti/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/due first/i)).not.toBeInTheDocument();
  });

  it("clicking the Due metric shows only cards matching due status", async () => {
    mockFetchFor(
      [
        makeItem({ id: "new-1", term: "alpha", last_reviewed_at: null }),
        makeItem({ id: "learning-1", term: "beta", last_reviewed_at: PAST(5), next_review_at: FUTURE(5) }),
        makeItem({ id: "due-1", term: "gamma", last_reviewed_at: PAST(5), next_review_at: PAST(1) }),
      ],
      { ...STATS_ZERO, total: 3, new: 1, learning: 1, due: 1, reviewable: 2 }
    );

    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getAllByTestId("vocab-card")).toHaveLength(3));

    await user.click(screen.getByTestId("vocab-stat-due"));

    await waitFor(() => {
      const cards = screen.getAllByTestId("vocab-card");
      expect(cards).toHaveLength(1);
      expect(cards[0]).toHaveAttribute("data-item-id", "due-1");
    });
    expect(screen.getByTestId("vocab-stat-due")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("vocab-stat-total-words")).toHaveAttribute("aria-pressed", "false");
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

  it("no longer renders a Status pill group inside the Filter panel — Status lives in the metric strip", async () => {
    mockFetchFor([makeItem()], { ...STATS_ZERO, total: 1 });
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getAllByTestId("vocab-card")).toHaveLength(1));

    await user.click(screen.getByRole("button", { name: /^Filter$/ }));
    expect(screen.queryByText("Status")).not.toBeInTheDocument();
    expect(screen.getByText("Type")).toBeInTheDocument();
  });

  it("counts Type and Status as separate active filter dimensions on the collapsed Filter button", async () => {
    mockFetchFor(
      [makeItem({ id: "phrase-due", term: "give up the fight", last_reviewed_at: PAST(5), next_review_at: PAST(1) })],
      { ...STATS_ZERO, total: 1, due: 1, reviewable: 1 }
    );
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getAllByTestId("vocab-card")).toHaveLength(1));

    expect(screen.getByRole("button", { name: /^Filter$/ })).toBeInTheDocument();

    // Status is set via the metric strip, not the Filter panel itself — the
    // Filter button's count must still account for it as an active dimension.
    await user.click(screen.getByTestId("vocab-stat-due"));
    expect(screen.getByRole("button", { name: "Filter (1)" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Filter (1)" }));
    await user.click(screen.getByRole("button", { name: "Phrases" }));

    expect(screen.getByRole("button", { name: "Filter (2)" })).toBeInTheDocument();
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

    await user.click(screen.getByRole("button", { name: "Search" }));
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

    // Cached content renders immediately; no "Loading vocabulary…" flash,
    // and no hero-loading skeleton either (stats already has cached data).
    expect(screen.getByText("cached-word")).toBeInTheDocument();
    expect(screen.queryByText("Loading vocabulary…")).not.toBeInTheDocument();
    expect(screen.queryByTestId("vocab-hero-loading")).not.toBeInTheDocument();
    expect(screen.getByTestId("vocab-stat-total-words")).toHaveTextContent("1");
  });

  it("does not persist search text across a remount — a bare nav-tab return always starts from Search empty", async () => {
    mockFetchFor([makeItem({ term: "postpone" })], { ...STATS_ZERO, total: 1 });
    const user = userEvent.setup();
    const { unmount } = renderPage();
    await waitFor(() => expect(screen.getAllByTestId("vocab-card")).toHaveLength(1));

    await user.click(screen.getByRole("button", { name: "Search" }));
    await user.type(screen.getByPlaceholderText("Search words, notes, or sentences..."), "postpone");
    expect((screen.getByPlaceholderText("Search words, notes, or sentences...") as HTMLInputElement).value).toBe(
      "postpone"
    );

    // Nothing is ever written to sessionStorage for this page anymore.
    expect(window.sessionStorage.getItem("vocab-viewstate:user-1")).toBeNull();

    unmount();
    renderPage();
    await waitFor(() => expect(screen.getAllByTestId("vocab-card")).toHaveLength(1));
    expect(screen.queryByPlaceholderText("Search words, notes, or sentences...")).not.toBeInTheDocument();
  });

  it("resets Type and Status filters to All on remount, even though the underlying query cache stays warm", async () => {
    const queryClient = makeQueryClient();
    mockFetchFor(
      [
        makeItem({ id: "new-1", term: "alpha", last_reviewed_at: null }),
        makeItem({ id: "due-1", term: "gamma", last_reviewed_at: PAST(5), next_review_at: PAST(1) }),
      ],
      { ...STATS_ZERO, total: 2, new: 1, due: 1, reviewable: 2 }
    );

    const user = userEvent.setup();
    const { unmount } = renderPage(queryClient);
    await waitFor(() => expect(screen.getAllByTestId("vocab-card")).toHaveLength(2));

    await user.click(screen.getByTestId("vocab-stat-due"));
    await waitFor(() => expect(screen.getAllByTestId("vocab-card")).toHaveLength(1));

    unmount();
    // Same QueryClient (same warm cache) — only the component remounts, the
    // way a nav-tab click would.
    renderPage(queryClient);

    // Cached data renders immediately (no fetch needed — see the
    // background-refetch test above for the no-cache-yet case), but the
    // filter selection itself is not remembered: Status is back to "all"
    // (Total Words active, not Due) and both items are visible again.
    await waitFor(() => expect(screen.getAllByTestId("vocab-card")).toHaveLength(2));
    expect(screen.getByTestId("vocab-stat-total-words")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("vocab-stat-due")).toHaveAttribute("aria-pressed", "false");
    await user.click(screen.getByRole("button", { name: /^Filter$/ }));
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
  });

  it("resets scroll position on remount — the page itself has no persisted scroll state to restore", async () => {
    mockFetchFor([makeItem({ term: "postpone" })], { ...STATS_ZERO, total: 1 });
    renderPage();
    await waitFor(() => expect(screen.getAllByTestId("vocab-card")).toHaveLength(1));

    // No scroll:* key is ever written for this route.
    expect(window.sessionStorage.getItem("scroll:/vocabulary:user-1")).toBeNull();
  });

  it("uses the shared wide width primitive for its <main> content", async () => {
    mockFetchFor([makeItem({ term: "postpone" })], { ...STATS_ZERO, total: 1 });
    renderPage();
    await waitFor(() => expect(screen.getAllByTestId("vocab-card")).toHaveLength(1));

    expect(screen.getByRole("main").className).toContain(PAGE_WIDTH_CLASS.wide);
  });

  describe("review hero", () => {
    it("shows a loading skeleton and no CTA while stats have not loaded yet", async () => {
      global.fetch = jest.fn((input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.startsWith("/api/vocabulary/stats")) return new Promise<Response>(() => {});
        if (url.startsWith("/api/vocabulary")) return jsonResponse({ items: [] });
        return Promise.reject(new Error(`Unhandled fetch in test: ${url}`));
      }) as unknown as typeof fetch;

      renderPage();

      expect(await screen.findByTestId("vocab-hero-loading")).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Start review" })).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Start a dictation session" })).not.toBeInTheDocument();
    });

    it("shows the empty-library state and a link to start a dictation session when Total is 0", async () => {
      mockFetchFor([], STATS_ZERO);
      renderPage();

      expect(await screen.findByText("Save your first word")).toBeInTheDocument();
      const cta = screen.getByRole("link", { name: "Start a dictation session" });
      expect(cta).toHaveAttribute("href", "/");
      expect(screen.queryByRole("link", { name: "Start review" })).not.toBeInTheDocument();
    });

    it("shows the all-caught-up state with no CTA when nothing is reviewable", async () => {
      mockFetchFor([makeItem()], { total: 5, new: 0, learning: 5, due: 0, reviewable: 0 });
      renderPage();

      expect(await screen.findByText("You're all caught up")).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Start review" })).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Start a dictation session" })).not.toBeInTheDocument();
    });

    it("shows the new-only state when reviewable items exist but none are due", async () => {
      mockFetchFor([makeItem()], { total: 5, new: 5, learning: 0, due: 0, reviewable: 5 });
      renderPage();

      expect(await screen.findByText("Ready to learn something new")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Start review" })).toHaveAttribute("href", "/vocabulary/review");
    });

    it("shows the due state with the exact due count and a plain Start review CTA", async () => {
      mockFetchFor([makeItem()], { total: 254, new: 232, learning: 0, due: 22, reviewable: 254 });
      renderPage();

      expect(await screen.findByText("22 words are due")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Start review" })).toHaveAttribute("href", "/vocabulary/review");
    });
  });

  describe("search collapse", () => {
    it("is collapsed by default and expands with focus when the Search button is clicked", async () => {
      mockFetchFor([makeItem({ term: "postpone" })], { ...STATS_ZERO, total: 1 });
      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getAllByTestId("vocab-card")).toHaveLength(1));

      expect(screen.queryByPlaceholderText("Search words, notes, or sentences...")).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Search" }));
      const input = screen.getByPlaceholderText("Search words, notes, or sentences...");
      expect(input).toHaveFocus();
    });

    it("preserves the query when Search is collapsed, and shows an active indicator", async () => {
      mockFetchFor([makeItem({ term: "postpone" })], { ...STATS_ZERO, total: 1 });
      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getAllByTestId("vocab-card")).toHaveLength(1));

      await user.click(screen.getByRole("button", { name: "Search" }));
      await user.type(screen.getByPlaceholderText("Search words, notes, or sentences..."), "zzz");
      await user.click(screen.getByRole("button", { name: "Close search" }));

      expect(screen.queryByPlaceholderText("Search words, notes, or sentences...")).not.toBeInTheDocument();
      // Collapsing must not silently clear the result set — the button
      // itself signals an active search, and reopening shows the query.
      expect(screen.getByTestId("search-active-indicator")).toBeInTheDocument();
      const searchButton = screen.getByRole("button", { name: "Search (active)" });

      await user.click(searchButton);
      expect((screen.getByPlaceholderText("Search words, notes, or sentences...") as HTMLInputElement).value).toBe(
        "zzz"
      );
    });

    it("collapses on Escape while preserving the query, not resetting it", async () => {
      mockFetchFor([makeItem({ term: "postpone" })], { ...STATS_ZERO, total: 1 });
      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getAllByTestId("vocab-card")).toHaveLength(1));

      await user.click(screen.getByRole("button", { name: "Search" }));
      await user.type(screen.getByPlaceholderText("Search words, notes, or sentences..."), "zzz");
      await user.keyboard("{Escape}");

      expect(screen.queryByPlaceholderText("Search words, notes, or sentences...")).not.toBeInTheDocument();
      expect(screen.getByTestId("search-active-indicator")).toBeInTheDocument();
    });

    it("clears the query via the explicit clear control inside the expanded field, removing the active indicator", async () => {
      mockFetchFor([makeItem({ term: "postpone" })], { ...STATS_ZERO, total: 1 });
      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getAllByTestId("vocab-card")).toHaveLength(1));

      await user.click(screen.getByRole("button", { name: "Search" }));
      await user.type(screen.getByPlaceholderText("Search words, notes, or sentences..."), "zzz");
      await user.click(screen.getByRole("button", { name: "Clear search" }));

      expect((screen.getByPlaceholderText("Search words, notes, or sentences...") as HTMLInputElement).value).toBe(
        ""
      );

      await user.click(screen.getByRole("button", { name: "Close search" }));
      expect(screen.queryByTestId("search-active-indicator")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Search" })).toBeInTheDocument();
    });
  });

  describe("multi-select and bulk delete", () => {
    function threeItems() {
      return [
        makeItem({ id: "a", term: "alpha" }),
        makeItem({ id: "b", term: "beta" }),
        makeItem({ id: "c", term: "gamma" }),
      ];
    }

    it("checking a card's checkbox selects it without opening the inspector, and the bulk bar swaps in place", async () => {
      mockFetchFor(threeItems(), { ...STATS_ZERO, total: 3 });
      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getAllByTestId("vocab-card")).toHaveLength(3));

      expect(screen.queryByTestId("vocab-bulk-bar")).not.toBeInTheDocument();
      expect(screen.getByTestId("vocab-stat-total-words")).toBeInTheDocument();

      await user.click(screen.getByRole("checkbox", { name: "Select alpha" }));

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.getByTestId("vocab-bulk-bar")).toHaveTextContent("1 selected");
      // Swapped in place — the metric strip is gone, not sitting alongside the bar.
      expect(screen.queryByTestId("vocab-stat-total-words")).not.toBeInTheDocument();
    });

    it("clears the selection via Clear selection", async () => {
      mockFetchFor(threeItems(), { ...STATS_ZERO, total: 3 });
      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getAllByTestId("vocab-card")).toHaveLength(3));

      await user.click(screen.getByRole("checkbox", { name: "Select alpha" }));
      await user.click(screen.getByRole("button", { name: "Clear selection" }));

      expect(screen.queryByTestId("vocab-bulk-bar")).not.toBeInTheDocument();
      expect(screen.getByRole("checkbox", { name: "Select alpha" })).not.toBeChecked();
    });

    it("clears the selection when the search query changes", async () => {
      mockFetchFor(threeItems(), { ...STATS_ZERO, total: 3 });
      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getAllByTestId("vocab-card")).toHaveLength(3));

      // Open search first — the expanded input stays mounted regardless of
      // the bulk bar swapping the command row above it (its own condition
      // is independent of selectedIds, see plan §E/§D).
      await user.click(screen.getByRole("button", { name: "Search" }));
      await user.click(screen.getByRole("checkbox", { name: "Select alpha" }));
      expect(screen.getByTestId("vocab-bulk-bar")).toBeInTheDocument();

      await user.type(screen.getByPlaceholderText("Search words, notes, or sentences..."), "a");

      await waitFor(() => expect(screen.queryByTestId("vocab-bulk-bar")).not.toBeInTheDocument());
    });

    it("disables further checking at the shared selection cap, without blocking unchecking", async () => {
      const items = Array.from({ length: MAX_BULK_SELECTABLE_ITEMS + 1 }, (_, i) =>
        makeItem({ id: `item-${i}`, term: `word${i}` })
      );
      mockFetchFor(items, { ...STATS_ZERO, total: items.length });
      renderPage();
      await waitFor(() => expect(screen.getAllByTestId("vocab-card")).toHaveLength(items.length));

      // fireEvent (not userEvent) for this loop — checking MAX_BULK_SELECTABLE_ITEMS
      // boxes via userEvent's full simulated pointer sequence is too slow to
      // fit a reasonable test timeout; fireEvent.click still toggles the
      // checkbox and dispatches onChange, which is all this needs.
      const checkboxes = screen.getAllByRole("checkbox");
      for (let i = 0; i < MAX_BULK_SELECTABLE_ITEMS; i++) {
        fireEvent.click(checkboxes[i]);
      }

      await waitFor(() =>
        expect(screen.getByTestId("vocab-bulk-bar")).toHaveTextContent(String(MAX_BULK_SELECTABLE_ITEMS))
      );
      const lastCheckbox = checkboxes[MAX_BULK_SELECTABLE_ITEMS];
      expect(lastCheckbox).toBeDisabled();

      // Unchecking an already-checked one is always allowed, even at the cap.
      expect(checkboxes[0]).not.toBeDisabled();
    }, 30000);

    it("requires confirmation before bulk deleting, and cancel changes nothing", async () => {
      mockFetchFor(threeItems(), { ...STATS_ZERO, total: 3 });
      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getAllByTestId("vocab-card")).toHaveLength(3));

      await user.click(screen.getByRole("checkbox", { name: "Select alpha" }));
      await user.click(screen.getByRole("checkbox", { name: "Select beta" }));
      await user.click(screen.getByRole("button", { name: "Delete" }));

      const dialog = await screen.findByRole("alertdialog");
      expect(dialog).toHaveTextContent("Delete 2 vocabulary items?");

      await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      expect(screen.getAllByTestId("vocab-card")).toHaveLength(3);
      expect(screen.getByTestId("vocab-bulk-bar")).toHaveTextContent("2 selected");
    });

    it("bulk deletes the confirmed selection, invalidating stats once and clearing selection", async () => {
      let statsCallCount = 0;
      const items = threeItems();
      global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.startsWith("/api/vocabulary/stats")) {
          statsCallCount += 1;
          return jsonResponse({ ...STATS_ZERO, total: statsCallCount === 1 ? 3 : 1 });
        }
        if (url.startsWith("/api/vocabulary/bulk-delete")) {
          const body = JSON.parse((init?.body as string) ?? "{}");
          return jsonResponse({ deletedIds: body.ids });
        }
        if (url.startsWith("/api/vocabulary")) return jsonResponse({ items });
        return Promise.reject(new Error(`Unhandled fetch in test: ${url}`));
      }) as unknown as typeof fetch;

      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getAllByTestId("vocab-card")).toHaveLength(3));

      await user.click(screen.getByRole("checkbox", { name: "Select alpha" }));
      await user.click(screen.getByRole("checkbox", { name: "Select beta" }));
      await user.click(screen.getByRole("button", { name: "Delete" }));

      const dialog = await screen.findByRole("alertdialog");
      await user.click(within(dialog).getByRole("button", { name: "Delete 2 items" }));

      await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
      await waitFor(() => expect(screen.getAllByTestId("vocab-card")).toHaveLength(1));
      expect(screen.queryByTestId("vocab-bulk-bar")).not.toBeInTheDocument();
      // One request for the initial load's stats + one from the single
      // post-delete invalidation — never one per deleted id.
      expect(statsCallCount).toBe(2);
    });

    it("closes the inspector if bulk delete removes the item currently open in it", async () => {
      const items = threeItems();
      global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.startsWith("/api/vocabulary/stats")) return jsonResponse({ ...STATS_ZERO, total: 3 });
        if (url.startsWith("/api/vocabulary/bulk-delete")) {
          const body = JSON.parse((init?.body as string) ?? "{}");
          return jsonResponse({ deletedIds: body.ids });
        }
        if (url.startsWith("/api/vocabulary")) return jsonResponse({ items });
        return Promise.reject(new Error(`Unhandled fetch in test: ${url}`));
      }) as unknown as typeof fetch;

      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getAllByTestId("vocab-card")).toHaveLength(3));

      await user.click(screen.getByRole("button", { name: "Open details for alpha" }));
      expect(await screen.findByRole("dialog")).toHaveTextContent("alpha");

      await user.click(screen.getByRole("checkbox", { name: "Select alpha" }));
      await user.click(within(screen.getByTestId("vocab-bulk-bar")).getByRole("button", { name: "Delete" }));
      const dialog = await screen.findByRole("alertdialog");
      await user.click(within(dialog).getByRole("button", { name: "Delete 1 item" }));

      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });
  });

  describe("detail drawer", () => {
    function mockViewport(isDesktop: boolean) {
      (window.matchMedia as jest.Mock).mockImplementation((query: string) => ({
        matches: query === "(min-width: 1024px)" ? isDesktop : false,
        media: query,
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      }));
    }

    it("opens the drawer with the clicked item's details, including a drawer-only field", async () => {
      mockViewport(true);
      mockFetchFor(
        [makeItem({ id: "item-1", term: "reimburse", definition: "to pay back money" })],
        { ...STATS_ZERO, total: 1 }
      );
      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getAllByTestId("vocab-card")).toHaveLength(1));

      await user.click(screen.getByRole("button", { name: "Open details for reimburse" }));

      const drawer = await screen.findByRole("dialog");
      expect(within(drawer).getByText("reimburse")).toBeInTheDocument();
      expect(within(drawer).getByText("to pay back money")).toBeInTheDocument();
    });

    it("switches to a different item without closing when another card is clicked", async () => {
      mockViewport(true);
      mockFetchFor(
        [makeItem({ id: "a", term: "alpha" }), makeItem({ id: "b", term: "beta" })],
        { ...STATS_ZERO, total: 2 }
      );
      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getAllByTestId("vocab-card")).toHaveLength(2));

      await user.click(screen.getByRole("button", { name: "Open details for alpha" }));
      expect(await screen.findByRole("dialog")).toHaveTextContent("alpha");

      await user.click(screen.getByRole("button", { name: "Open details for beta" }));
      const drawer = screen.getByRole("dialog");
      expect(drawer).toHaveTextContent("beta");
      expect(drawer).not.toHaveTextContent("alpha");
    });

    it("closes on Escape and via the close button", async () => {
      mockViewport(true);
      mockFetchFor([makeItem({ term: "postpone" })], { ...STATS_ZERO, total: 1 });
      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getAllByTestId("vocab-card")).toHaveLength(1));

      await user.click(screen.getByRole("button", { name: "Open details for postpone" }));
      expect(await screen.findByRole("dialog")).toBeInTheDocument();

      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

      await user.click(screen.getByRole("button", { name: "Open details for postpone" }));
      expect(await screen.findByRole("dialog")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Close vocabulary details" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });

    it("renders no empty placeholders for an item with every optional field null", async () => {
      mockViewport(true);
      mockFetchFor(
        [
          makeItem({
            term: "bare",
            phonetic: null,
            definition: null,
            note: null,
            part_of_speech: null,
            learning_pattern: null,
            translation: null,
            image_thumbnail_url: null,
          }),
        ],
        { ...STATS_ZERO, total: 1 }
      );
      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getAllByTestId("vocab-card")).toHaveLength(1));
      await user.click(screen.getByRole("button", { name: "Open details for bare" }));

      const drawer = await screen.findByRole("dialog");
      expect(within(drawer).queryByText("Definition")).not.toBeInTheDocument();
      expect(within(drawer).queryByText("Pattern")).not.toBeInTheDocument();
      expect(within(drawer).queryByText("—")).not.toBeInTheDocument();
    });

    it("reflects an edit made through the drawer without keeping a stale copy", async () => {
      mockViewport(true);
      const item = makeItem({ id: "item-1", term: "postpone", translation: "hoãn lại" });
      let currentItems = [item];
      global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = init?.method ?? "GET";
        if (url.startsWith("/api/vocabulary/stats")) return jsonResponse({ ...STATS_ZERO, total: 1 });
        if (url.startsWith("/api/vocabulary") && method === "PATCH") {
          const body = JSON.parse(init!.body as string);
          const updated = { ...item, translation: body.translation };
          currentItems = [updated];
          return jsonResponse({ item: updated });
        }
        if (url.startsWith("/api/vocabulary")) return jsonResponse({ items: currentItems });
        return Promise.reject(new Error(`Unhandled fetch in test: ${url}`));
      }) as unknown as typeof fetch;

      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getAllByTestId("vocab-card")).toHaveLength(1));

      await user.click(screen.getByRole("button", { name: "Open details for postpone" }));
      const drawer = await screen.findByRole("dialog");
      await user.click(within(drawer).getByRole("button", { name: "Edit" }));

      const translationInput = within(drawer).getByPlaceholderText("Translation");
      await user.clear(translationInput);
      await user.type(translationInput, "trì hoãn");
      await user.click(within(drawer).getByRole("button", { name: "Save" }));

      await waitFor(() => expect(within(screen.getByRole("dialog")).getByText("trì hoãn")).toBeInTheDocument());
      // The card in the grid also reflects the update (same cache).
      expect(within(screen.getByTestId("vocab-card")).getByText("trì hoãn")).toBeInTheDocument();
    });

    it("requires confirmation, then closes the drawer, when the selected item is deleted", async () => {
      mockViewport(true);
      mockFetchFor([makeItem({ id: "item-1", term: "postpone" })], { ...STATS_ZERO, total: 1 });
      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getAllByTestId("vocab-card")).toHaveLength(1));

      await user.click(screen.getByRole("button", { name: "Open details for postpone" }));
      const drawer = await screen.findByRole("dialog");
      await user.click(within(drawer).getByRole("button", { name: "Delete" }));

      const confirmDialog = await screen.findByRole("alertdialog");
      expect(screen.getByRole("dialog")).toBeInTheDocument(); // drawer still open behind it
      await user.click(within(confirmDialog).getByRole("button", { name: "Delete" }));

      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    });

    it("cancelling the delete confirmation leaves the drawer open and the item intact", async () => {
      mockViewport(true);
      mockFetchFor([makeItem({ id: "item-1", term: "postpone" })], { ...STATS_ZERO, total: 1 });
      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getAllByTestId("vocab-card")).toHaveLength(1));

      await user.click(screen.getByRole("button", { name: "Open details for postpone" }));
      const drawer = await screen.findByRole("dialog");
      await user.click(within(drawer).getByRole("button", { name: "Delete" }));

      const confirmDialog = await screen.findByRole("alertdialog");
      await user.click(within(confirmDialog).getByRole("button", { name: "Cancel" }));

      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(screen.getAllByTestId("vocab-card")).toHaveLength(1);
    });

    it("Escape closes only the confirm dialog, not the drawer behind it, on the mobile modal tier", async () => {
      mockViewport(false);
      mockFetchFor([makeItem({ id: "item-1", term: "postpone" })], { ...STATS_ZERO, total: 1 });
      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getAllByTestId("vocab-card")).toHaveLength(1));

      await user.click(screen.getByRole("button", { name: "Open details for postpone" }));
      const drawer = await screen.findByRole("dialog");
      expect(drawer).toHaveAttribute("aria-modal", "true");

      await user.click(within(drawer).getByRole("button", { name: "Delete" }));
      await screen.findByRole("alertdialog");

      await user.keyboard("{Escape}");

      // Only the confirm dialog closed — the drawer (and the item) are untouched.
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(screen.getAllByTestId("vocab-card")).toHaveLength(1);

      // The drawer's own Escape handling still works now that the dialog is gone.
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });

    it("keeps the drawer open for a selected item that a filter/search subsequently hides", async () => {
      mockViewport(true);
      mockFetchFor(
        [makeItem({ id: "a", term: "alpha" }), makeItem({ id: "b", term: "beta" })],
        { ...STATS_ZERO, total: 2 }
      );
      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getAllByTestId("vocab-card")).toHaveLength(2));

      await user.click(screen.getByRole("button", { name: "Open details for alpha" }));
      expect(await screen.findByRole("dialog")).toHaveTextContent("alpha");

      await user.click(screen.getByRole("button", { name: "Search" }));
      await user.type(screen.getByPlaceholderText("Search words, notes, or sentences..."), "beta");
      await waitFor(() => expect(screen.getAllByTestId("vocab-card")).toHaveLength(1));

      expect(screen.getByRole("dialog")).toHaveTextContent("alpha");
    });

    it("does not issue any extra network requests when opening, switching, or closing the drawer", async () => {
      mockViewport(true);
      mockFetchFor(
        [makeItem({ id: "a", term: "alpha" }), makeItem({ id: "b", term: "beta" })],
        { ...STATS_ZERO, total: 2 }
      );
      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getAllByTestId("vocab-card")).toHaveLength(2));
      const callsAfterLoad = (global.fetch as jest.Mock).mock.calls.length;

      await user.click(screen.getByRole("button", { name: "Open details for alpha" }));
      await screen.findByRole("dialog");
      await user.click(screen.getByRole("button", { name: "Open details for beta" }));
      await user.click(screen.getByRole("button", { name: "Close vocabulary details" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

      expect((global.fetch as jest.Mock).mock.calls.length).toBe(callsAfterLoad);
    });

    it("is a non-modal panel on desktop and a modal sheet below the lg breakpoint", async () => {
      mockViewport(true);
      mockFetchFor([makeItem({ term: "postpone" })], { ...STATS_ZERO, total: 1 });
      const user = userEvent.setup();
      const { unmount } = renderPage();
      await waitFor(() => expect(screen.getAllByTestId("vocab-card")).toHaveLength(1));
      await user.click(screen.getByRole("button", { name: "Open details for postpone" }));
      const desktopDrawer = await screen.findByRole("dialog");
      expect(desktopDrawer).toHaveAttribute("aria-modal", "false");
      expect(screen.queryByTestId("vocab-drawer-backdrop")).not.toBeInTheDocument();
      unmount();

      mockViewport(false);
      mockFetchFor([makeItem({ term: "postpone" })], { ...STATS_ZERO, total: 1 });
      renderPage();
      await waitFor(() => expect(screen.getAllByTestId("vocab-card")).toHaveLength(1));
      await user.click(screen.getByRole("button", { name: "Open details for postpone" }));
      const modalDrawer = await screen.findByRole("dialog");
      expect(modalDrawer).toHaveAttribute("aria-modal", "true");
      expect(screen.getByTestId("vocab-drawer-backdrop")).toBeInTheDocument();
    });

    it("does not reserve a docked xl inspector column when nothing is selected, and adds it once an item is selected", async () => {
      mockViewport(true);
      mockFetchFor([makeItem({ term: "postpone" })], { ...STATS_ZERO, total: 1 });
      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getAllByTestId("vocab-card")).toHaveLength(1));

      const workspace = screen.getByTestId("vocabulary-workspace");
      expect(workspace.className).not.toContain("xl:grid-cols-");

      await user.click(screen.getByRole("button", { name: "Open details for postpone" }));
      await screen.findByRole("dialog");
      expect(workspace.className).toContain("xl:grid-cols-[minmax(0,1fr)_420px]");

      await user.click(screen.getByRole("button", { name: "Close vocabulary details" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(workspace.className).not.toContain("xl:grid-cols-");
    });
  });

  describe("review-status semantics in the drawer", () => {
    it("New shows no Next review line", async () => {
      mockFetchFor([makeItem({ term: "postpone", last_reviewed_at: null })], { ...STATS_ZERO, total: 1 });
      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getAllByTestId("vocab-card")).toHaveLength(1));
      await user.click(screen.getByRole("button", { name: "Open details for postpone" }));

      const drawer = await screen.findByRole("dialog");
      expect(within(drawer).queryByText(/Next review/)).not.toBeInTheDocument();
      expect(within(drawer).getByText("Not reviewed yet")).toBeInTheDocument();
    });

    it("Learning shows Next review with a date", async () => {
      mockFetchFor(
        [makeItem({ term: "postpone", last_reviewed_at: PAST(1), next_review_at: FUTURE(5) })],
        { ...STATS_ZERO, total: 1 }
      );
      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getAllByTestId("vocab-card")).toHaveLength(1));
      await user.click(screen.getByRole("button", { name: "Open details for postpone" }));

      const drawer = await screen.findByRole("dialog");
      expect(within(drawer).getByText(/Next review/)).toBeInTheDocument();
    });

    it("Due shows 'Due now', not a Next review date", async () => {
      mockFetchFor(
        [makeItem({ term: "postpone", last_reviewed_at: PAST(5), next_review_at: PAST(1) })],
        { ...STATS_ZERO, total: 1 }
      );
      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getAllByTestId("vocab-card")).toHaveLength(1));
      await user.click(screen.getByRole("button", { name: "Open details for postpone" }));

      const drawer = await screen.findByRole("dialog");
      expect(within(drawer).getByText("Due now")).toBeInTheDocument();
      expect(within(drawer).queryByText(/Next review/)).not.toBeInTheDocument();
    });
  });
});
