import { useRef, useState } from "react";
import { fireEvent, render, screen, waitForElementToBeRemoved, within } from "@testing-library/react";
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
    sentence_context: "The company will reimburse your travel expenses.",
    note: null,
    translation: "hoàn trả",
    translation_language: "vi",
    translation_source: "azure",
    phonetic: null,
    part_of_speech: null,
    definition: null,
    definition_source: null,
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
});

describe("WordsTab row interaction", () => {
  it("opens the detail dialog on row click without seeking the video", () => {
    const onSeekToSegment = jest.fn();
    render(<Harness items={[REIMBURSE]} onSeekToSegment={onSeekToSegment} />);
    fireEvent.click(screen.getByRole("button", { name: /reimburse/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(onSeekToSegment).not.toHaveBeenCalled();
  });

  it("only seeks when 'Jump to sentence' is explicitly clicked", () => {
    const onSeekToSegment = jest.fn();
    render(<Harness items={[GO_A_LONG_WAY]} onSeekToSegment={onSeekToSegment} />);
    fireEvent.click(screen.getByRole("button", { name: /go a long way toward/i }));
    fireEvent.click(screen.getByRole("button", { name: /jump to sentence/i }));
    expect(onSeekToSegment).toHaveBeenCalledWith(3);
  });
});

describe("VocabularyDetailDialog content", () => {
  it("shows the main translation", () => {
    render(<Harness items={[REIMBURSE]} />);
    fireEvent.click(screen.getByRole("button", { name: /reimburse/i }));
    expect(within(screen.getByRole("dialog")).getByText("hoàn trả")).toBeInTheDocument();
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
    expect(screen.queryByText("More details")).not.toBeInTheDocument();
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
  it("requires confirmation before deleting", () => {
    const onDelete = jest.fn();
    const confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(false);
    render(<Harness items={[REIMBURSE]} onDelete={onDelete} />);
    fireEvent.click(screen.getByRole("button", { name: /reimburse/i }));
    fireEvent.click(screen.getByRole("button", { name: /delete from vocabulary/i }));
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
    fireEvent.click(screen.getByRole("button", { name: /delete from vocabulary/i }));
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
