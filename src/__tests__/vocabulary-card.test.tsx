import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { VocabularyItem } from "@/lib/types";
import { VocabularyCard } from "@/app/vocabulary/components/VocabularyCard";

// Sidesteps next/link's internal app-router prefetch wiring (needs a full
// router context this test doesn't set up) — plain link rendering is enough.
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
    render(
      <VocabularyCard
        item={makeItem()}
        index={0}
        isSelected={false}
        isDeleting={false}
        isUpdating={false}
        onSelect={noop}
        onEdit={noop}
        onDelete={noop}
      />
    );
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
  });

  it('does not render a standalone "Status" label, but still renders the status badge', () => {
    render(
      <VocabularyCard
        item={makeItem()}
        index={0}
        isSelected={false}
        isDeleting={false}
        isUpdating={false}
        onSelect={noop}
        onEdit={noop}
        onDelete={noop}
      />
    );
    expect(screen.queryByText("Status")).not.toBeInTheDocument();
    expect(screen.getByTestId("vocab-status-badge")).toHaveTextContent("New");
  });

  it("clamps the term, translation, and sentence preview so they cannot grow the card", () => {
    render(
      <VocabularyCard
        item={makeItem({ canonical_form: "go about" })}
        index={0}
        isSelected={false}
        isDeleting={false}
        isUpdating={false}
        onSelect={noop}
        onEdit={noop}
        onDelete={noop}
      />
    );
    expect(screen.getByText("go about")).toHaveClass("truncate");
    expect(screen.getByText("làm việc")).toHaveClass("truncate");
    expect(screen.getByText(/Let's see how he goes about/)).toHaveClass("line-clamp-2");
  });

  it("exposes the open-details control as a real button with aria-expanded reflecting isSelected", () => {
    const { rerender } = render(
      <VocabularyCard
        item={makeItem()}
        index={0}
        isSelected={false}
        isDeleting={false}
        isUpdating={false}
        onSelect={noop}
        onEdit={noop}
        onDelete={noop}
      />
    );
    const openButton = screen.getByRole("button", { name: "Open details for go about" });
    expect(openButton).toHaveAttribute("aria-expanded", "false");
    expect(openButton).toHaveAttribute("aria-controls", "vocabulary-detail-drawer");

    rerender(
      <VocabularyCard
        item={makeItem()}
        index={0}
        isSelected
        isDeleting={false}
        isUpdating={false}
        onSelect={noop}
        onEdit={noop}
        onDelete={noop}
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
    render(
      <VocabularyCard
        item={makeItem()}
        index={0}
        isSelected={false}
        isDeleting={false}
        isUpdating={false}
        onSelect={onSelect}
        onEdit={noop}
        onDelete={noop}
      />
    );
    await user.click(screen.getByRole("button", { name: "Open details for go about" }));
    expect(onSelect).toHaveBeenCalledWith("item-1");
  });

  it("calls onSelect on Enter and on Space when the open-details button is focused", async () => {
    const onSelect = jest.fn();
    const user = userEvent.setup();
    render(
      <VocabularyCard
        item={makeItem()}
        index={0}
        isSelected={false}
        isDeleting={false}
        isUpdating={false}
        onSelect={onSelect}
        onEdit={noop}
        onDelete={noop}
      />
    );
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
    render(
      <VocabularyCard
        item={makeItem()}
        index={0}
        isSelected={false}
        isDeleting={false}
        isUpdating={false}
        onSelect={onSelect}
        onEdit={noop}
        onDelete={noop}
      />
    );
    await user.click(screen.getByRole("button", { name: /pronunciation for go about/i }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("does not call onSelect when Edit is clicked, and calls onEdit with the item instead", async () => {
    const onSelect = jest.fn();
    const onEdit = jest.fn();
    const user = userEvent.setup();
    const item = makeItem();
    render(
      <VocabularyCard
        item={item}
        index={0}
        isSelected={false}
        isDeleting={false}
        isUpdating={false}
        onSelect={onSelect}
        onEdit={onEdit}
        onDelete={noop}
      />
    );
    await user.click(screen.getByRole("button", { name: "Edit vocabulary go about" }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(onEdit).toHaveBeenCalledWith(item);
  });

  it("does not call onSelect when Delete is clicked, and calls onDelete with the id instead", async () => {
    const onSelect = jest.fn();
    const onDelete = jest.fn();
    const user = userEvent.setup();
    render(
      <VocabularyCard
        item={makeItem()}
        index={0}
        isSelected={false}
        isDeleting={false}
        isUpdating={false}
        onSelect={onSelect}
        onEdit={noop}
        onDelete={onDelete}
      />
    );
    await user.click(screen.getByRole("button", { name: "Remove vocabulary go about" }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(onDelete).toHaveBeenCalledWith("item-1");
  });

  it("does not call onSelect when the Source link is clicked, and links to the segment", async () => {
    const onSelect = jest.fn();
    const user = userEvent.setup();
    render(
      <VocabularyCard
        item={makeItem()}
        index={0}
        isSelected={false}
        isDeleting={false}
        isUpdating={false}
        onSelect={onSelect}
        onEdit={noop}
        onDelete={noop}
      />
    );
    const sourceLink = screen.getByRole("link", { name: /Source/ });
    expect(sourceLink).toHaveAttribute("href", "/dictation/video-1?segment=3");
    await user.click(sourceLink);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
