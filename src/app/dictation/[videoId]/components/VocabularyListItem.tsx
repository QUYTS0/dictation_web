import { clsx } from "clsx";
import type { LessonSavedItem } from "../types";

const THUMBNAIL_SIZE_CLASS = "h-9 w-9";

/**
 * One row in the compact Vocabulary list — scanning/selection only, not a
 * full information card (see VocabularyDetailDialog for that). The entire
 * row is a single button: clicking it only opens the detail dialog, it
 * never seeks/plays the video (that's exclusively the detail dialog's
 * explicit "Jump to sentence" action).
 */
export function VocabularyListItem({
  item,
  isOpen,
  onOpen,
}: {
  item: LessonSavedItem;
  /** Whether this item's detail dialog is currently open — a subtle
   *  "currently open" affordance, not a persistent multi-select. */
  isOpen: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-haspopup="dialog"
      className={clsx(
        "flex w-full min-h-[44px] items-start gap-2.5 rounded-lg border px-2.5 py-2 text-left outline-none",
        "transition-colors duration-150",
        "hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1",
        isOpen
          ? "border-[var(--accent-border)] bg-[var(--accent-soft)]"
          : "border-[var(--border)] bg-[var(--surface-2)]"
      )}
    >
      {/* Fixed-size leading slot, always reserved, so rows with and without
          a thumbnail keep identical text alignment. */}
      <div className={clsx(THUMBNAIL_SIZE_CLASS, "shrink-0 overflow-hidden rounded-md")}>
        {item.image_thumbnail_url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={item.image_thumbnail_url} alt="" className="h-full w-full object-cover" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <span className="min-w-0 truncate text-[15px] font-semibold leading-snug text-[var(--text)]">
            {item.term}
          </span>
          <span
            className={clsx(
              "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
              "bg-[var(--accent-soft)] text-[var(--accent)]"
            )}
          >
            {item.type === "word" ? "Word" : "Phrase"}
          </span>
        </div>
        {item.translation && (
          <p className="mt-0.5 truncate text-sm font-medium text-[var(--accent)]">{item.translation}</p>
        )}
        {item.sentence_context && (
          <p className="mt-0.5 line-clamp-1 text-[12px] text-[var(--text-muted)]">{item.sentence_context}</p>
        )}
      </div>
    </button>
  );
}
