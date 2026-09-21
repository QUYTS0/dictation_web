import { clsx } from "clsx";
import { getVocabularyLearningStatus, type VocabularyLearningStatus } from "@/lib/utils/vocabulary";
import type { VocabularyItem } from "@/lib/types";

const STATUS_LABEL: Record<VocabularyLearningStatus, string> = {
  new: "New",
  learning: "Learning",
  due: "Due for review",
};

const STATUS_BADGE_CLASS: Record<VocabularyLearningStatus, string> = {
  new: "bg-slate-100 text-slate-600",
  learning: "bg-indigo-100 text-indigo-700",
  due: "bg-amber-100 text-amber-700",
};

/** Truthful replacement for the old note-based "Mastery %" bar — status is
 *  derived purely from the item's SM-2 review fields via
 *  getVocabularyLearningStatus (src/lib/utils/vocabulary.ts), never from
 *  whether it happens to have a personal note. Shared by VocabularyCard
 *  (header row) and VocabularyDetailDrawer. */
export function VocabularyStatusBadge({ item }: { item: VocabularyItem }) {
  const status = getVocabularyLearningStatus(item);
  return (
    <span
      data-testid="vocab-status-badge"
      className={clsx(
        "rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide",
        STATUS_BADGE_CLASS[status]
      )}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}
