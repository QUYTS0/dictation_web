import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { VocabularyItem } from "@/lib/types";
import { VocabularyCard } from "@/app/vocabulary/components/VocabularyCard";

function makeItem(overrides: Partial<VocabularyItem> = {}): VocabularyItem {
  return {
    id: "item-1",
    user_id: "user-1",
    video_id: "video-1",
    segment_index: 3,
    term: "go about",
    normalized_term: "go about",
    canonical_form: null,
    learning_pattern: null,
    sentence_context: "Let's see how he goes about this task, step by step, from the very beginning.",
    note: null,
    translation: "làm việc",
    translation_language: "vi",
    translation_source: "azure",
    phonetic: null,
    part_of_speech: null,
    definition: null,
    definition_source: null,
    audio_url: "https://example.com/audio.mp3",
    pronunciation_audio_asset_id: null,
    image_url: null,
    image_thumbnail_url: null,
    image_attribution: null,
    image_source_url: null,
    created_at: new Date().toISOString(),
    next_review_at: new Date().toISOString(),
    interval_days: 0,
    ease_factor: 2.5,
    repetitions: 0,
    last_reviewed_at: null,
    ...overrides,
  };
}

function noop() {}

function renderCard(overrides: Partial<Parameters<typeof VocabularyCard>[0]> = {}) {
  return render(
    <VocabularyCard
      item={makeItem()}
      index={0}
      isSelected={false}
      isChecked={false}
      atSelectionCap={false}
      isDeleting={false}
      isUpdating={false}
      onSelect={noop}
      onToggleSelect={noop}
      {...overrides}
    />
  );
}

describe("VocabularyCard", () => {
  beforeEach(() => {
    // motion/react's reduced-motion check reads matchMedia on mount; jsdom
    // doesn't implement it.
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: jest.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      })),
    });
    jest.spyOn(window.HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    jest.spyOn(window.HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  });

  it('does not render a "Saved" badge', () => {
    renderCard();
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
  });

  it('does not render a standalone "Status" label, but still renders the status badge', () => {
    renderCard();
    expect(screen.queryByText("Status")).not.toBeInTheDocument();
    expect(screen.getByTestId("vocab-status-badge")).toHaveTextContent("New");
  });

  it("clamps the term, translation, and sentence preview so they cannot grow the card", () => {
    renderCard({ item: makeItem({ canonical_form: "go about" }) });
    expect(screen.getByText("go about")).toHaveClass("truncate");
    expect(screen.getByText("làm việc")).toHaveClass("truncate");
    expect(screen.getByText(/Let's see how he goes about/)).toHaveClass("line-clamp-2");
  });

  it("does not render Edit, Delete, or Source controls — those live only in the drawer now", () => {
    renderCard();
    expect(screen.queryByRole("button", { name: /^Edit vocabulary/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /vocabulary go about/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Source/ })).not.toBeInTheDocument();
  });

  it("exposes the open-details control as a real button with aria-expanded reflecting isSelected", () => {
    const { rerender } = renderCard();
    const openButton = screen.getByRole("button", { name: "Open details for go about" });
    expect(openButton).toHaveAttribute("aria-expanded", "false");
    expect(openButton).toHaveAttribute("aria-controls", "vocabulary-detail-drawer");

    rerender(
      <VocabularyCard
        item={makeItem()}
        index={0}
        isSelected
        isChecked={false}
        atSelectionCap={false}
        isDeleting={false}
        isUpdating={false}
        onSelect={noop}
        onToggleSelect={noop}
      />
    );
    expect(screen.getByRole("button", { name: "Open details for go about" })).toHaveAttribute(
      "aria-expanded",
      "true"
    );
  });

  it("calls onSelect when the card's open-details button is clicked", async () => {
    const onSelect = jest.fn();
    const user = userEvent.setup();
    renderCard({ onSelect });
    await user.click(screen.getByRole("button", { name: "Open details for go about" }));
    expect(onSelect).toHaveBeenCalledWith("item-1");
  });

  it("calls onSelect on Enter and on Space when the open-details button is focused", async () => {
    const onSelect = jest.fn();
    const user = userEvent.setup();
    renderCard({ onSelect });
    const openButton = screen.getByRole("button", { name: "Open details for go about" });
    openButton.focus();
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledTimes(1);
    await user.keyboard(" ");
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it("does not call onSelect when the pronunciation button is clicked", async () => {
    const onSelect = jest.fn();
    const user = userEvent.setup();
    renderCard({ onSelect });
    await user.click(screen.getByRole("button", { name: /pronunciation for go about/i }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  describe("multi-select checkbox", () => {
    it("reflects isChecked and calls onToggleSelect without opening the inspector", async () => {
      const onSelect = jest.fn();
      const onToggleSelect = jest.fn();
      const user = userEvent.setup();
      renderCard({ onSelect, onToggleSelect });

      const checkbox = screen.getByRole("checkbox", { name: "Select go about" });
      expect(checkbox).not.toBeChecked();

      await user.click(checkbox);
      expect(onToggleSelect).toHaveBeenCalledWith("item-1");
      expect(onSelect).not.toHaveBeenCalled();
    });

    it("renders as checked when isChecked is true", () => {
      renderCard({ isChecked: true });
      expect(screen.getByRole("checkbox", { name: "Select go about" })).toBeChecked();
    });

    it("disables the checkbox at the selection cap unless this card is already checked", () => {
      const { rerender } = renderCard({ isChecked: false, atSelectionCap: true });
      expect(screen.getByRole("checkbox", { name: "Select go about" })).toBeDisabled();

      rerender(
        <VocabularyCard
          item={makeItem()}
          index={0}
          isSelected={false}
          isChecked
          atSelectionCap
          isDeleting={false}
          isUpdating={false}
          onSelect={noop}
          onToggleSelect={noop}
        />
      );
      expect(screen.getByRole("checkbox", { name: "Select go about" })).toBeEnabled();
    });

    it("applies a distinct tint when checked, independent of the isSelected ring", () => {
      renderCard({ isChecked: true, isSelected: true });
      const card = screen.getByTestId("vocab-card");
      expect(card).toHaveClass("bg-primary-50/60");
      expect(card).toHaveClass("ring-2");
      expect(card).toHaveClass("ring-primary-500");
    });
  });

  it("dims and disables pointer interaction while deleting or updating", () => {
    renderCard({ isDeleting: true });
    expect(screen.getByTestId("vocab-card")).toHaveClass("opacity-50");
    expect(screen.getByTestId("vocab-card")).toHaveClass("pointer-events-none");
  });
});
