import { clsx } from "clsx";
import { motion } from "motion/react";
import { canonicalFormDiffersFromSurface } from "@/lib/utils/vocabulary";
import type { VocabularyItem } from "@/lib/types";
import { VocabularyPronunciationButton } from "./VocabularyPronunciationButton";
import { VocabularyStatusBadge } from "./VocabularyStatusBadge";

export interface VocabularyCardProps {
  item: VocabularyItem;
  index: number;
  isSelected: boolean;
  isChecked: boolean;
  /** Disables *checking* this card on (client-enforced) at the shared bulk
   *  selection cap — unchecking an already-checked card is always allowed
   *  regardless of this flag. See MAX_BULK_SELECTABLE_ITEMS. */
  atSelectionCap: boolean;
  isDeleting: boolean;
  isUpdating: boolean;
  onSelect: (id: string) => void;
  onToggleSelect: (id: string) => void;
}

/**
 * Compact Vocabulary Bank card. The card itself (<article>) is a plain,
 * non-interactive container — the actual "open details" control is the
 * first child, a visually-invisible native <button> stretched to cover the
 * whole card (the standard accessible "clickable card" pattern, cf.
 * Bootstrap's .stretched-link). Real actions (audio/select-checkbox) are
 * pulled above it purely via `relative z-10`, so clicks on them never reach
 * the stretched button — no stopPropagation anywhere. Edit/Delete/Source
 * live only in VocabularyDetailDrawer now, not here — see the Vocabulary UX
 * redesign plan §F.
 */
export function VocabularyCard({
  item,
  index,
  isSelected,
  isChecked,
  atSelectionCap,
  isDeleting,
  isUpdating,
  onSelect,
  onToggleSelect,
}: VocabularyCardProps) {
  const displayTerm = item.canonical_form ?? item.term;

  return (
    <motion.article
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.05 }}
      data-testid="vocab-card"
      data-item-id={item.id}
      className={clsx(
        "group relative flex w-full max-w-[360px] flex-col gap-2 rounded-3xl border border-white/60 bg-white/40 p-4 shadow-xl backdrop-blur-xl transition-all hover:-translate-y-1",
        isSelected && "ring-2 ring-primary-500",
        isChecked && "bg-primary-50/60",
        (isDeleting || isUpdating) && "pointer-events-none opacity-50"
      )}
    >
      <button
        type="button"
        onClick={() => onSelect(item.id)}
        aria-expanded={isSelected}
        aria-controls="vocabulary-detail-drawer"
        aria-label={`Open details for ${displayTerm}`}
        className="absolute inset-0 z-0 cursor-pointer rounded-3xl focus-visible:z-20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2"
      />

      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <input
            type="checkbox"
            checked={isChecked}
            disabled={!isChecked && atSelectionCap}
            onChange={() => onToggleSelect(item.id)}
            aria-label={`Select ${displayTerm}`}
            className="relative z-10 h-4 w-4 shrink-0 cursor-pointer rounded border-slate-300 text-primary-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-40"
          />
          {item.image_thumbnail_url && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={item.image_thumbnail_url}
              alt=""
              className="h-10 w-10 shrink-0 rounded-xl object-cover"
            />
          )}
          <h3
            title={displayTerm}
            className="truncate text-lg font-bold text-slate-900 transition-colors group-hover:text-primary-600"
          >
            {displayTerm}
          </h3>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <VocabularyStatusBadge item={item} />
        </div>
      </div>

      <VocabularyPronunciationButton item={item} />

      {item.translation ? (
        <p className="truncate text-sm font-medium text-slate-700">{item.translation}</p>
      ) : null}

      {canonicalFormDiffersFromSurface(item.canonical_form, item.term) && (
        <p className="truncate text-xs text-slate-400">In this sentence: {item.term}</p>
      )}

      <div className="rounded-xl border border-white/40 bg-white/30 p-2.5 shadow-inner">
        <p className="line-clamp-2 text-sm italic leading-relaxed text-slate-500">
          &quot;{item.sentence_context}&quot;
        </p>
      </div>
    </motion.article>
  );
}
