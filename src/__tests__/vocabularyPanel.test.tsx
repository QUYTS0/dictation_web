import { useRef, useState } from "react";
import { act, fireEvent, render, screen, waitForElementToBeRemoved, within } from "@testing-library/react";
import { TAB_CONFIG } from "@/app/dictation/[videoId]/components/RightPanelTabs";
import { WordsTab } from "@/app/dictation/[videoId]/components/WordsTab";
import type { VocabularyTypeFilter } from "@/app/dictation/[videoId]/helpers";
import type { LessonSavedItem } from "@/app/dictation/[videoId]/types";
import type { VocabHighlightPhrase } from "@/lib/types";

function makeItem(overrides: Partial<LessonSavedItem> = {}): LessonSavedItem {
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
    created_at: "2026-01-01T00:00:00.000Z",
    next_review_at: "2026-01-02T00:00:00.000Z",
    interval_days: 1,
    ease_factor: 2.5,
    repetitions: 0,
    last_reviewed_at: null,
    type: "word",
    ...overrides,
  };
}

type HarnessProps = {
  items: LessonSavedItem[];
  deletingId?: string | null;
  updatingId?: string | null;
  onDelete?: (itemId: string) => void;
  onUpdate?: (itemId: string, values: Record<string, string>) => void;
  learningError?: string | null;
  learningErrorRetry?: (() => void) | null;
  phrasesBySegmentIndex?: Map<number, VocabHighlightPhrase[]>;
  translationBySegmentIndex?: Map<number, string>;
  onSeekToSegment?: (segmentIndex: number) => void;
  initialQuery?: string;
  initialTypeFilter?: VocabularyTypeFilter;
  onQueryChange?: (query: string) => void;
  onTypeFilterChange?: (filter: VocabularyTypeFilter) => void;
};

/** Mirrors what RightPanelTabs owns in production: search/filter/selected-id
 *  state lives one level above WordsTab (see helpers.ts / RightPanelTabs.tsx
 *  doc comments for why), so this harness plays that role for tests. */
function Harness({
  items,
  deletingId = null,
  updatingId = null,
  onDelete = () => {},
  onUpdate = () => {},
  learningError = null,
  learningErrorRetry = null,
  phrasesBySegmentIndex = new Map(),
  translationBySegmentIndex = new Map(),
  onSeekToSegment = () => {},
  initialQuery = "",
  initialTypeFilter = "all",
  onQueryChange,
  onTypeFilterChange,
}: HarnessProps) {
  const [query, setQuery] = useState(initialQuery);
  const [typeFilter, setTypeFilter] = useState<VocabularyTypeFilter>(initialTypeFilter);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const scrollTopRef = useRef(0);

  return (
    <WordsTab
      items={items}
      deletingId={deletingId}
      updatingId={updatingId}
      onDelete={onDelete}
      onUpdate={onUpdate}
      learningError={learningError}
      learningErrorRetry={learningErrorRetry}
      phrasesBySegmentIndex={phrasesBySegmentIndex}
      translationBySegmentIndex={translationBySegmentIndex}
      onSeekToSegment={onSeekToSegment}
      query={query}
      onQueryChange={(next) => {
        onQueryChange?.(next);
        setQuery(next);
      }}
      typeFilter={typeFilter}
      onTypeFilterChange={(next) => {
        onTypeFilterChange?.(next);
        setTypeFilter(next);
      }}
      selectedId={selectedId}
      onSelectedIdChange={setSelectedId}
      scrollTopRef={scrollTopRef}
    />
  );
}

const REIMBURSE = makeItem({
  id: "1",
  term: "reimburse",
  translation: "hoàn trả",
  sentence_context: "The company will reimburse your travel expenses.",
  type: "word",
});
const GO_A_LONG_WAY = makeItem({
  id: "2",
  term: "go a long way toward",
  translation: "góp phần đáng kể vào",
  sentence_context: "Small habits go a long way toward better health.",
  segment_index: 3,
  type: "phrase",
});
const POSTPONE = makeItem({
  id: "3",
  term: "postpone",
  translation: "trì hoãn",
  sentence_context: "We had to postpone the meeting.",
  type: "word",
});

