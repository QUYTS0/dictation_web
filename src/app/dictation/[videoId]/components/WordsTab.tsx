import { useCallback, useMemo, type MutableRefObject } from "react";
import { clsx } from "clsx";
import { BookOpen, Search, X } from "lucide-react";
import type { VocabHighlightPhrase } from "@/lib/types";
import { VocabularyListItem } from "./VocabularyListItem";
import { VocabularyDetailDialog } from "./VocabularyDetailDialog";
import { filterVocabularyItems, resolveVocabularyHighlightMeta, type VocabularyTypeFilter } from "../helpers";
import type { LessonSavedItem } from "../types";

const TYPE_FILTERS: Array<{ id: VocabularyTypeFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "word", label: "Words" },
  { id: "phrase", label: "Phrases" },
];

type EditValues = {
  term: string;
  sentenceContext: string;
  note: string;
  translation: string;
  phonetic: string;
  partOfSpeech: string;
  definition: string;
};

export function WordsTab({
  items,
  deletingId,
  updatingId,
  onDelete,
  onUpdate,
  learningError,
  learningErrorRetry,
  phrasesBySegmentIndex,
  translationBySegmentIndex,
  onSeekToSegment,
  query,
  onQueryChange,
  typeFilter,
  onTypeFilterChange,
  selectedId,
  onSelectedIdChange,
  scrollTopRef,
}: {
  items: LessonSavedItem[];
  deletingId: string | null;
  updatingId: string | null;
  onDelete: (itemId: string) => void;
  onUpdate: (itemId: string, values: EditValues) => void;
  learningError: string | null;
  learningErrorRetry: (() => void) | null;
  phrasesBySegmentIndex: Map<number, VocabHighlightPhrase[]>;
  translationBySegmentIndex: Map<number, string>;
  onSeekToSegment: (segmentIndex: number) => void;
  query: string;
  onQueryChange: (query: string) => void;
  typeFilter: VocabularyTypeFilter;
  onTypeFilterChange: (filter: VocabularyTypeFilter) => void;
  selectedId: string | null;
  onSelectedIdChange: (id: string | null) => void;
  scrollTopRef: MutableRefObject<number>;
}) {
  const resolveMeta = useCallback(
    (item: LessonSavedItem) => resolveVocabularyHighlightMeta(item, phrasesBySegmentIndex),
    [phrasesBySegmentIndex]
  );

  const filteredItems = useMemo(
    () => filterVocabularyItems(items, query, typeFilter, resolveMeta),
    [items, query, typeFilter, resolveMeta]
  );

  const selectedItem = useMemo(() => items.find((item) => item.id === selectedId) ?? null, [items, selectedId]);
  const hasQuery = query.trim().length > 0;
  const isFiltering = hasQuery || typeFilter !== "all";

  const listRefCallback = useCallback(
    (node: HTMLDivElement | null) => {
      if (node) node.scrollTop = scrollTopRef.current;
    },
    [scrollTopRef]
  );

  if (items.length === 0) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-2">
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-center">
          <BookOpen size={32} className="text-[var(--text-faint)]" />
          <p className="text-xs font-medium text-[var(--text-muted)]">No vocabulary saved yet.</p>
        </div>
        {learningError && (
          <p role="alert" className="flex shrink-0 items-center gap-2 text-xs text-[var(--red)]">
            {learningError}
            {learningErrorRetry && (
              <button
                type="button"
                onClick={() => learningErrorRetry()}
                className="font-semibold underline text-[var(--red)] hover:brightness-110"
              >
                Retry
              </button>
            )}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex shrink-0 flex-col gap-2">
        <div className="relative">
          <Search
            size={15}
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-faint)]"
          />
          <input
            type="text"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search vocabulary..."
            aria-label="Search vocabulary"
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] py-2 pl-8 pr-8 text-sm text-[var(--text)] placeholder:text-[var(--text-faint)] focus:border-[var(--accent-border)] focus:outline-none"
          />
          {query && (
            <button
              type="button"
              onClick={() => onQueryChange("")}
              aria-label="Clear search query"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-[var(--text-faint)] hover:text-[var(--text)]"
            >
              <X size={14} />
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {TYPE_FILTERS.map((filter) => (
            <button
              key={filter.id}
              type="button"
              onClick={() => onTypeFilterChange(filter.id)}
              aria-pressed={typeFilter === filter.id}
              className={clsx(
                "rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors",
                typeFilter === filter.id
                  ? "border-[var(--accent-border)] bg-[var(--accent-soft)] text-[var(--accent)]"
                  : "border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]"
              )}
            >
              {filter.label}
            </button>
          ))}
          {isFiltering && (
            <span className="ml-auto shrink-0 text-[11px] text-[var(--text-faint)]">
              {filteredItems.length} of {items.length}
            </span>
          )}
        </div>
      </div>

      {filteredItems.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-center">
          <Search size={28} className="text-[var(--text-faint)]" />
          <p className="text-xs font-medium text-[var(--text-muted)]">
            {hasQuery
              ? "No vocabulary matches your search."
              : `No ${typeFilter === "word" ? "words" : "phrases"} saved yet.`}
          </p>
          <button
            type="button"
            onClick={() => {
              onQueryChange("");
              onTypeFilterChange("all");
            }}
            className="text-xs font-semibold text-[var(--accent)] underline hover:brightness-110"
          >
            {hasQuery ? "Clear search" : "Show all vocabulary"}
          </button>
        </div>
      ) : (
        <div
          ref={listRefCallback}
          onScroll={(event) => {
            scrollTopRef.current = event.currentTarget.scrollTop;
          }}
          className="momentum-scroll flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain pb-1"
        >
          {filteredItems.map((item) => (
            <VocabularyListItem
              key={item.id}
              item={item}
              isOpen={selectedId === item.id}
              onOpen={() => onSelectedIdChange(item.id)}
            />
          ))}
        </div>
      )}

      {learningError && (
        <p role="alert" className="flex shrink-0 items-center gap-2 text-xs text-[var(--red)]">
          {learningError}
          {learningErrorRetry && (
            <button
              type="button"
              onClick={() => learningErrorRetry()}
              className="font-semibold underline text-[var(--red)] hover:brightness-110"
            >
              Retry
            </button>
          )}
        </p>
      )}

      <VocabularyDetailDialog
        item={selectedItem}
        highlightMeta={selectedItem ? resolveMeta(selectedItem) : {}}
        sentenceTranslation={selectedItem ? translationBySegmentIndex.get(selectedItem.segment_index) : undefined}
        onClose={() => onSelectedIdChange(null)}
        onDelete={onDelete}
        onUpdate={onUpdate}
        deletingId={deletingId}
        updatingId={updatingId}
        learningError={learningError}
        learningErrorRetry={learningErrorRetry}
        onSeekToSegment={onSeekToSegment}
      />
    </div>
  );
}
