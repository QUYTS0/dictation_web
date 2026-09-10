import { useState } from "react";
import { clsx } from "clsx";
import { ImageOff } from "lucide-react";
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
  const [imageFailed, setImageFailed] = useState(false);
  const hasThumbnail = Boolean(item.image_thumbnail_url);

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-haspopup="dialog"
      className={clsx(
        // shrink-0: this is a direct child of a vertical flex list — without
        // it, a long list (50+ saved items) would compress every row instead
        // of letting the list's own overflow-y-auto scroll.
        "flex w-full min-h-[3.25rem] shrink-0 items-start gap-2.5 rounded-lg border px-2.5 py-2 text-left outline-none",
        "transition-colors duration-150",
        "hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1",
        isOpen
          ? "border-[var(--accent-border)] bg-[var(--accent-soft)]"
          : "border-[var(--border)] bg-[var(--surface-2)]"
      )}
    >
      {/* Only reserved when there's actually a thumbnail (or one that failed
          to load, so the fallback icon has somewhere to sit) — items without
          an image don't pay for an empty leading column. */}
      {hasThumbnail && (
        <div className={clsx(THUMBNAIL_SIZE_CLASS, "shrink-0 overflow-hidden rounded-md bg-[var(--surface)]")}>
          {imageFailed ? (
            <div className="flex h-full w-full items-center justify-center text-[var(--text-faint)]">
              <ImageOff size={16} aria-hidden="true" />
            </div>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={item.image_thumbnail_url ?? undefined}
              alt=""
              className="h-full w-full object-cover"
              onError={() => setImageFailed(true)}
            />
          )}
        </div>
      )}

      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <span className="min-w-0 line-clamp-2 break-words text-[15px] font-semibold leading-snug text-[var(--text)]">
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
          <p className="mt-0.5 line-clamp-2 break-words text-sm font-medium text-[var(--accent)]">
            {item.translation}
          </p>
        )}
        {item.sentence_context && (
          <p className="mt-0.5 line-clamp-1 break-words text-[12px] text-[var(--text-muted)]">
            {item.sentence_context}
          </p>
        )}
      </div>
    </button>
  );
}
