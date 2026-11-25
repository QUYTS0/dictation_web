/**
 * Phase 3 of the dashboard redesign (.claude/dashboard-redesign-plan.md
 * §4.5.4, D8): Fill the gap / Meaning cards, review keys, the Dashboard's
 * review deck (real grading, optimistic advance, rollback) and the
 * /vocabulary/review page sharing the same card.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { User } from "@supabase/supabase-js";
import type { VocabularyItem, VocabularyStatsResponse } from "@/lib/types";

let authUser: User | null = { id: "user-1", email: "learner@example.test" } as User;
jest.mock("@/context/auth", () => ({
  useAuth: () => ({ user: authUser, loading: false, openAuthModal: jest.fn() }),
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
jest.mock("@/components/UserButton", () => function UserButton() {
  return null;
});
// Audio playback has its own tests; here it's just a button.
jest.mock("@/app/vocabulary/components/VocabularyPronunciationButton", () => ({
  VocabularyPronunciationButton: ({ item }: { item: { term: string } }) => <button type="button">Play pronunciation for {item.term}</button>,
}));

import { clozeParts } from "@/lib/vocabulary/cloze";
import { formatReviewInterval } from "@/lib/utils/srs";
import { reviewShortcut } from "@/components/vocabulary/reviewControls";
import { ToastProvider } from "@/components/ToastProvider";
import { VocabularyDeck } from "@/app/dashboard/components/VocabularyDeck";
import VocabularyReviewPage from "@/app/vocabulary/review/page";

// ---------------------------------------------------------------- fixtures

function vocab(id: string, term: string, sentence: string, over: Partial<VocabularyItem> = {}): VocabularyItem {
  return {
    id,
    user_id: "user-1",
    video_id: "vid1",
    segment_index: 0,
    term,
    normalized_term: term.toLowerCase(),
    canonical_form: null,
    learning_pattern: null,
    sentence_context: sentence,
    note: null,
    translation: null,
    translation_language: "vi",
    translation_source: null,
    phonetic: null,
    part_of_speech: null,
    definition: null,
    definition_source: null,
    audio_url: null,
    created_at: "2026-11-01T00:00:00Z",
    next_review_at: "2026-11-20T00:00:00Z",
    interval_days: 0,
    ease_factor: 2.5,
    repetitions: 0,
    last_reviewed_at: null,
    ...over,
  } as VocabularyItem;
}

const BREAK = vocab("w1", "breakthrough", "A major breakthrough revealed that place cells fire selectively.", {
  definition: "A sudden, important discovery.",
  part_of_speech: "noun",
  phonetic: "/ˈbreɪkˌθruː/",
});
const SPATIAL = vocab("w2", "spatial navigation", "Our spatial navigation depends on the striatum.", { definition: "Finding your way through space." });
const EDITED = vocab("w3", "send off course", "Small deviations can send travelers off course.");

const statsReady = (over: Partial<VocabularyStatsResponse> = {}) => ({
  status: "ready" as const,
  data: { total: 12, new: 0, learning: 9, due: 3, reviewable: 3, ...over },
});

let queue: VocabularyItem[];
let postStatus = 200;
const calls: Array<{ method: string; url: string; body?: Record<string, unknown> }> = [];

beforeEach(() => {
  authUser = { id: "user-1", email: "learner@example.test" } as User;
  queue = [BREAK, SPATIAL, EDITED];
  postStatus = 200;
  calls.length = 0;
  window.localStorage.clear();
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body }) as Response;
    if (url === "/api/vocabulary/review" && method === "GET") return json(200, { items: queue });
    if (url === "/api/vocabulary/review" && method === "POST") {
      if (postStatus !== 200) return json(postStatus, { error: "Database is busy." });
      const { itemId } = JSON.parse(String(init!.body));
      return json(200, { item: { ...queue.find((i) => i.id === itemId), repetitions: 1, interval_days: 1 } });
    }
    return json(404, {});
  }) as jest.Mock;
});

function renderDeck(props: Partial<React.ComponentProps<typeof VocabularyDeck>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <VocabularyDeck userId="user-1" summary={undefined} vocab={statsReady()} showReviewButton={false} {...props} />
      </ToastProvider>
    </QueryClientProvider>
  );
}

// ---------------------------------------------------------------- pure helpers

describe("clozeParts", () => {
  it("blanks the first whole-word, case-insensitive match", () => {
    expect(clozeParts("A major Breakthrough revealed a breakthrough.", "breakthrough")).toEqual({
      before: "A major ",
      answer: "Breakthrough",
      after: " revealed a breakthrough.",
    });
  });

  it("never matches inside another word, and treats apostrophes as part of a word", () => {
    expect(clozeParts("The station is on time.", "on")?.before).toBe("The station is ");
    expect(clozeParts("It's here, it is.", "it")?.before).toBe("It's here, ");
    expect(clozeParts("Stationary.", "station")).toBeNull();
  });

  it("multi-word terms match across any whitespace; punctuation next to the word is fine", () => {
    expect(clozeParts("Our spatial  navigation, mostly.", "spatial navigation")?.answer).toBe("spatial  navigation");
    expect(clozeParts('"Coordinate!" she said.', "coordinate")?.answer).toBe("Coordinate");
  });

  it("no match, empty term or regex characters in the term are safe", () => {
    expect(clozeParts("Small deviations can send travelers off course.", "send off course")).toBeNull();
    expect(clozeParts("Anything.", "  ")).toBeNull();
    // Regex characters in a term are literal: "(USD)" matches itself, "a.c" never matches "abc".
    expect(clozeParts("Costs (USD) rose.", "(USD)")?.answer).toBe("(USD)");
    expect(clozeParts("The abc test.", "a.c")).toBeNull();
  });
});

describe("formatReviewInterval", () => {
  it("short labels", () => {
    expect([0, 1, 6, 29, 45, 400].map(formatReviewInterval)).toEqual(["today", "1d", "6d", "29d", "2mo", "1y"]);
  });
});

describe("reviewShortcut", () => {
  const ev = (key: string, target: EventTarget | null = document.body, mods: Partial<KeyboardEvent> = {}) =>
    ({ key, target, altKey: false, ctrlKey: false, metaKey: false, ...mods }) as Parameters<typeof reviewShortcut>[0];

  it("Space/Enter flip; 1–4 grade only once revealed", () => {
    expect(reviewShortcut(ev(" "), false)).toEqual({ type: "flip" });
    expect(reviewShortcut(ev("Enter"), true)).toEqual({ type: "flip" });
    expect(reviewShortcut(ev("3"), false)).toBeNull();
    expect(reviewShortcut(ev("3"), true)).toEqual({ type: "grade", grade: "good" });
    expect(reviewShortcut(ev("1"), true)).toEqual({ type: "grade", grade: "again" });
    expect(reviewShortcut(ev("5"), true)).toBeNull();
  });

  it("never while typing, with a modifier, or for Space/Enter on a button (the browser activates it)", () => {
    expect(reviewShortcut(ev("3", document.createElement("input")), true)).toBeNull();
    expect(reviewShortcut(ev("3", document.createElement("textarea")), true)).toBeNull();
    expect(reviewShortcut(ev("3", document.body, { ctrlKey: true }), true)).toBeNull();
    expect(reviewShortcut(ev(" ", document.createElement("button")), false)).toBeNull();
    expect(reviewShortcut(ev("2", document.createElement("button")), true)).toEqual({ type: "grade", grade: "hard" });
  });
});

// ---------------------------------------------------------------- Dashboard deck

describe("Dashboard review deck", () => {
  it("Fill the gap by default: the word is blanked out of its own sentence, with no audio on the front", async () => {
    renderDeck();
    const card = await screen.findByTestId("review-card");
    expect(card).toHaveAttribute("data-mode", "gap");
    expect(within(card).getByTestId("review-gap")).toBeInTheDocument();
    expect(card).toHaveTextContent("A major");
    expect(card).not.toHaveTextContent("breakthrough");
    expect(within(card).queryByRole("button", { name: /Play pronunciation/ })).toBeNull();
    expect(card).toHaveTextContent("Card 1 of 3");
  });

  it("flipping shows the word, definition, the sentence with the word marked, and pronunciation", async () => {
    const user = userEvent.setup();
    renderDeck();
    await user.click(await screen.findByRole("button", { name: "Show the missing word" }));
    const card = screen.getByTestId("review-card");
    expect(card).toHaveAttribute("data-revealed", "true");
    expect(within(card).getByRole("heading", { name: "breakthrough" })).toBeInTheDocument();
    expect(card).toHaveTextContent("A sudden, important discovery.");
    expect(card.querySelector("mark")).toHaveTextContent("breakthrough");
    expect(within(card).getByRole("button", { name: "Play pronunciation for breakthrough" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Rate your recall" })).toBeInTheDocument();
  });

  it("grading sends a real review with the viewer's timezone and moves to the next card at once", async () => {
    const user = userEvent.setup();
    renderDeck();
    await user.click(await screen.findByRole("button", { name: "Show the missing word" }));
    await user.click(screen.getByRole("button", { name: /^Good/ }));
    expect(screen.getByTestId("review-card")).toHaveTextContent("Card 1 of 2"); // optimistic
    await waitFor(() => expect(calls.find((c) => c.method === "POST")).toBeDefined());
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toMatchObject({ itemId: "w1", grade: "good" });
    expect(post.body?.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it("a failed save puts the card back and says so", async () => {
    postStatus = 503;
    const user = userEvent.setup();
    renderDeck();
    await user.click(await screen.findByRole("button", { name: "Show the missing word" }));
    await user.click(screen.getByRole("button", { name: /^Easy/ }));
    expect(await screen.findByTestId("toast")).toHaveTextContent('Couldn\'t save your review of "breakthrough"');
    expect(screen.getByTestId("toast")).toHaveTextContent("Database is busy.");
    expect(screen.getByTestId("review-card")).toHaveTextContent("Card 1 of 3");
  });

  it("keys work inside the deck: Space flips, 3 grades Good; nothing happens from outside the deck", async () => {
    renderDeck();
    await screen.findByTestId("review-card");
    const deck = screen.getByTestId("vocabulary-card");
    fireEvent.keyDown(document.body, { key: " " });
    expect(screen.getByTestId("review-card")).toHaveAttribute("data-revealed", "false");
    act(() => deck.focus());
    fireEvent.keyDown(deck, { key: " " });
    expect(screen.getByTestId("review-card")).toHaveAttribute("data-revealed", "true");
    fireEvent.keyDown(deck, { key: "3" });
    await waitFor(() => expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({ itemId: "w1", grade: "good" }));
  });

  it("Meaning mode shows the word on the front and is remembered", async () => {
    const user = userEvent.setup();
    const first = renderDeck();
    await screen.findByTestId("review-card");
    await user.click(screen.getByRole("radio", { name: "Meaning" }));
    expect(screen.getByTestId("review-card")).toHaveAttribute("data-mode", "meaning");
    expect(screen.getByTestId("review-card")).toHaveTextContent("breakthrough");
    first.unmount();
    renderDeck();
    expect(await screen.findByTestId("review-card")).toHaveAttribute("data-mode", "meaning");
  });

  it("a word that isn't in its sentence (edited) falls back to Meaning instead of a broken blank", async () => {
    queue = [EDITED];
    renderDeck();
    const card = await screen.findByTestId("review-card");
    expect(card).toHaveAttribute("data-mode", "meaning");
    expect(card).toHaveTextContent("send off course");
  });

  it("chips pick a card; reviewing them all ends on a 'done for now' line", async () => {
    queue = [BREAK, SPATIAL];
    const user = userEvent.setup();
    renderDeck();
    await screen.findByTestId("review-card");
    await user.click(within(screen.getByRole("list", { name: "Cards up next" })).getByRole("button", { name: "spatial navigation" }));
    expect(screen.getByTestId("review-card")).toHaveTextContent("Card 2 of 2");
    for (let i = 0; i < 2; i++) {
      await user.click(screen.getByRole("button", { name: /Show the/ }));
      await user.click(screen.getByRole("button", { name: /^Good/ }));
    }
    expect(await screen.findByTestId("deck-empty")).toHaveTextContent("Done for now — you reviewed 2 words.");
  });

  it("copy never claims an order or a batch size", async () => {
    renderDeck({ showReviewButton: true });
    const deck = await screen.findByTestId("vocabulary-card");
    await screen.findByTestId("review-card");
    expect(deck.textContent).not.toMatch(/batch|\b20\b|prioriti[sz]ed|Review all/i);
    expect(within(deck).getByRole("link", { name: "Start review" })).toHaveAttribute("href", "/vocabulary/review");
  });
});

// ---------------------------------------------------------------- /vocabulary/review

describe("/vocabulary/review shares the card, modes and keys", () => {
  const renderPage = () =>
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <VocabularyReviewPage />
      </QueryClientProvider>
    );

  it("page-wide keys: Space flips, 4 grades Easy (with the timezone), the next card follows", async () => {
    renderPage();
    expect(await screen.findByTestId("review-card")).toHaveAttribute("data-mode", "gap");
    expect(screen.getByText("3 left in this session")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: " " });
    expect(screen.getByTestId("review-card")).toHaveAttribute("data-revealed", "true");
    fireEvent.keyDown(window, { key: "4" });
    await screen.findByText("2 left in this session");
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.body).toMatchObject({ itemId: "w1", grade: "easy" });
    expect(typeof post.body?.timeZone).toBe("string");
  });

  it("keys are ignored while typing in a field", async () => {
    renderPage();
    await screen.findByTestId("review-card");
    const input = document.createElement("input");
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: " " });
    expect(screen.getByTestId("review-card")).toHaveAttribute("data-revealed", "false");
    input.remove();
  });
});