// Safe default for every test: VocabularyDetailDialog's canonical-form
// backfill effect (see its useEffect calling PATCH /api/vocabulary) can
// fire for any legacy item (canonical_form null) opened alongside a
// matching highlight-cache phrase, regardless of what a given test is
// actually exercising. Individual tests that care about specific fetch
// behavior (the pronunciation tests below) still assign their own
// global.fetch mock for the duration of the test; this only provides a
// harmless fallback so unrelated tests never hit a real/undefined fetch.
const realFetch = global.fetch;
beforeEach(() => {
  global.fetch = jest.fn(() => Promise.resolve({ ok: true, json: async () => ({}) })) as unknown as typeof fetch;
});
afterEach(() => {
  global.fetch = realFetch;
});

describe("Vocabulary tab label", () => {
  it("renames the user-facing label to Vocabulary while keeping the internal id 'words'", () => {
    const tab = TAB_CONFIG.find((t) => t.id === "words");
    expect(tab?.id).toBe("words");
    expect(tab?.label).toBe("Vocabulary");
  });
});

describe("WordsTab search and filter", () => {
  const items = [REIMBURSE, GO_A_LONG_WAY, POSTPONE];

  it("shows the empty state when there are no saved items", () => {
    render(<Harness items={[]} />);
    expect(screen.getByText("No vocabulary saved yet.")).toBeInTheDocument();
  });

  it("filters by English term, case-insensitively", () => {
    render(<Harness items={items} />);
    fireEvent.change(screen.getByRole("textbox", { name: /search vocabulary/i }), {
      target: { value: "REIMBURSE" },
    });
    expect(screen.getByText("reimburse")).toBeInTheDocument();
    expect(screen.queryByText("postpone")).not.toBeInTheDocument();
  });

  it("filters by Vietnamese translation, accent-insensitively", () => {
    render(<Harness items={items} />);
    fireEvent.change(screen.getByRole("textbox", { name: /search vocabulary/i }), {
      target: { value: "tri hoan" },
    });
    expect(screen.getByText("postpone")).toBeInTheDocument();
    expect(screen.queryByText("reimburse")).not.toBeInTheDocument();
  });

  it("filters by source sentence", () => {
    render(<Harness items={items} />);
    fireEvent.change(screen.getByRole("textbox", { name: /search vocabulary/i }), {
      target: { value: "better health" },
    });
    expect(screen.getByText("go a long way toward")).toBeInTheDocument();
    expect(screen.queryByText("reimburse")).not.toBeInTheDocument();
  });

  it("clears the query via the clear button", () => {
    render(<Harness items={items} />);
    const input = screen.getByRole("textbox", { name: /search vocabulary/i });
    fireEvent.change(input, { target: { value: "reimburse" } });
    expect(screen.queryByText("postpone")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Clear search query"));
    expect(input).toHaveValue("");
    expect(screen.getByText("postpone")).toBeInTheDocument();
  });

  it("filters by type (Words / Phrases)", () => {
    render(<Harness items={items} />);
    fireEvent.click(screen.getByRole("button", { name: "Phrases" }));
    expect(screen.getByText("go a long way toward")).toBeInTheDocument();
    expect(screen.queryByText("reimburse")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Words" }));
    expect(screen.getByText("reimburse")).toBeInTheDocument();
    expect(screen.queryByText("go a long way toward")).not.toBeInTheDocument();
  });

  it("shows a no-results state with a clear-search action when nothing matches", () => {
    render(<Harness items={items} />);
    fireEvent.change(screen.getByRole("textbox", { name: /search vocabulary/i }), {
      target: { value: "zzz-no-match" },
    });
    expect(screen.getByText("No vocabulary matches your search.")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Clear search"));
    expect(screen.getByText("reimburse")).toBeInTheDocument();
  });

  it("shows a type-specific empty state (not the search message) when only the type filter excludes everything", () => {
    render(<Harness items={[REIMBURSE, POSTPONE]} />);
    fireEvent.click(screen.getByRole("button", { name: "Phrases" }));
    expect(screen.getByText("No phrases saved yet.")).toBeInTheDocument();
    expect(screen.queryByText("No vocabulary matches your search.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Show all vocabulary"));
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("reimburse")).toBeInTheDocument();
  });
});

describe("WordsTab row interaction", () => {
  it("opens the detail dialog on row click without seeking the video", () => {
    const onSeekToSegment = jest.fn();
    render(<Harness items={[REIMBURSE]} onSeekToSegment={onSeekToSegment} />);
    fireEvent.click(screen.getByRole("button", { name: /reimburse/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(onSeekToSegment).not.toHaveBeenCalled();
  });

  it("only seeks when 'View in video' is explicitly clicked", () => {
    const onSeekToSegment = jest.fn();
    render(<Harness items={[GO_A_LONG_WAY]} onSeekToSegment={onSeekToSegment} />);
    fireEvent.click(screen.getByRole("button", { name: /go a long way toward/i }));
    expect(screen.getByText("Sentence 4")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /view in video/i }));
    expect(onSeekToSegment).toHaveBeenCalledWith(3);
  });
});

describe("WordsTab row thumbnail sizing", () => {
  // Regression coverage for the row-overflow fix: a reserved-but-empty
  // thumbnail slot used to sit in every row regardless of whether the item
  // had an image, and a broken image URL rendered as a blank box with no
  // indication anything was wrong. Both now collapse/fall back instead.
  it("does not reserve a thumbnail column for an item with no image", () => {
    render(<Harness items={[REIMBURSE]} />);
    const row = screen.getByRole("button", { name: /reimburse/i });
    expect(row.querySelector("img")).not.toBeInTheDocument();
  });

  it("swaps a broken thumbnail image for a fallback icon instead of a blank box", () => {
    const withImage = makeItem({
      id: "5",
      term: "lighthouse",
      translation: "hải đăng",
      image_thumbnail_url: "https://example.com/broken.jpg",
    });
    render(<Harness items={[withImage]} />);
    const row = screen.getByRole("button", { name: /lighthouse/i });
    const img = row.querySelector("img");
    expect(img).toBeInTheDocument();
    fireEvent.error(img as HTMLImageElement);
    expect(row.querySelector("img")).not.toBeInTheDocument();
    expect(row.querySelector("svg")).toBeInTheDocument();
  });
});

describe("WordsTab row text wrapping", () => {
  // Regression coverage for the overflow fix: the term/translation used to
  // be hard-truncated to a single line (`truncate`), which the fix relaxes
  // to a two-line clamp. Confirm both the full multi-line text is present in
  // the DOM (so it isn't silently cut down to one line's worth of content)
  // and that an unbroken run with no natural break points doesn't throw or
  // get dropped either.
  it("keeps the full multi-line translation text in the DOM rather than a single-line-truncated fragment", () => {
    const longTranslation = makeItem({
      id: "6",
      term: "reconcile",
      translation:
        "làm cho phù hợp trở lại, giải quyết một cách ổn thỏa những khác biệt hoặc mâu thuẫn giữa hai bên",
    });
    render(<Harness items={[longTranslation]} />);
    expect(
      screen.getByText(
        "làm cho phù hợp trở lại, giải quyết một cách ổn thỏa những khác biệt hoặc mâu thuẫn giữa hai bên"
      )
    ).toBeInTheDocument();
  });

  it("renders a long unbroken term without throwing", () => {
    const unbroken = makeItem({
      id: "7",
      term: "a".repeat(120),
      translation: "b".repeat(120),
    });
    render(<Harness items={[unbroken]} />);
    expect(screen.getByText("a".repeat(120))).toBeInTheDocument();
  });
});

describe("VocabularyDetailDialog content", () => {
  it("shows the main translation", () => {
    render(<Harness items={[REIMBURSE]} />);
    fireEvent.click(screen.getByRole("button", { name: /reimburse/i }));
    expect(within(screen.getByRole("dialog")).getByText("hoàn trả")).toBeInTheDocument();
  });

  it("shows the learning pattern from the persisted item even with no highlight cache loaded", () => {
    const persisted = makeItem({
      id: "4",
      term: "give up",
      canonical_form: "give up",
      learning_pattern: "give up + V-ing",
      sentence_context: "Don't give up on your dreams.",
      type: "phrase",
    });
    render(<Harness items={[persisted]} />);
    fireEvent.click(screen.getByRole("button", { name: /give up/i }));
    expect(screen.getByText("give up + V-ing")).toBeInTheDocument();
  });

  it("shows the learning pattern when the highlight cache has a matching phrase", () => {
    const phrasesBySegmentIndex = new Map<number, VocabHighlightPhrase[]>([
      [
        3,
        [
          {
            phrase: "go a long way toward",
            translation: "góp phần đáng kể vào",
            canonicalForm: "go a long way toward(s)",
            learningPattern: "go a long way toward(s) + noun/V-ing",
          },
        ],
      ],
    ]);
    render(<Harness items={[GO_A_LONG_WAY]} phrasesBySegmentIndex={phrasesBySegmentIndex} />);
    fireEvent.click(screen.getByRole("button", { name: /go a long way toward/i }));
    expect(screen.getByText("go a long way toward(s) + noun/V-ing")).toBeInTheDocument();
  });

  it("shows the canonical form as the dialog title, with the surface term as an 'In this sentence:' line, matching the popover/tooltip convention", () => {
    const phrasesBySegmentIndex = new Map<number, VocabHighlightPhrase[]>([
      [
        3,
        [
          {
            phrase: "go a long way toward",
            translation: "góp phần đáng kể vào",
            canonicalForm: "go a long way toward(s)",
            learningPattern: "go a long way toward(s) + noun/V-ing",
          },
        ],
      ],
    ]);
    render(<Harness items={[GO_A_LONG_WAY]} phrasesBySegmentIndex={phrasesBySegmentIndex} />);
    fireEvent.click(screen.getByRole("button", { name: /go a long way toward/i }));
    const dialog = screen.getByRole("dialog");
    // Appears twice: once as ReportDialogShell's small accessible <h2>
    // title, once as the large, prominent heading in the dialog body.
    expect(within(dialog).getAllByText("go a long way toward(s)").length).toBeGreaterThanOrEqual(2);
    expect(within(dialog).getByText("In this sentence: go a long way toward")).toBeInTheDocument();
  });

  it("hides the Pattern section cleanly when no highlight matches (legacy record)", () => {
    render(<Harness items={[REIMBURSE]} />);
    fireEvent.click(screen.getByRole("button", { name: /reimburse/i }));
    expect(screen.queryByText("Pattern")).not.toBeInTheDocument();
  });

  it("highlights the saved term inside its source sentence", () => {
    render(<Harness items={[REIMBURSE]} />);
    fireEvent.click(screen.getByRole("button", { name: /reimburse/i }));
    const marks = screen.getAllByText("reimburse");
    expect(marks.some((el) => el.tagName === "MARK")).toBe(true);
  });

  it("renders no empty sections, dashes, or 'undefined' for a legacy item missing optional fields", () => {
    render(<Harness items={[REIMBURSE]} />);
    fireEvent.click(screen.getByRole("button", { name: /reimburse/i }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).not.toMatch(/undefined/i);
    expect(dialog.textContent).not.toContain(" - ");
    // The collapsed Details section always has the saved date, but must not
    // show empty Definition/Note/Pronunciation rows for fields this legacy
    // item never had.
    expect(screen.getByText("Details")).toBeInTheDocument();
    expect(screen.queryByText("Definition")).not.toBeInTheDocument();
    expect(screen.queryByText("Note")).not.toBeInTheDocument();
    expect(screen.queryByText("Pronunciation")).not.toBeInTheDocument();
  });
});

describe("VocabularyDetailDialog image", () => {
  it("shows the item's image, starting in a loading state and swapping to loaded once it fires", () => {
    const withImage = makeItem({
      id: "10",
      term: "lighthouse",
      image_url: "https://example.com/lighthouse-full.jpg",
      image_thumbnail_url: "https://example.com/lighthouse-thumb.jpg",
    });
    render(<Harness items={[withImage]} />);
    fireEvent.click(screen.getByRole("button", { name: /lighthouse/i }));
    const dialog = screen.getByRole("dialog");
    const img = dialog.querySelector("img") as HTMLImageElement;
    expect(img).toBeInTheDocument();
    // Prefers the full image over the thumbnail when both are present.
    expect(img).toHaveAttribute("src", "https://example.com/lighthouse-full.jpg");
    expect(img).toHaveClass("hidden"); // loading: image hidden behind the spinner
    fireEvent.load(img);
    expect(img).not.toHaveClass("hidden");
  });

  it("falls back to the thumbnail URL when only that field is populated", () => {
    const thumbOnly = makeItem({
      id: "11",
      term: "meadow",
      image_url: null,
      image_thumbnail_url: "https://example.com/meadow-thumb.jpg",
    });
    render(<Harness items={[thumbOnly]} />);
    fireEvent.click(screen.getByRole("button", { name: /meadow/i }));
    expect(screen.getByRole("dialog").querySelector("img")).toHaveAttribute(
      "src",
      "https://example.com/meadow-thumb.jpg"
    );
  });

  it("shows no image section for an item without one", () => {
    render(<Harness items={[REIMBURSE]} />);
    fireEvent.click(screen.getByRole("button", { name: /reimburse/i }));
    expect(screen.getByRole("dialog").querySelector("img")).not.toBeInTheDocument();
  });

  it("shows a broken-image fallback with a working retry after the image fails to load", () => {
    const withImage = makeItem({ id: "12", term: "harbor", image_url: "https://example.com/broken.jpg" });
    render(<Harness items={[withImage]} />);
    fireEvent.click(screen.getByRole("button", { name: /harbor/i }));
    const dialog = screen.getByRole("dialog");
    fireEvent.error(dialog.querySelector("img") as HTMLImageElement);

    expect(dialog.querySelector("img")).not.toBeInTheDocument();
    expect(screen.getByText("Image failed to load.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(screen.queryByText("Image failed to load.")).not.toBeInTheDocument();
    expect(dialog.querySelector("img")).toBeInTheDocument();
  });

  it("keeps showing the image across an unrelated field update on the same item", () => {
    const withImage = makeItem({
      id: "13",
      term: "orchard",
      translation: "vườn cây ăn quả",
      image_url: "https://example.com/orchard.jpg",
    });
    const { rerender } = render(<Harness items={[withImage]} />);
    fireEvent.click(screen.getByRole("button", { name: /orchard/i }));
    expect(screen.getByRole("dialog").querySelector("img")).toHaveAttribute(
      "src",
      "https://example.com/orchard.jpg"
    );

    const updated = makeItem({ ...withImage, translation: "khu vườn" });
    rerender(<Harness items={[updated]} />);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("khu vườn")).toBeInTheDocument();
    expect(dialog.querySelector("img")).toHaveAttribute("src", "https://example.com/orchard.jpg");
  });

  it("respects an explicit image removal instead of preserving the old one indefinitely", () => {
    const withImage = makeItem({
      id: "14",
      term: "trail",
      image_url: "https://example.com/trail.jpg",
      image_thumbnail_url: "https://example.com/trail-thumb.jpg",
    });
    const { rerender } = render(<Harness items={[withImage]} />);
    fireEvent.click(screen.getByRole("button", { name: /trail/i }));
    expect(screen.getByRole("dialog").querySelector("img")).toBeInTheDocument();

    const cleared = makeItem({ ...withImage, image_url: null, image_thumbnail_url: null });
    rerender(<Harness items={[cleared]} />);
    expect(screen.getByRole("dialog").querySelector("img")).not.toBeInTheDocument();
  });

  it("resets image load state when switching directly from a broken-image item to a working one", () => {
    const broken = makeItem({ id: "15", term: "cliffside", image_url: "https://example.com/broken2.jpg" });
    const working = makeItem({ id: "16", term: "riverdelta", image_url: "https://example.com/working.jpg" });
    render(<Harness items={[broken, working]} />);

    fireEvent.click(screen.getByRole("button", { name: /cliffside/i }));
    fireEvent.error(screen.getByRole("dialog").querySelector("img") as HTMLImageElement);
    expect(screen.getByText("Image failed to load.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /riverdelta/i }));
    const dialog = screen.getByRole("dialog");
    expect(screen.queryByText("Image failed to load.")).not.toBeInTheDocument();
    const img = dialog.querySelector("img") as HTMLImageElement;
    expect(img).toHaveAttribute("src", "https://example.com/working.jpg");
    expect(img).toHaveClass("hidden"); // fresh item starts loading again, not stuck on the previous item's error
  });

  it("opens an enlarged view on click, closes on Escape without closing the vocabulary dialog, and returns focus to the trigger", () => {
    const withImage = makeItem({ id: "17", term: "canyon", image_url: "https://example.com/canyon.jpg" });
    render(<Harness items={[withImage]} />);
    fireEvent.click(screen.getByRole("button", { name: /canyon/i }));

    const trigger = screen.getByRole("button", { name: /enlarge image/i });
    fireEvent.load(trigger.querySelector("img") as HTMLImageElement);
    fireEvent.click(trigger);

    // Both the vocab dialog and the lightbox are named "canyon" (the term),
    // but only the lightbox lacks aria-labelledby (it uses a plain
    // aria-label) — that's how we tell them apart here.
    const dialogsWhileOpen = screen.getAllByRole("dialog");
    expect(dialogsWhileOpen).toHaveLength(2); // vocab dialog still open underneath
    const lightbox = dialogsWhileOpen.find((el) => !el.hasAttribute("aria-labelledby"));
    expect(lightbox).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    const dialogsAfterEscape = screen.getAllByRole("dialog");
    expect(dialogsAfterEscape).toHaveLength(1); // only the vocab dialog survived
    expect(dialogsAfterEscape[0]).toHaveAttribute("aria-labelledby");
    expect(trigger).toHaveFocus();
  });
});

describe("VocabularyDetailDialog part of speech / phonetic / pronunciation", () => {
  it("shows the dictionary part of speech instead of the generic 'Word' badge when available", () => {
    const withPos = makeItem({ id: "18", term: "orbit", part_of_speech: "noun" });
    render(<Harness items={[withPos]} />);
    fireEvent.click(screen.getByRole("button", { name: /orbit/i }));
    expect(within(screen.getByRole("dialog")).getByText("Noun")).toBeInTheDocument();
    expect(within(screen.getByRole("dialog")).queryByText("Word")).not.toBeInTheDocument();
  });

  it("falls back to the generic 'Word' badge when no part of speech is known", () => {
    render(<Harness items={[REIMBURSE]} />); // part_of_speech: null
    fireEvent.click(screen.getByRole("button", { name: /reimburse/i }));
    expect(within(screen.getByRole("dialog")).getByText("Word")).toBeInTheDocument();
  });

  it("never invents a grammatical classification for a phrase — shows the plain 'Phrase' badge", () => {
    render(<Harness items={[GO_A_LONG_WAY]} />);
    fireEvent.click(screen.getByRole("button", { name: /go a long way toward/i }));
    expect(within(screen.getByRole("dialog")).getByText("Phrase")).toBeInTheDocument();
  });

  it("shows the phonetic transcription below the heading when available", () => {
    const withPhonetic = makeItem({ id: "19", term: "orbit", phonetic: "/ˈɔːbɪt/" });
    render(<Harness items={[withPhonetic]} />);
    fireEvent.click(screen.getByRole("button", { name: /orbit/i }));
    expect(within(screen.getByRole("dialog")).getByText("/ˈɔːbɪt/")).toBeInTheDocument();
  });

  it("still shows a pronunciation control (idle, eligible for on-demand synthesis) when the item has no audio_url", () => {
    render(<Harness items={[REIMBURSE]} />);
    fireEvent.click(screen.getByRole("button", { name: /reimburse/i }));
    expect(screen.getByRole("button", { name: /play pronunciation of "reimburse"/i })).toBeInTheDocument();
  });

  it("resolves pronunciation on demand via the pronounce route and shows a 'ready to play' state instead of auto-playing", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ audioUrl: "https://cdn.example.com/azure/abc.mp3", source: "synthesized" }),
    });
    const originalFetch = global.fetch;
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<Harness items={[REIMBURSE]} />);
    fireEvent.click(screen.getByRole("button", { name: /reimburse/i }));
    const button = screen.getByRole("button", { name: /play pronunciation of "reimburse"/i });

    fireEvent.click(button);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/vocabulary/pronounce",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ itemId: "1" }) })
    );
    expect(screen.getByRole("button", { name: /tap to play pronunciation of "reimburse"/i })).toBeInTheDocument();
    expect(screen.getByText("Tap to play")).toBeInTheDocument();

    global.fetch = originalFetch;
  });

  it("backfills canonical_form/learning_pattern via PATCH when a legacy item resolves them only from the live highlight cache", async () => {
    const patchCalls: unknown[] = [];
    const fetchMock = jest.fn((url: string, init?: RequestInit) => {
      if (url === "/api/vocabulary" && init?.method === "PATCH") {
        patchCalls.push(JSON.parse(init.body as string));
        return Promise.resolve({ ok: true, json: async () => ({ item: {} }) });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const originalFetch = global.fetch;
    global.fetch = fetchMock as unknown as typeof fetch;

    const legacyItem = makeItem({
      id: "21",
      term: "jumped at",
      canonical_form: null,
      learning_pattern: null,
      segment_index: 5,
    });
    const phrasesBySegmentIndex = new Map([
      [
        5,
        [
          {
            phrase: "jumped at",
            translation: null,
            canonicalForm: "jump at",
            learningPattern: "jump at + object",
          },
        ],
      ],
    ]);

    render(<Harness items={[legacyItem]} phrasesBySegmentIndex={phrasesBySegmentIndex} />);
    fireEvent.click(screen.getByRole("button", { name: /jumped at/i }));

    await act(async () => {
      await Promise.resolve();
    });

    expect(patchCalls).toEqual([{ id: "21", canonicalForm: "jump at", learningPattern: "jump at + object" }]);

    global.fetch = originalFetch;
  });

  it("does not backfill (never calls PATCH) when the persisted canonical_form is already set", async () => {
    const fetchSpy = jest.fn(() => {
      throw new Error("fetch should not be called");
    });
    const originalFetch = global.fetch;
    global.fetch = fetchSpy as unknown as typeof fetch;

    const persisted = makeItem({ id: "22", term: "given up", canonical_form: "give up", segment_index: 5 });
    const phrasesBySegmentIndex = new Map([
      [5, [{ phrase: "given up", translation: null, canonicalForm: "give up", learningPattern: "give up + x" }]],
    ]);

    render(<Harness items={[persisted]} phrasesBySegmentIndex={phrasesBySegmentIndex} />);
    fireEvent.click(screen.getByRole("button", { name: /given up/i }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    global.fetch = originalFetch;
  });

  it("shows an error state and does not retry the network when the pronounce route fails", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: "no budget", code: "TTS_QUOTA_EXCEEDED" }),
    });
    const originalFetch = global.fetch;
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<Harness items={[REIMBURSE]} />);
    fireEvent.click(screen.getByRole("button", { name: /reimburse/i }));
    fireEvent.click(screen.getByRole("button", { name: /play pronunciation of "reimburse"/i }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("Pronunciation is temporarily unavailable.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    global.fetch = originalFetch;
  });

  it("plays pronunciation audio on click and stops it when the dialog closes", async () => {
    const playSpy = jest.spyOn(window.HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const pauseSpy = jest.spyOn(window.HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    const withAudio = makeItem({ id: "20", term: "orbit", audio_url: "https://example.com/orbit.mp3" });
    render(<Harness items={[withAudio]} />);
    fireEvent.click(screen.getByRole("button", { name: /orbit/i }));

    const playButton = screen.getByRole("button", { name: /play pronunciation of "orbit"/i });
    fireEvent.click(playButton);
    expect(playSpy).toHaveBeenCalledTimes(1);
    // Let the mocked play() promise (and its .then() state update) resolve.
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.keyDown(window, { key: "Escape" });
    await waitForElementToBeRemoved(() => screen.queryByRole("dialog"));
    expect(pauseSpy).toHaveBeenCalled();

    playSpy.mockRestore();
    pauseSpy.mockRestore();
  });
});

describe("VocabularyDetailDialog overflow menu", () => {
  it("keeps Delete out of the way behind a labeled 'More vocabulary actions' menu, and Escape closes only the menu", () => {
    render(<Harness items={[REIMBURSE]} />);
    fireEvent.click(screen.getByRole("button", { name: /reimburse/i }));

    expect(screen.queryByRole("menuitem", { name: /delete from vocabulary/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /more vocabulary actions/i }));
    expect(screen.getByRole("menuitem", { name: /delete from vocabulary/i })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menuitem", { name: /delete from vocabulary/i })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument(); // the vocab dialog itself is unaffected
  });
});

describe("VocabularyDetailDialog secondary metadata", () => {
  it("moves the saved date into the collapsed Details section instead of showing it prominently", () => {
    render(<Harness items={[REIMBURSE]} />);
    fireEvent.click(screen.getByRole("button", { name: /reimburse/i }));
    const dialog = screen.getByRole("dialog");
    const details = within(dialog).getByText("Details").closest("details") as HTMLDetailsElement;
    expect(details).toBeInTheDocument();
    expect(within(details).getByText("1/1/2026")).toBeInTheDocument();
  });
});

describe("VocabularyDetailDialog heading", () => {
  it("shows the full term text, unmodified, for a long phrase", () => {
    render(<Harness items={[GO_A_LONG_WAY]} />);
    fireEvent.click(screen.getByRole("button", { name: /go a long way toward/i }));
    const headings = within(screen.getByRole("dialog")).getAllByText("go a long way toward");
    expect(headings.length).toBeGreaterThan(0);
    headings.forEach((el) => expect(el.className).not.toMatch(/truncate/));
  });
});

describe("VocabularyDetailDialog edit", () => {
  it("calls onUpdate with the edited values, and the list/detail reflect the update once items change", () => {
    const onUpdate = jest.fn();
    const { rerender } = render(<Harness items={[REIMBURSE]} onUpdate={onUpdate} />);
    fireEvent.click(screen.getByRole("button", { name: /reimburse/i }));
    fireEvent.click(screen.getByRole("button", { name: /^edit$/i }));

    const translationInput = screen.getByPlaceholderText("Translation");
    fireEvent.change(translationInput, { target: { value: "bồi hoàn" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    expect(onUpdate).toHaveBeenCalledWith(
      "1",
      expect.objectContaining({ term: "reimburse", translation: "bồi hoàn" })
    );

    // Simulate the parent applying the successful PATCH response.
    const updated = makeItem({ ...REIMBURSE, translation: "bồi hoàn" });
    rerender(<Harness items={[updated]} onUpdate={onUpdate} />);
    expect(screen.getAllByText("bồi hoàn").length).toBeGreaterThan(0);
  });
});

describe("VocabularyDetailDialog delete", () => {
  it("requires confirmation before deleting, reached via the overflow menu", () => {
    const onDelete = jest.fn();
    const confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(false);
    render(<Harness items={[REIMBURSE]} onDelete={onDelete} />);
    fireEvent.click(screen.getByRole("button", { name: /reimburse/i }));
    fireEvent.click(screen.getByRole("button", { name: /more vocabulary actions/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /delete from vocabulary/i }));
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining("reimburse"));
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it("deletes and closes the dialog once confirmed", async () => {
    const onDelete = jest.fn();
    const confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(true);
    render(<Harness items={[REIMBURSE]} onDelete={onDelete} />);
    fireEvent.click(screen.getByRole("button", { name: /reimburse/i }));
    fireEvent.click(screen.getByRole("button", { name: /more vocabulary actions/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /delete from vocabulary/i }));
    expect(onDelete).toHaveBeenCalledWith("1");
    // The dialog's exit animation (Framer Motion, via ReportDialogShell)
    // keeps it mounted briefly after `open` flips to false.
    await waitForElementToBeRemoved(() => screen.queryByRole("dialog"));
    confirmSpy.mockRestore();
  });
});

describe("WordsTab error banner", () => {
  it("shows the learning error with a working retry", () => {
    const learningErrorRetry = jest.fn();
    render(<Harness items={[REIMBURSE]} learningError="Failed to save." learningErrorRetry={learningErrorRetry} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Failed to save.");
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(learningErrorRetry).toHaveBeenCalled();
  });
});

describe("VocabularyDetailDialog state preservation", () => {
  it("does not touch search/filter state on close", async () => {
    const onQueryChange = jest.fn();
    const onTypeFilterChange = jest.fn();
    render(
      <Harness
        items={[REIMBURSE]}
        initialQuery="reimburse"
        initialTypeFilter="word"
        onQueryChange={onQueryChange}
        onTypeFilterChange={onTypeFilterChange}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /reimburse/i }));
    fireEvent.keyDown(window, { key: "Escape" });
    await waitForElementToBeRemoved(() => screen.queryByRole("dialog"));
    expect(onQueryChange).not.toHaveBeenCalled();
    expect(onTypeFilterChange).not.toHaveBeenCalled();
  });
});

describe("VocabularyDetailDialog accessibility", () => {
  it("has dialog semantics and closes on Escape", async () => {
    render(<Harness items={[REIMBURSE]} />);
    fireEvent.click(screen.getByRole("button", { name: /reimburse/i }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    const labelledBy = dialog.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy as string)).toHaveTextContent("reimburse");

    fireEvent.keyDown(window, { key: "Escape" });
    await waitForElementToBeRemoved(() => screen.queryByRole("dialog"));
  });
});

describe("VocabularyDetailDialog does not trigger new network requests", () => {
  it("never calls fetch merely from opening an item", () => {
    const originalFetch = global.fetch;
    const fetchSpy = jest.fn(() => {
      throw new Error("fetch should not be called");
    });
    global.fetch = fetchSpy as unknown as typeof fetch;
    render(<Harness items={[REIMBURSE]} />);
    fireEvent.click(screen.getByRole("button", { name: /reimburse/i }));
    expect(fetchSpy).not.toHaveBeenCalled();
    global.fetch = originalFetch;
  });
});
