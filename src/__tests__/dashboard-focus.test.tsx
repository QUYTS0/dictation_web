/**
 * Dashboard V1 (component tests, fetch mocked — not a real browser):
 *   - wide shared shell; one Continue item paired with Focus; metrics and
 *     the Recent Vocabulary + Mistakes row; no Library, no rail;
 *   - Focus V1: progressive gating with independently delayed sources,
 *     sentence count from the Continue card (Option B — no report request),
 *     vocabulary copy, add-video scroll/focus, error ≠ empty;
 *   - duplicate-CTA suppression (Continue report link, vocabulary nudge);
 *   - exact cold-load request counts, no writes, no AI/provider calls;
 *   - cached data during background refetch; invalidation; account isolation.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { User } from "@supabase/supabase-js";
import type { DashboardSummary, LibraryItem, LibraryPage } from "@/lib/types/learning";
import type { VocabularyStatsResponse } from "@/lib/types";
import { PAGE_PADDING_CLASS, PAGE_WIDTH_CLASS } from "@/lib/layout/pageWidth";
import { invalidateLearningViews } from "@/lib/queries/learningInvalidation";
import { invalidateVocabularyQueries } from "@/lib/queries/vocabulary";
import { videoLibraryKeys } from "@/lib/queries/videoLibrary";

let authUser: User = { id: "user-1", email: "learner@example.test" } as User;
jest.mock("@/context/auth", () => ({
  useAuth: () => ({ user: authUser, loading: false, openAuthModal: jest.fn() }),
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
jest.mock("@/components/AppHeader", () => function AppHeader() {
  return null;
});

import DashboardPage from "@/app/dashboard/page";

// ---------------------------------------------------------------- fixtures

function item(videoId: string, acc: { correct: number; practiced: number } | null, over: Partial<LibraryItem> = {}, roundOver: Partial<NonNullable<LibraryItem["round"]>> = {}): LibraryItem {
  return {
    videoId,
    title: `Title ${videoId}`,
    addedAt: "2026-09-01T00:00:00Z",
    lastActivityAt: "2026-09-02T00:00:00Z",
    lastMode: "dictation",
    state: acc ? "in_progress" : "not_started",
    hasCompletedRound: false,
    hasLegacyCompletion: false,
    // An earlier completed round: the card would normally offer "Review report" for its round.
    completedRoundCount: 1,
    round: acc
      ? {
          roundId: `round-${videoId}`,
          status: "active",
          provenance: "current",
          roundNumber: 2,
          transcriptId: "tr",
          startedAt: "2026-09-01T00:00:00Z",
          completedAt: null,
          currentSegmentIndex: 0,
          progress: {
            requiredSentenceCount: 20,
            coveredSentences: { dictation: acc.practiced, shadowing: 0, overall: acc.practiced },
            coverage: { dictation: acc.practiced / 20, shadowing: 0, overall: acc.practiced / 20 },
            attemptCount: acc.practiced,
            sentenceAccuracy: { ...acc, percent: null },
          },
          ...roundOver,
        }
      : null,
    listening: { transcriptId: "tr", coverageRatio: null, listenedThrough: false, lastPositionSec: null, hasHistory: false, historyOnOtherRevision: false },
    ...over,
  };
}
const page = (items: LibraryItem[], filter: LibraryPage["filter"] = "all"): LibraryPage => ({ items, total: items.length, limit: 12, offset: 0, filter, hasMore: false });
const summaryOf = (over: Partial<DashboardSummary> = {}): DashboardSummary => ({
  completedVideos: 1,
  legacyCompletedVideos: 0,
  inProgressVideos: 1,
  listenedThroughVideos: 0,
  libraryVideos: 3,
  sentenceAccuracy: { correct: 3, practiced: 4, excludedUnverified: 0 },
  shadowing: {
    takes: 0,
    practicedSentences: 0,
    attemptedSentences: 0,
    azure: { evaluatedSentences: 0, pronunciation: null, accuracy: null, completeness: null, fluency: null, prosody: null },
    wordMatch: { evaluatedSentences: 0, accuracy: null, completeness: null },
  },
  activeTime: { activeSec: 0, trackedSince: null, sessionCount: 0 },
  vocabularyCount: 12,
  streakDays: 0,
  streakTimeZone: "UTC",
  streakToday: "2026-10-01",
  streakIncludesUtcFallback: false,
  recentVocabulary: [],
  ...over,
});
const statsOf = (over: Partial<VocabularyStatsResponse> = {}): VocabularyStatsResponse => ({ total: 12, new: 0, learning: 12, due: 0, reviewable: 0, ...over });

const NEEDS = item("vNeeds", { correct: 5, practiced: 8 }); // 3 sentences need another look
const CLEAN = item("vClean", { correct: 8, practiced: 8 });

// ---------------------------------------------------------------- fetch mock with per-source gates

type Source = "summary" | "continue" | "library" | "errors" | "vocab";
const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
let responses: { summary: DashboardSummary; continue: LibraryPage; library: LibraryPage; vocab: VocabularyStatsResponse };
let failing: Set<Source>;
let gates: Partial<Record<Source, Promise<void>>>;
let errorPatterns: { total: number; patterns: Array<{ errorType: string; count: number; percentage: number }> };
const calls: string[] = [];

function gate(source: Source): () => void {
  let release!: () => void;
  gates[source] = new Promise<void>((r) => (release = r));
  return () => {
    delete gates[source];
    release();
  };
}

beforeEach(() => {
  calls.length = 0;
  authUser = { id: "user-1", email: "learner@example.test" } as User;
  responses = { summary: summaryOf(), continue: page([NEEDS], "continue"), library: page([NEEDS, CLEAN]), vocab: statsOf() };
  failing = new Set();
  gates = {};
  errorPatterns = { total: 0, patterns: [] };
  window.sessionStorage.clear();
  Element.prototype.scrollIntoView = jest.fn();
  window.matchMedia = jest.fn().mockReturnValue({ matches: false }) as unknown as typeof window.matchMedia;
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    const source: Source | null = url.startsWith("/api/dashboard/summary")
      ? "summary"
      : url.startsWith("/api/dashboard/error-patterns")
        ? "errors"
        : url.startsWith("/api/vocabulary/stats")
          ? "vocab"
          : url.startsWith("/api/videos/library?")
            ? url.includes("filter=continue")
              ? "continue"
              : "library"
            : null;
    if (!source) return json({}, 404);
    const g = gates[source];
    if (g) await g;
    if (failing.has(source)) return json({ error: "boom" }, 500);
    if (source === "errors") return json(errorPatterns);
    return json(responses[source]);
  }) as typeof fetch;
});

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
function renderDashboard(client = newClient()) {
  return { client, ...render(<QueryClientProvider client={client}><DashboardPage /></QueryClientProvider>) };
}
const focusCard = () => screen.queryByTestId("dashboard-focus");
const settle = () => waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(4));

// ---------------------------------------------------------------- layout

describe("wide shell and layout", () => {
  it("Dashboard main uses the shared wide width + padding tokens (same as AppHeader), never max-w-6xl", async () => {
    renderDashboard();
    const main = screen.getByRole("main");
    for (const cls of `${PAGE_WIDTH_CLASS.wide} ${PAGE_PADDING_CLASS.wide}`.split(" ")) expect(main.classList).toContain(cls);
    expect(main.className).not.toContain("max-w-6xl");
    await settle();
  });

  it("hero row: 'Pick up where you left off' (8/12) + 'Next up' (4/12); the displayed Continue item IS the Focus candidate", async () => {
    responses.continue = page([NEEDS, CLEAN], "continue");
    renderDashboard();
    const focus = await screen.findByTestId("dashboard-focus");
    const row = screen.getByTestId("dashboard-actions");
    expect(row).toHaveClass("grid", "lg:grid-cols-12");
    expect(row).not.toHaveClass("max-w-3xl");
    const cont = within(row).getByTestId("continue-learning");
    expect(cont.parentElement).toHaveClass("lg:col-span-8");
    expect(focus.parentElement).toHaveClass("lg:col-span-4");
    expect(within(cont).getByRole("heading", { name: "Pick up where you left off" })).toBeInTheDocument();
    expect(within(focus).getByText("Next up")).toBeInTheDocument();
    expect(within(cont).getByTestId("continue-card-vNeeds")).toBeInTheDocument();
    expect(screen.queryByTestId("continue-card-vClean")).toBeNull(); // only the first item
    expect(within(focus).getByRole("link", { name: "Review sentences" })).toHaveAttribute("href", "/results/round-vNeeds");
  });

  it("only one side present → a single readable card width, not a full-width banner", async () => {
    responses.continue = page([CLEAN], "continue"); // Continue shown, Focus hidden
    const first = renderDashboard();
    await screen.findByTestId("continue-learning");
    await waitFor(() => expect(screen.queryByTestId("focus-pending")).toBeNull());
    expect(screen.getByTestId("dashboard-actions")).toHaveClass("max-w-3xl");
    expect(screen.getByTestId("dashboard-actions")).not.toHaveClass("lg:grid-cols-12");
    first.unmount();
    responses.continue = page([], "continue"); // Focus shown, no Continue, empty library
    responses.summary = summaryOf({ libraryVideos: 0 });
    responses.vocab = statsOf({ due: 3, reviewable: 3 });
    renderDashboard();
    await screen.findByTestId("dashboard-focus");
    expect(screen.getByTestId("dashboard-actions")).toHaveClass("max-w-3xl");
    expect(screen.queryByTestId("continue-learning")).toBeNull();
  });

  it("saved videos but nothing unfinished → a small 'Browse My Learning' pointer instead of a resume card", async () => {
    responses.continue = page([], "continue");
    renderDashboard();
    const empty = await screen.findByTestId("continue-empty");
    expect(empty).toHaveTextContent("Nothing unfinished right now.");
    expect(within(empty).getByRole("link", { name: "Browse My Learning" })).toHaveAttribute("href", "/library");
  });

  it("nothing to resume, empty library and Focus hidden → no action row at all", async () => {
    responses.continue = page([], "continue");
    responses.summary = summaryOf({ libraryVideos: 0, vocabularyCount: 3 });
    failing.add("vocab"); // vocabulary unknown + saved words → Focus unavailable (never add-video)
    renderDashboard();
    await screen.findByTestId("your-progress");
    await waitFor(() => expect(screen.queryByTestId("focus-pending")).toBeNull());
    expect(screen.queryByTestId("dashboard-actions")).toBeNull();
  });

  it("no six metric cards, no Library, no rail, no sticky; insights row is 7/12 + 5/12 and stacks below lg", async () => {
    renderDashboard();
    await screen.findByTestId("your-progress");
    expect(screen.queryByRole("region", { name: "Progress summary" })).toBeNull();
    const insights = screen.getByTestId("dashboard-insights");
    expect(insights).toHaveClass("grid", "lg:grid-cols-12");
    expect(screen.getByTestId("vocabulary-card").parentElement).toHaveClass("lg:col-span-7");
    expect(screen.getByTestId("needs-attention").parentElement).toHaveClass("lg:col-span-5");
    expect(document.querySelector('[class*="sticky"]')).toBeNull();
    for (const gone of ["dashboard-rail", "library-rail-grid", "library-grid"]) expect(screen.queryByTestId(gone)).toBeNull();
  });

  it("DOM order: welcome → Continue → Next up → Add a video → Your progress → Vocabulary → Needs attention", async () => {
    renderDashboard();
    const focus = await screen.findByTestId("dashboard-focus");
    const order = [
      screen.getByTestId("dashboard-welcome"),
      screen.getByTestId("continue-learning"),
      focus,
      screen.getByRole("button", { name: "Add a video" }),
      screen.getByTestId("your-progress"),
      screen.getByTestId("vocabulary-card"),
      screen.getByTestId("needs-attention"),
    ];
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });
});

describe("welcome and Your progress", () => {
  it("streak sits with the heading as momentum copy; no streak → no streak claim", async () => {
    responses.summary = summaryOf({ streakDays: 12 });
    const first = renderDashboard();
    const welcome = await screen.findByTestId("dashboard-welcome");
    await within(welcome).findByText("Ready to keep your 12-day streak going?");
    expect(within(welcome).getByTestId("streak")).toHaveTextContent("12 days");
    first.unmount();
    responses.summary = summaryOf({ streakDays: 0 });
    renderDashboard();
    const w2 = await screen.findByTestId("dashboard-welcome");
    await within(w2).findByText("Ready for today's practice?");
    expect(within(w2).queryByTestId("streak")).toBeNull();
  });

  it("all six canonical values represented: three primary outcomes + non-zero video counts as one line", async () => {
    responses.summary = summaryOf({
      activeTime: { activeSec: 11400, trackedSince: "2026-08-01T00:00:00Z", sessionCount: 3 },
      sentenceAccuracy: { correct: 61, practiced: 80, excludedUnverified: 0 },
      shadowing: { ...summaryOf().shadowing, azure: { ...summaryOf().shadowing.azure, evaluatedSentences: 12, pronunciation: 82.94 } },
      inProgressVideos: 2,
      listenedThroughVideos: 1,
      completedVideos: 4,
      legacyCompletedVideos: 0,
    });
    renderDashboard();
    const progress = await screen.findByTestId("your-progress");
    expect(within(progress).getByTestId("progress-active")).toHaveTextContent("3h 10m");
    expect(within(progress).getByTestId("progress-accuracy")).toHaveTextContent("76%");
    expect(within(progress).getByTestId("progress-accuracy")).toHaveTextContent("61/80 latest answers");
    expect(within(progress).getByTestId("progress-pronunciation")).toHaveTextContent("82.9");
    expect(within(progress).getByTestId("progress-pronunciation")).toHaveTextContent("12 scored sentences");
    expect(within(progress).getByTestId("progress-videos")).toHaveTextContent("2 videos in progress · 1 listened through · 4 completed");
  });

  it("zero video counts are not emphasized; legacy completions stay labeled; missing outcomes show '—'", async () => {
    responses.summary = summaryOf({ inProgressVideos: 0, listenedThroughVideos: 0, completedVideos: 0, legacyCompletedVideos: 2, sentenceAccuracy: { correct: 0, practiced: 0, excludedUnverified: 0 } });
    renderDashboard();
    const progress = await screen.findByTestId("your-progress");
    expect(within(progress).getByTestId("progress-videos").textContent).toBe("+2 completed in rounds started before detailed tracking");
    expect(within(progress).getByTestId("progress-accuracy")).toHaveTextContent("—");
    expect(within(progress).getByTestId("progress-pronunciation")).toHaveTextContent("—");
    expect(progress.textContent).not.toMatch(/\b0 (videos|listened|completed)/);
  });
});

describe("Needs attention (existing error-pattern data, descriptive only)", () => {
  it("bars per recorded type and a factual 'most common' line; no cause/trend/prescription", async () => {
    errorPatterns = { total: 9, patterns: [{ errorType: "wrong_form", count: 5, percentage: 56 }, { errorType: "missing_word", count: 3, percentage: 33 }, { errorType: "extra_word", count: 1, percentage: 11 }] };
    renderDashboard();
    const card = await screen.findByTestId("needs-attention");
    await within(card).findByText("Wrong form is your most common recorded mistake.");
    expect(within(card).getAllByRole("listitem")).toHaveLength(3);
    expect(card.textContent).not.toMatch(/improv|better|worse|because|AI|should|try /i);
    expect(within(card).queryByRole("link")).toBeNull();
  });

  it("a tie never names a single 'most common' type", async () => {
    errorPatterns = { total: 6, patterns: [{ errorType: "spelling", count: 3, percentage: 50 }, { errorType: "missing_word", count: 3, percentage: 50 }] };
    renderDashboard();
    const card = await screen.findByTestId("needs-attention");
    await within(card).findByText("Spelling and missing word are your most common recorded mistakes.");
  });
});

// ---------------------------------------------------------------- requests

describe("request contract (Option B)", () => {
  const expected = [
    "GET /api/dashboard/summary",
    "GET /api/videos/library?filter=continue&offset=0&limit=1",
    "GET /api/dashboard/error-patterns",
    "GET /api/vocabulary/stats",
  ];
  const normalize = (c: string) => c.replace(/\?tz=.*$/, "");

  it.each([
    ["with a sentence candidate", [NEEDS]],
    ["without a candidate", [] as LibraryItem[]],
  ])("cold load %s: exactly 4 GETs — no all-library request, no round report, no writes, no AI/provider calls", async (_label, items) => {
    responses.continue = page(items, "continue");
    renderDashboard();
    await screen.findByTestId("your-progress");
    await waitFor(() => expect(screen.queryByTestId("focus-pending")).toBeNull());
    await act(async () => {});
    expect(calls.map(normalize).sort()).toEqual([...expected].sort());
    expect(calls.some((c) => c.includes("/report"))).toBe(false);
    expect(calls.some((c) => c.includes("filter=all"))).toBe(false);
    expect(calls.some((c) => /explain|gemini|azure|assess|pronunciation|\/api\/dictation|\/api\/session/i.test(c))).toBe(false);
    expect(calls.every((c) => c.startsWith("GET "))).toBe(true);
  });
});

// ---------------------------------------------------------------- Focus behavior

describe("Focus actions", () => {
  it("sentences: count from the Continue card, task-specific CTA to the round report; the Continue card carries no second report link", async () => {
    renderDashboard();
    const focus = await screen.findByTestId("dashboard-focus");
    expect(focus).toHaveTextContent("3 sentences need another look");
    expect(focus).toHaveTextContent("Review the ones that tripped you up.");
    expect(within(focus).getByRole("link", { name: "Review sentences" })).toHaveAttribute("href", "/results/round-vNeeds");
    const cont = screen.getByTestId("continue-learning");
    expect(within(cont).queryByRole("link", { name: /report/i })).toBeNull();
    expect(within(cont).getByRole("link", { name: "Continue learning" })).toHaveAttribute("href", "/dictation/vNeeds");
    expect(document.querySelectorAll('a[href="/results/round-vNeeds"]')).toHaveLength(1);
  });

  it("a null title never renders 'null' or 'Untitled'; one sentence is singular", async () => {
    responses.continue = page([item("vX", { correct: 3, practiced: 4 }, { title: null })], "continue");
    renderDashboard();
    const focus = await screen.findByTestId("dashboard-focus");
    expect(focus).toHaveTextContent("1 sentence needs another look");
    expect(document.body.textContent).not.toMatch(/\bnull\b|Untitled/);
    expect(screen.getByTestId("continue-card-vX")).toHaveTextContent("Video vX"); // the card's own existing fallback
  });

  it("vocabulary due: factual copy, 'Start review'; the nudge shows context but no second button", async () => {
    responses.continue = page([CLEAN], "continue");
    responses.vocab = statsOf({ due: 22, new: 233, reviewable: 255 });
    renderDashboard();
    const focus = await screen.findByTestId("dashboard-focus");
    expect(focus).toHaveTextContent("22 words are due");
    expect(focus).toHaveTextContent("Keep them fresh.");
    expect(within(focus).getByRole("link", { name: "Start review" })).toHaveAttribute("href", "/vocabulary/review");
    const vocabCard = screen.getByTestId("vocabulary-card");
    expect(within(vocabCard).getByTestId("vocab-nudge")).toHaveTextContent("22 words are due");
    expect(within(vocabCard).queryByRole("link", { name: "Start review" })).toBeNull(); // Next Up owns it
    expect(within(vocabCard).getByRole("link", { name: "View vocabulary" })).toHaveAttribute("href", "/vocabulary");
    expect(screen.getAllByRole("link", { name: "Start review" })).toHaveLength(1);
    // Every vocabulary CTA is exactly "Start review"; no line claims an order or a batch size.
    for (const link of within(focus).getAllByRole("link")) expect(link).toHaveTextContent(/^Start review$/);
    const lines = [focus, vocabCard].flatMap((el) => Array.from(el.querySelectorAll("p, h2, a")).map((n) => n.textContent ?? ""));
    for (const line of lines) {
      for (const forbidden of [/Review due/i, /Review \d+/i, /Review all/i, /prioriti[sz]ed/i, /mixed in/i, /\b20\b/, /batch/i]) expect(line).not.toMatch(forbidden);
    }
    expect(document.body.textContent).not.toMatch(/Review due|Review all|prioriti[sz]ed|mixed in/i);
    // Vocabulary Focus sits beside the (unchanged) Continue card.
    expect(screen.getByTestId("dashboard-actions")).toContainElement(screen.getByTestId("continue-card-vClean"));
  });

  it("vocabulary new-only copy", async () => {
    responses.continue = page([], "continue");
    responses.vocab = statsOf({ new: 7, reviewable: 7 });
    renderDashboard();
    const focus = await screen.findByTestId("dashboard-focus");
    expect(focus).toHaveTextContent("New vocabulary is ready to practice");
    expect(focus).toHaveTextContent("7 words haven't been reviewed yet.");
    expect(within(focus).getByRole("link", { name: "Start review" })).toBeInTheDocument();
  });

  it("sentence Focus + reviewable vocabulary: both actions shown (different destinations)", async () => {
    responses.vocab = statsOf({ due: 2, reviewable: 2 });
    renderDashboard();
    await screen.findByTestId("dashboard-focus");
    await screen.findByTestId("vocab-nudge");
    expect(within(screen.getByTestId("vocabulary-card")).getByRole("link", { name: "Start review" })).toHaveAttribute("href", "/vocabulary/review");
  });

  it("Vocabulary surface: saved total, review context, at most six recent terms as chips — never a sentence table", async () => {
    responses.summary = summaryOf({
      vocabularyCount: 352,
      recentVocabulary: Array.from({ length: 8 }, (_, i) => ({ id: `w${i}`, term: `term${i}`, sentence_context: `context sentence ${i}`, created_at: "2026-10-01T00:00:00Z" })),
    });
    responses.vocab = statsOf({ total: 352, due: 42, reviewable: 42 });
    renderDashboard();
    const card = await screen.findByTestId("vocabulary-card");
    await within(card).findByText("352 words saved");
    await within(card).findByText("42 words are due");
    expect(within(card).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["term0", "term1", "term2", "term3", "term4", "term5"]);
    expect(card.querySelector("table")).toBeNull();
    expect(card).not.toHaveTextContent("context sentence");
  });

  it("nothing actionable → no Focus card at all", async () => {
    responses.continue = page([CLEAN], "continue");
    renderDashboard();
    await screen.findByTestId("your-progress");
    await waitFor(() => expect(screen.queryByTestId("focus-pending")).toBeNull());
    expect(focusCard()).toBeNull();
  });
});

describe("Add Video Focus (empty library)", () => {
  beforeEach(() => {
    responses.continue = page([], "continue");
    responses.library = page([]);
    responses.summary = summaryOf({ libraryVideos: 0, vocabularyCount: 0 });
    responses.vocab = statsOf({ total: 0, learning: 0 });
  });

  it("Next Up's CTA expands the ONE Add Video form, scrolls its input into view smoothly and focuses it without a second scroll; never submits", async () => {
    const focusSpy = jest.spyOn(HTMLInputElement.prototype, "focus");
    renderDashboard();
    const focus = await screen.findByTestId("dashboard-focus");
    expect(focus).toHaveTextContent("Ready for something new?");
    const cta = within(focus).getByRole("link", { name: "Add a video" });
    expect(cta).toHaveAttribute("href", "#add-video");
    expect(document.getElementById("add-video-url")).toBeNull(); // collapsed by default
    fireEvent.click(cta);
    const input = document.getElementById("add-video-url") as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
    expect(document.activeElement).toBe(input);
    expect(calls.some((c) => !c.startsWith("GET "))).toBe(false);
    expect(screen.getAllByRole("textbox", { name: "YouTube URL" })).toHaveLength(1); // no second form
    focusSpy.mockRestore();
  });

  it("keyboard activation behaves the same; reduced motion → behavior auto", async () => {
    window.matchMedia = jest.fn().mockReturnValue({ matches: true }) as unknown as typeof window.matchMedia;
    const user = userEvent.setup();
    renderDashboard();
    const cta = within(await screen.findByTestId("dashboard-focus")).getByRole("link", { name: "Add a video" });
    cta.focus();
    await user.keyboard("{Enter}");
    expect(window.matchMedia).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ behavior: "auto", block: "center" });
    expect(document.activeElement).toBe(document.getElementById("add-video-url"));
  });

  it("the secondary '+ Add a video' toggle expands the form and focuses the input; Escape collapses it, keeps the typed URL and returns focus to the toggle", async () => {
    const user = userEvent.setup();
    renderDashboard();
    await screen.findByTestId("your-progress");
    expect(document.getElementById("add-video")).toBeNull();
    const toggle = screen.getByRole("button", { name: "Add a video" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    const input = document.getElementById("add-video-url") as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled(); // right under the toggle — no scroll jump
    await user.type(input, "https://youtu.be/abc");
    await user.keyboard("{Escape}");
    expect(document.getElementById("add-video")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add a video" }));
    await user.click(screen.getByRole("button", { name: "Add a video" }));
    expect((document.getElementById("add-video-url") as HTMLInputElement).value).toBe("https://youtu.be/abc");
    expect(calls.some((c) => !c.startsWith("GET "))).toBe(false);
  });

  it("vocabulary stats failed but the summary proves no saved words → add-video is still safe", async () => {
    failing.add("vocab");
    renderDashboard();
    expect(await screen.findByTestId("dashboard-focus")).toHaveAttribute("data-focus-kind", "add-video");
  });

  it("vocabulary stats failed and the summary shows saved words → no Focus (never 'nothing to review' from a failure)", async () => {
    failing.add("vocab");
    responses.summary = summaryOf({ libraryVideos: 0, vocabularyCount: 5 });
    renderDashboard();
    await screen.findByTestId("your-progress");
    await waitFor(() => expect(screen.queryByTestId("focus-pending")).toBeNull());
    expect(focusCard()).toBeNull();
  });

  it("summary failed → never add-video", async () => {
    failing.add("summary");
    renderDashboard();
    await screen.findByText(/Failed to load your progress/);
    await waitFor(() => expect(screen.queryByTestId("focus-pending")).toBeNull());
    expect(focusCard()).toBeNull();
  });
});

// ---------------------------------------------------------------- progressive gating with delayed sources

describe("progressive gating (independently delayed sources)", () => {
  it("a qualifying sentence appears before vocabulary and summary finish", async () => {
    const releaseVocab = gate("vocab");
    const releaseSummary = gate("summary");
    renderDashboard();
    expect(await screen.findByTestId("dashboard-focus")).toHaveAttribute("data-focus-kind", "sentences");
    await act(async () => {
      releaseVocab();
      releaseSummary();
    });
  });

  it("no sentence action: pending vocabulary blocks the fallback (placeholder, no add-video, no nudge button)", async () => {
    responses.continue = page([], "continue");
    responses.summary = summaryOf({ libraryVideos: 0, vocabularyCount: 0 });
    const releaseVocab = gate("vocab");
    renderDashboard();
    await screen.findByTestId("your-progress"); // summary resolved
    expect(screen.getByTestId("focus-pending")).toHaveAttribute("aria-busy", "true");
    expect(focusCard()).toBeNull();
    await act(async () => releaseVocab());
    expect(await screen.findByTestId("dashboard-focus")).toHaveAttribute("data-focus-kind", "add-video");
  });

  it("qualifying vocabulary appears before the summary finishes", async () => {
    responses.continue = page([CLEAN], "continue");
    responses.vocab = statsOf({ due: 3, reviewable: 3 });
    const releaseSummary = gate("summary");
    renderDashboard();
    expect(await screen.findByTestId("dashboard-focus")).toHaveAttribute("data-focus-kind", "vocabulary");
    await act(async () => releaseSummary());
  });

  it("no sentence/vocabulary action: the summary decides add-video vs hidden", async () => {
    responses.continue = page([], "continue");
    responses.summary = summaryOf({ libraryVideos: 0, vocabularyCount: 0 });
    const releaseSummary = gate("summary");
    renderDashboard();
    await screen.findByTestId("continue-learning").catch(() => undefined);
    await waitFor(() => expect(calls.some((c) => c.includes("/api/vocabulary/stats"))).toBe(true));
    await act(async () => {});
    expect(screen.getByTestId("focus-pending")).toBeInTheDocument();
    await act(async () => releaseSummary());
    expect(await screen.findByTestId("dashboard-focus")).toHaveAttribute("data-focus-kind", "add-video");
  });

  it("Continue pending: placeholder only, and the vocabulary nudge button is suppressed meanwhile", async () => {
    responses.vocab = statsOf({ due: 2, reviewable: 2 });
    const releaseContinue = gate("continue");
    renderDashboard();
    await screen.findByTestId("vocab-nudge");
    expect(screen.getByTestId("focus-pending")).toBeInTheDocument();
    expect(within(screen.getByTestId("vocabulary-card")).queryByRole("link", { name: "Start review" })).toBeNull();
    await act(async () => releaseContinue());
    expect(await screen.findByTestId("dashboard-focus")).toHaveAttribute("data-focus-kind", "sentences");
    expect(within(screen.getByTestId("vocabulary-card")).getByRole("link", { name: "Start review" })).toBeInTheDocument();
  });

  it("Continue failed: sentences skipped, vocabulary still qualifies; with nothing else → hidden, not add-video", async () => {
    failing.add("continue");
    responses.vocab = statsOf({ due: 1, reviewable: 1 });
    const { unmount } = renderDashboard();
    expect(await screen.findByTestId("dashboard-focus")).toHaveTextContent("1 word is due");
    unmount();
    calls.length = 0;
    responses.vocab = statsOf();
    renderDashboard();
    await screen.findByText(/Couldn.t load your unfinished videos/);
    await waitFor(() => expect(screen.queryByTestId("focus-pending")).toBeNull());
    expect(focusCard()).toBeNull();
  });
});

// ---------------------------------------------------------------- cache, invalidation, isolation

describe("cache and invalidation", () => {
  it("background refetch keeps the current Focus action (no placeholder while refetching)", async () => {
    const { client } = renderDashboard();
    await screen.findByTestId("dashboard-focus");
    const releaseContinue = gate("continue");
    const releaseVocab = gate("vocab");
    await act(async () => {
      invalidateLearningViews(client, "user-1");
      invalidateVocabularyQueries(client, "user-1");
    });
    expect(screen.getByTestId("dashboard-focus")).toHaveAttribute("data-focus-kind", "sentences");
    expect(screen.queryByTestId("focus-pending")).toBeNull();
    await act(async () => {
      releaseContinue();
      releaseVocab();
    });
  });

  it("Option B follows the Continue query: a practice write's invalidateLearningViews (no roundIds needed) updates Focus", async () => {
    const { client } = renderDashboard();
    expect(await screen.findByTestId("dashboard-focus")).toHaveTextContent("3 sentences need another look");
    responses.continue = page([item("vNeeds", { correct: 7, practiced: 8 })], "continue");
    await act(async () => invalidateLearningViews(client, "user-1"));
    await waitFor(() => expect(screen.getByTestId("dashboard-focus")).toHaveTextContent("1 sentence needs another look"));
    responses.continue = page([item("vNeeds", { correct: 8, practiced: 8 })], "continue");
    responses.vocab = statsOf({ due: 4, reviewable: 4 });
    await act(async () => {
      invalidateLearningViews(client, "user-1");
      invalidateVocabularyQueries(client, "user-1");
    });
    await waitFor(() => expect(screen.getByTestId("dashboard-focus")).toHaveTextContent("4 words are due"));
  });

  it("another account never sees this account's cached Continue round in Focus", async () => {
    const client = newClient();
    client.setQueryData(videoLibraryKeys.continueLearning("user-1"), page([NEEDS], "continue"));
    authUser = { id: "user-2", email: "other@example.test" } as User;
    responses.continue = page([CLEAN], "continue");
    renderDashboard(client);
    await screen.findByTestId("continue-card-vClean");
    await waitFor(() => expect(screen.queryByTestId("focus-pending")).toBeNull());
    expect(focusCard()).toBeNull();
    expect(document.body.textContent).not.toContain("need another look");
  });
});
