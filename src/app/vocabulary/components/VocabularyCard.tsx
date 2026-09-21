import Link from "next/link";
import { clsx } from "clsx";
import { Pencil, Trash2 } from "lucide-react";
import { motion } from "motion/react";
import { canonicalFormDiffersFromSurface } from "@/lib/utils/vocabulary";
import type { VocabularyItem } from "@/lib/types";
import { VocabularyPronunciationButton } from "./VocabularyPronunciationButton";
import { VocabularyStatusBadge } from "./VocabularyStatusBadge";

export interface VocabularyCardProps {
  item: VocabularyItem;
  index: number;
  isSelected: boolean;
  isDeleting: boolean;
  isUpdating: boolean;
  onSelect: (id: string) => void;
  onEdit: (item: VocabularyItem) => void;
  onDelete: (id: string) => void;
}

/**
 * Compact Vocabulary Bank card. The card itself (<article>) is a plain,
 * non-interactive container — the actual "open details" control is the
 * first child, a visually-invisible native <button> stretched to cover the
 * whole card (the standard accessible "clickable card" pattern, cf.
 * Bootstrap's .stretched-link). Real actions (audio/edit/delete/source) are
 * pulled above it purely via `relative z-10`, so clicks on them never reach
 * the stretched button — no stopPropagation anywhere. See
 * .claude/plans (Vocabulary Bank plan) §D for the full rationale.
 */
export function VocabularyCard({ item, index, isSelected, isDeleting, isUpdating, onSelect, onEdit, onDelete }: VocabularyCardProps) {
  const displayTerm = item.canonical_form ?? item.term;
  const sourceHref = `/dictation/${item.video_id}?segment=${item.segment_index}`;

  return (
    <motion.article
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.05 }}
      data-testid="vocab-card"
      data-item-id={item.id}
      className={clsx(
        "group relative flex w-full max-w-[360px] flex-col gap-2 rounded-3xl border border-white/60 bg-white/40 p-4 shadow-xl backdrop-blur-xl transition-all hover:-translate-y-1",
        isSelected && "ring-2 ring-primary-500"
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
          <div className="relative z-10 flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => onEdit(item)}
              disabled={isDeleting || isUpdating}
              className="rounded-lg border border-white/60 bg-white/50 p-1.5 transition-colors hover:bg-white/80 disabled:opacity-40"
              aria-label={`Edit vocabulary ${item.term}`}
            >
              <Pencil size={14} className="text-slate-500" />
            </button>
            <button
              type="button"
              onClick={() => onDelete(item.id)}
              disabled={isDeleting || isUpdating}
              className="rounded-lg border border-white/60 bg-white/50 p-1.5 transition-colors hover:bg-red-50 disabled:opacity-40"
              aria-label={isDeleting ? `Removing vocabulary ${item.term}` : `Remove vocabulary ${item.term}`}
            >
              <Trash2 size={14} className="text-slate-500" />
            </button>
          </div>
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

      <Link
        href={sourceHref}
        className="relative z-10 inline-block w-fit text-xs font-semibold text-primary-600 underline hover:text-primary-700"
      >
        ↗ Source
      </Link>
    </motion.article>
  );
}
