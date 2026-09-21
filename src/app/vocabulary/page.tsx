"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { clsx } from "clsx";
import {
  AlertCircle,
  BookOpen,
  Clock,
  Download,
  Filter,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import AppHeader from "@/components/AppHeader";
import { VocabularyCard } from "./components/VocabularyCard";
import { VocabularyDetailDrawer } from "./components/VocabularyDetailDrawer";
import { useAuth } from "@/context/auth";
import { PAGE_PADDING_CLASS, PAGE_WIDTH_CLASS } from "@/lib/layout/pageWidth";
import {
  useVocabularyItemsQuery,
  useVocabularyStatsQuery,
  useUpdateVocabularyItemMutation,
  useDeleteVocabularyItemMutation,
} from "@/lib/queries/vocabulary";
import {
  getVocabularyLearningStatus,
  inferVocabularyItemKind,
  type VocabularyLearningStatus,
} from "@/lib/utils/vocabulary";
import type { VocabularyItem } from "@/lib/types";

function VocabularyStatChip({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | undefined;
}) {
  return (
    <div
      data-testid={`vocab-stat-${label.toLowerCase().replace(/\s+/g, "-")}`}
      className="flex flex-1 items-center gap-3 rounded-2xl border border-white/60 bg-white/50 p-3 px-5 shadow-sm backdrop-blur-md md:flex-initial"
    >
      {icon}
      <div>
        <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">{label}</p>
        <p className="text-lg font-black leading-none text-slate-800">{value ?? "—"}</p>
      </div>
    </div>
  );
}

type TypeFilterValue = "all" | "word" | "phrase";
type StatusFilterValue = "all" | VocabularyLearningStatus;

const TYPE_FILTER_OPTIONS: Array<{ value: TypeFilterValue; label: string }> = [
  { value: "all", label: "All" },
  { value: "word", label: "Words" },
  { value: "phrase", label: "Phrases" },
];

const STATUS_FILTER_OPTIONS: Array<{ value: StatusFilterValue; label: string }> = [
  { value: "all", label: "All" },
  { value: "new", label: "New" },
  { value: "learning", label: "Learning" },
  { value: "due", label: "Due" },
];

function FilterPillGroup<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{label}</span>
      <div className="flex gap-1 rounded-full border border-white/60 bg-white/50 p-1">
        {options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            aria-pressed={value === opt.value}
            className={clsx(
              "rounded-full px-3 py-1 text-xs font-semibold transition-colors",
              value === opt.value ? "bg-primary-600 text-white" : "text-slate-600 hover:bg-white/80"
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * This page renders its own AppHeader (there is no shared authenticated-app
 * layout — see src/app/layout.tsx, which only sets `body{min-h-full}` with
 * no fixed height / no overflow-hidden, since most other pages scroll the
 * whole document normally). That makes this page's own root element the
 * highest point where a definite, capped viewport height can be
 * established without affecting any other route.
 *
 * The root div below deliberately uses `h-dvh` (a definite height) with NO
 * `flex-1`. It's tempting to add `flex-1` since this div is technically a
 * flex item of <body> — but body's height is `min-h-full` (a floor, not a
 * ceiling) with no `overflow:hidden`, so it never becomes a *definite*
 * flex container size. Tailwind's `flex-1` is `flex: 1 1 0%`, which sets an
 * explicit `flex-basis: 0%` that takes priority over `height` for sizing —
 * so with `flex-1` present, `h-dvh` was silently ignored, this div
 * collapsed to its *content's* natural height (taller than one viewport),
 * and body (having no cap) grew to match, producing the outer browser
 * scrollbar on top of the inner list's own overflow-y-auto scrollbar. Only
 * `h-dvh` + `overflow-hidden`, with no `flex-1`, keeps this div reliably
 * pinned to exactly one viewport regardless of body's own sizing.
 */
export default function VocabularyPage() {
  const { user, loading, openAuthModal } = useAuth();
  const userId = user?.id;

  const itemsQuery = useVocabularyItemsQuery(userId);
  const statsQuery = useVocabularyStatsQuery(userId);
  const updateMutation = useUpdateVocabularyItemMutation(userId);
  const deleteMutation = useDeleteVocabularyItemMutation(userId);

  const items = useMemo(() => itemsQuery.data ?? [], [itemsQuery.data]);
  const stats = statsQuery.data;
  // Server-computed, independent of new/due — see VocabularyStatsResponse
  // and isVocabularyItemReviewable for why this isn't derived client-side
  // as `stats.new + stats.due`.
  const reviewableCount = stats?.reviewable;

  const [error, setError] = useState<string | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [drawerMode, setDrawerMode] = useState<"view" | "edit">("view");
  const [editingTerm, setEditingTerm] = useState("");
  const [editingSentenceContext, setEditingSentenceContext] = useState("");
  const [editingNote, setEditingNote] = useState("");
  const [editingTranslation, setEditingTranslation] = useState("");
  const [editingPhonetic, setEditingPhonetic] = useState("");
  const [editingPartOfSpeech, setEditingPartOfSpeech] = useState("");
  const [editingDefinition, setEditingDefinition] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);

  // Search text and filters are intentionally plain, unpersisted component
  // state: every mount (including a bare nav-tab return) starts from
  // Search empty / Type All / Status All / scroll 0. Nothing here reads or
  // writes sessionStorage or the URL — see the Bookmarks/History pages for
  // the (unrelated, still-persisted) usePersistedViewState pattern this
  // page deliberately no longer uses.
  const [searchInput, setSearchInput] = useState("");
  const [typeFilter, setTypeFilter] = useState<TypeFilterValue>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilterValue>("all");

  const selectedItem = useMemo(
    () => items.find((i) => i.id === selectedItemId) ?? null,
    [items, selectedItemId]
  );

  const handleSelect = (id: string) => {
    setSelectedItemId(id);
    setDrawerMode("view");
  };

  const handleCloseDrawer = () => {
    setSelectedItemId(null);
    setDrawerMode("view");
    cancelEdit();
  };

  const handleDelete = (id: string) => {
    setError(null);
    deleteMutation.mutate(id, {
      onSuccess: () => {
        if (selectedItemId === id) {
          setSelectedItemId(null);
          setDrawerMode("view");
        }
      },
      onError: (err) => {
        const message = err instanceof Error && err.message ? err.message : "Failed to delete vocabulary item.";
        setError(message);
      },
    });
  };

  const beginEdit = (item: VocabularyItem) => {
    setEditingTerm(item.term);
    setEditingSentenceContext(item.sentence_context);
    setEditingNote(item.note ?? "");
    setEditingTranslation(item.translation ?? "");
    setEditingPhonetic(item.phonetic ?? "");
    setEditingPartOfSpeech(item.part_of_speech ?? "");
    setEditingDefinition(item.definition ?? "");
  };

  const cancelEdit = () => {
    setEditingTerm("");
    setEditingSentenceContext("");
    setEditingNote("");
    setEditingTranslation("");
    setEditingPhonetic("");
    setEditingPartOfSpeech("");
    setEditingDefinition("");
  };

  const openForEdit = (item: VocabularyItem) => {
    setSelectedItemId(item.id);
    setDrawerMode("edit");
    beginEdit(item);
  };

  const handleUpdate = () => {
    if (!selectedItemId) return;
    setError(null);
    updateMutation.mutate(
      {
        id: selectedItemId,
        term: editingTerm,
        sentenceContext: editingSentenceContext,
        note: editingNote,
        translation: editingTranslation,
        phonetic: editingPhonetic,
        partOfSpeech: editingPartOfSpeech,
        definition: editingDefinition,
      },
      {
        onSuccess: () => setDrawerMode("view"),
        onError: (err) => {
          const message = err instanceof Error && err.message ? err.message : "Failed to update vocabulary item.";
          setError(message);
        },
      }
    );
  };

  const filteredItems = useMemo(() => {
    const query = searchInput.trim().toLowerCase();
    return items.filter((item) => {
      if (typeFilter !== "all") {
        const kind = inferVocabularyItemKind(item);
        const kindForFilter = kind === "sentence" ? "phrase" : kind;
        if (kindForFilter !== typeFilter) return false;
      }
      if (statusFilter !== "all" && getVocabularyLearningStatus(item) !== statusFilter) return false;
      if (!query) return true;
      return (
        item.term.toLowerCase().includes(query) ||
        item.sentence_context.toLowerCase().includes(query) ||
        (item.note ?? "").toLowerCase().includes(query) ||
        (item.translation ?? "").toLowerCase().includes(query) ||
        (item.definition ?? "").toLowerCase().includes(query)
      );
    });
  }, [items, searchInput, typeFilter, statusFilter]);

  const isFiltering = searchInput.trim() !== "" || typeFilter !== "all" || statusFilter !== "all";

  const clearFilters = () => {
    setSearchInput("");
    setTypeFilter("all");
    setStatusFilter("all");
  };

  // A real fetch (not a cache hit) is in flight AND there is no data yet —
  // the *only* case allowed to show a loading state. `itemsQuery.isFetching`
  // alone must never gate rendering here: it's also true for background
  // refetches (window refocus, invalidation) that should leave whatever is
  // already on screen untouched.
  const isTrueFirstLoad = itemsQuery.data === undefined && itemsQuery.isFetching;

  return (
    <div className="relative flex h-dvh w-full flex-col overflow-hidden bg-[#f4f7ff] font-sans text-slate-900 antialiased">
      <div className="pointer-events-none absolute -left-[10%] -top-[10%] z-0 h-[40%] w-[40%] rounded-full bg-purple-200 opacity-60 blur-[120px]" />
      <div className="pointer-events-none absolute bottom-[10%] right-[0%] z-0 h-[40%] w-[40%] rounded-full bg-blue-200 opacity-60 blur-[120px]" />

      <div className="relative z-10 flex min-h-0 flex-1 flex-col">
        <div className="shrink-0">
          <AppHeader active="vocabulary" />
        </div>

        <main
          className={clsx(
            "mx-auto flex w-full min-h-0 flex-1 flex-col gap-6 py-6",
            PAGE_WIDTH_CLASS.wide,
            PAGE_PADDING_CLASS.wide
          )}
        >
        {loading ? null : !user ? (
          <section className="rounded-3xl border border-white/60 bg-white/40 p-8 shadow-xl backdrop-blur-xl">
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Vocabulary Bank</h1>
            <p className="mt-2 text-sm text-slate-500">Sign in to review and edit saved vocabulary items.</p>
            <button
              onClick={openAuthModal}
              className="mt-4 rounded-xl bg-primary-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary-700"
            >
              Sign in
            </button>
          </section>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-6">
            {/* Non-scrolling toolbar: title/actions, stats, search/filter,
                and the result count all stay fixed in the viewport — only
                the list below scrolls. */}
            <div className="flex shrink-0 flex-col gap-6">
              <section className="flex flex-col items-start justify-between gap-6 md:flex-row md:items-end">
                <div>
                  <h1 className="mb-1 text-2xl font-semibold tracking-tight text-slate-900">Vocabulary Bank</h1>
                  <p className="text-sm text-slate-500">Review and master the words you&apos;ve learned.</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Link
                      href="/vocabulary/review"
                      className="inline-block rounded-xl bg-primary-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary-700"
                    >
                      Start review session{reviewableCount !== undefined ? ` (${reviewableCount})` : ""}
                    </Link>
                    <a
                      href="/api/vocabulary/export"
                      download
                      className="inline-flex items-center gap-1.5 rounded-xl border border-white/80 bg-white/60 px-4 py-2 text-sm font-semibold text-slate-600 shadow-sm backdrop-blur-xl transition-colors hover:text-primary-600"
                    >
                      <Download size={16} />
                      Export to Anki (CSV)
                    </a>
                  </div>
                </div>
                <div className="flex w-full flex-wrap gap-3 md:w-auto">
                  <VocabularyStatChip
                    icon={<BookOpen className="text-primary-500" size={20} />}
                    label="Total Words"
                    value={stats?.total}
                  />
                  <VocabularyStatChip
                    icon={<Sparkles className="text-slate-500" size={20} />}
                    label="New"
                    value={stats?.new}
                  />
                  <VocabularyStatChip
                    icon={<Clock className="text-indigo-500" size={20} />}
                    label="Learning"
                    value={stats?.learning}
                  />
                  <VocabularyStatChip
                    icon={<AlertCircle className="text-amber-500" size={20} />}
                    label="Due"
                    value={stats?.due}
                  />
                </div>
              </section>

              <section className="flex flex-col gap-3">
                <div className="flex gap-3">
                  <div className="relative flex-1 overflow-hidden rounded-2xl border border-white/60 bg-white/40 shadow-sm backdrop-blur-xl transition-all focus-within:ring-2 focus-within:ring-primary-500/30">
                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                    <input
                      type="text"
                      placeholder="Search words, notes, or sentences..."
                      value={searchInput}
                      onChange={(e) => setSearchInput(e.target.value)}
                      className="w-full bg-transparent py-3 pl-11 pr-4 font-medium text-slate-800 outline-none placeholder:text-slate-400"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => setFiltersOpen((v) => !v)}
                    aria-pressed={filtersOpen}
                    className={clsx(
                      "flex items-center gap-2 rounded-2xl border px-4 font-semibold shadow-md backdrop-blur-xl transition-colors active:translate-y-px",
                      filtersOpen
                        ? "border-primary-200 bg-primary-50 text-primary-600"
                        : "border-white/80 bg-white/60 text-slate-600 hover:text-primary-600"
                    )}
                  >
                    <Filter size={18} />
                    <span className="hidden sm:inline">Filter</span>
                  </button>
                </div>

                {filtersOpen && (
                  <div className="flex flex-wrap items-center gap-4 rounded-2xl border border-white/60 bg-white/40 p-3 shadow-sm backdrop-blur-xl">
                    <FilterPillGroup
                      label="Type"
                      options={TYPE_FILTER_OPTIONS}
                      value={typeFilter}
                      onChange={setTypeFilter}
                    />
                    <FilterPillGroup
                      label="Status"
                      options={STATUS_FILTER_OPTIONS}
                      value={statusFilter}
                      onChange={setStatusFilter}
                    />
                    {isFiltering && (
                      <button
                        type="button"
                        onClick={clearFilters}
                        className="ml-auto flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-primary-600"
                      >
                        <X size={14} />
                        Clear filters
                      </button>
                    )}
                  </div>
                )}
              </section>

              {error ? <p className="text-sm text-red-600">{error}</p> : null}

              {itemsQuery.isError && items.length > 0 && (
                <p className="flex items-center gap-2 text-xs text-amber-600">
                  Couldn&apos;t refresh your vocabulary — showing the last loaded list.
                  <button
                    type="button"
                    onClick={() => itemsQuery.refetch()}
                    className="font-semibold underline hover:text-amber-700"
                  >
                    Retry
                  </button>
                </p>
              )}

              {isFiltering && items.length > 0 && (
                <p className="text-xs font-medium text-slate-500">
                  {filteredItems.length} of {items.length} words
                </p>
              )}
            </div>

            {/* Outer workspace: sizing + a positioning anchor for the detail
                drawer, and (at xl+, only when an item is selected) a real
                2-column split that docks the inspector instead of floating
                it. Not itself scrollable — the inner div below is the
                actual (unchanged) scroll container, so the drawer, whether
                floating (below xl) or docked (xl+, a normal grid cell), is
                excluded from the inner div's scrollable-overflow entirely:
                it can't add a second scrollbar and stays anchored to the
                cards-viewport regardless of list scroll position.
                `grid-rows-[minmax(0,1fr)]` is required, not decorative: a
                bare `auto` row would size to its (near-zero, since both
                children are overflow-y-auto scroll containers) children's
                automatic minimum instead of actually filling the available
                height, which would starve both scroll regions of a real
                height to scroll within. */}
            <div
              data-testid="vocabulary-workspace"
              className={clsx(
                "relative grid min-h-0 flex-1 gap-6 grid-rows-[minmax(0,1fr)]",
                selectedItem && "xl:grid-cols-[minmax(0,1fr)_420px]"
              )}
            >
            {/* Only this region scrolls. */}
            <div className="h-full min-h-0 overflow-y-auto overscroll-contain">
              {isTrueFirstLoad ? (
                <p className="text-sm text-slate-500">Loading vocabulary…</p>
              ) : itemsQuery.isError && items.length === 0 ? (
                <section className="flex items-center justify-between gap-3 rounded-3xl border border-white/60 bg-white/40 p-6 text-sm text-red-600 shadow-xl backdrop-blur-xl">
                  <span>Failed to load vocabulary.</span>
                  <button
                    type="button"
                    onClick={() => itemsQuery.refetch()}
                    className="shrink-0 font-semibold underline hover:text-red-700"
                  >
                    Retry
                  </button>
                </section>
              ) : items.length === 0 ? (
                <section className="rounded-3xl border border-white/60 bg-white/40 p-6 text-sm text-slate-500 shadow-xl backdrop-blur-xl">
                  No saved vocabulary yet.
                </section>
              ) : filteredItems.length === 0 ? (
                <section className="flex flex-col items-start gap-2 rounded-3xl border border-white/60 bg-white/40 p-6 text-sm text-slate-500 shadow-xl backdrop-blur-xl">
                  No results match your search or filters.
                  <button
                    type="button"
                    onClick={clearFilters}
                    className="font-semibold text-primary-600 underline hover:text-primary-700"
                  >
                    Clear filters
                  </button>
                </section>
              ) : (
                <section className="grid items-start gap-6 pb-12 grid-cols-[repeat(auto-fill,minmax(280px,1fr))]">
                  {filteredItems.map((item, idx) => {
                    const isDeleting = deleteMutation.isPending && deleteMutation.variables === item.id;
                    const isUpdating = updateMutation.isPending && updateMutation.variables?.id === item.id;

                    return (
                      <VocabularyCard
                        key={item.id}
                        item={item}
                        index={idx}
                        isSelected={selectedItemId === item.id}
                        isDeleting={isDeleting}
                        isUpdating={isUpdating}
                        onSelect={handleSelect}
                        onEdit={openForEdit}
                        onDelete={handleDelete}
                      />
                    );
                  })}
                </section>
              )}
            </div>
              <VocabularyDetailDrawer
                item={selectedItem}
                mode={drawerMode}
                onClose={handleCloseDrawer}
                onEdit={() => selectedItem && openForEdit(selectedItem)}
                onDelete={handleDelete}
                isDeleting={deleteMutation.isPending && deleteMutation.variables === selectedItemId}
                isSaving={updateMutation.isPending}
                term={editingTerm}
                onTermChange={setEditingTerm}
                sentenceContext={editingSentenceContext}
                onSentenceContextChange={setEditingSentenceContext}
                translation={editingTranslation}
                onTranslationChange={setEditingTranslation}
                phonetic={editingPhonetic}
                onPhoneticChange={setEditingPhonetic}
                partOfSpeech={editingPartOfSpeech}
                onPartOfSpeechChange={setEditingPartOfSpeech}
                definition={editingDefinition}
                onDefinitionChange={setEditingDefinition}
                note={editingNote}
                onNoteChange={setEditingNote}
                onSave={handleUpdate}
                onCancelEdit={cancelEdit}
              />
            </div>
          </div>
        )}
        </main>
      </div>
    </div>
  );
}
