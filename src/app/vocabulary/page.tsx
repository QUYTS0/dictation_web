"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
  Trash2,
  X,
} from "lucide-react";
import AppHeader from "@/components/AppHeader";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { VocabularyCard } from "./components/VocabularyCard";
import { VocabularyDetailDrawer } from "./components/VocabularyDetailDrawer";
import { useAuth } from "@/context/auth";
import { PAGE_PADDING_CLASS, PAGE_WIDTH_CLASS } from "@/lib/layout/pageWidth";
import {
  useVocabularyItemsQuery,
  useVocabularyStatsQuery,
  useUpdateVocabularyItemMutation,
  useDeleteVocabularyItemMutation,
  useBulkDeleteVocabularyItemsMutation,
} from "@/lib/queries/vocabulary";
import {
  getVocabularyLearningStatus,
  inferVocabularyItemKind,
  MAX_BULK_SELECTABLE_ITEMS,
  type VocabularyLearningStatus,
} from "@/lib/utils/vocabulary";
import type { VocabularyItem, VocabularyStatsResponse } from "@/lib/types";

type TypeFilterValue = "all" | "word" | "phrase";
type StatusFilterValue = "all" | VocabularyLearningStatus;

const TYPE_FILTER_OPTIONS: Array<{ value: TypeFilterValue; label: string }> = [
  { value: "all", label: "All" },
  { value: "word", label: "Words" },
  { value: "phrase", label: "Phrases" },
];

type PendingDeleteConfirmation = { kind: "single"; id: string } | { kind: "bulk"; ids: string[] };

/** Precedence checked top-to-bottom by the caller: loading first (never a
 *  flash of "0 due"), then empty library, then all-caught-up, then
 *  new-only, then due. `reviewable`/`due`/`new` can never make "due===0 &&
 *  new===0" true while reviewable>0 (due and new are exactly the two
 *  disjoint buckets `reviewable` is drawn from, see
 *  isVocabularyItemReviewable's own comment), so this is exhaustive. Copy
 *  deliberately makes no claim about review *ordering* — the backend does
 *  not yet guarantee Due-before-New (see GET /api/vocabulary/review). */
type HeroState =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "caughtUp" }
  | { kind: "newOnly" }
  | { kind: "due"; due: number };

function deriveHeroState(stats: VocabularyStatsResponse | undefined, isFirstLoad: boolean): HeroState {
  if (isFirstLoad || !stats) return { kind: "loading" };
  if (stats.total === 0) return { kind: "empty" };
  if (stats.reviewable === 0) return { kind: "caughtUp" };
  if (stats.due === 0 && stats.new > 0) return { kind: "newOnly" };
  return { kind: "due", due: stats.due };
}

function VocabularyMetricButton({
  icon,
  label,
  value,
  isActive,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | undefined;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={isActive}
      data-testid={`vocab-stat-${label.toLowerCase().replace(/\s+/g, "-")}`}
      className={clsx(
        "flex flex-1 items-center gap-3 rounded-2xl border p-3 px-5 shadow-sm backdrop-blur-md transition-colors md:flex-initial",
        isActive
          ? "border-primary-600 bg-primary-600 text-white"
          : "border-white/60 bg-white/50 text-slate-800 hover:bg-white/80"
      )}
    >
      {icon}
      <div className="text-left">
        <p
          className={clsx(
            "text-[10px] font-bold uppercase tracking-wide",
            isActive ? "text-white/80" : "text-slate-500"
          )}
        >
          {label}
        </p>
        <p className="text-lg font-black leading-none">{value ?? "—"}</p>
      </div>
    </button>
  );
}

function VocabularyBulkBar({
  count,
  onClear,
  onDelete,
}: {
  count: number;
  onClear: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      data-testid="vocab-bulk-bar"
      className="flex w-full flex-1 flex-wrap items-center justify-between gap-3 rounded-2xl border border-primary-200 bg-primary-50 px-5 py-3 shadow-sm"
    >
      <p className="text-sm font-semibold text-primary-700">
        {count} selected{count >= MAX_BULK_SELECTABLE_ITEMS ? ` (max ${MAX_BULK_SELECTABLE_ITEMS})` : ""}
      </p>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onClear}
          className="text-sm font-semibold text-slate-500 hover:text-slate-700"
        >
          Clear selection
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="flex items-center gap-1.5 rounded-xl bg-red-600 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-700"
        >
          <Trash2 size={14} />
          Delete
        </button>
      </div>
    </div>
  );
}

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
  const bulkDeleteMutation = useBulkDeleteVocabularyItemsMutation(userId);

  const items = useMemo(() => itemsQuery.data ?? [], [itemsQuery.data]);
  const stats = statsQuery.data;

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

  // Multi-select: id-only, never a copy of the Vocabulary objects
  // themselves — mirrors selectedItemId's own convention. Independent of
  // selectedItemId (which item is open in the inspector) by design; see the
  // Vocabulary UX redesign plan §G for the full transition table.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const atSelectionCap = selectedIds.size >= MAX_BULK_SELECTABLE_ITEMS;

  // Which delete is awaiting confirmation, if any — owned here (not inside
  // the drawer) so a single shared <ConfirmDialog> instance can serve both
  // the drawer's single-delete button and the bulk bar's Delete button,
  // and so the drawer can be told to suspend its own Escape/Tab handling
  // regardless of which one triggered the dialog. See plan §I.
  const [pendingDeleteConfirmation, setPendingDeleteConfirmation] = useState<PendingDeleteConfirmation | null>(
    null
  );

  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Search text and filters are intentionally plain, unpersisted component
  // state: every mount (including a bare nav-tab return) starts from
  // Search empty / Type All / Status All / scroll 0. Nothing here reads or
  // writes sessionStorage or the URL — see the Bookmarks/History pages for
  // the (unrelated, still-persisted) usePersistedViewState pattern this
  // page deliberately no longer uses.
  const [searchInput, setSearchInput] = useState("");
  const [typeFilter, setTypeFilter] = useState<TypeFilterValue>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilterValue>("all");

  // Changing what's visible must never leave a stale, now-invisible
  // selection around to be silently bulk-deleted — see plan §17/§G. Cleared
  // imperatively at each of the four call sites that change search/type/
  // status (below), not via a useEffect keyed on their values: setState
  // inside an effect body just to derive one piece of state from another is
  // the exact cascading-render anti-pattern this codebase's lint config
  // (react-hooks/set-state-in-effect) flags — an event-handler-time update
  // is both simpler and avoids the extra render.
  const clearSelectionIfAny = () => {
    setSelectedIds((prev) => (prev.size === 0 ? prev : new Set()));
  };

  const handleSearchInputChange = (value: string) => {
    setSearchInput(value);
    clearSelectionIfAny();
  };

  const handleTypeFilterChange = (value: TypeFilterValue) => {
    setTypeFilter(value);
    clearSelectionIfAny();
  };

  const handleStatusFilterChange = (value: StatusFilterValue) => {
    setStatusFilter(value);
    clearSelectionIfAny();
  };

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  const selectedItem = useMemo(
    () => items.find((i) => i.id === selectedItemId) ?? null,
    [items, selectedItemId]
  );

  const handleSelect = (id: string) => {
    setSelectedItemId(id);
    setDrawerMode("view");
  };

  const handleToggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        if (next.size >= MAX_BULK_SELECTABLE_ITEMS) return prev;
        next.add(id);
      }
      return next;
    });
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
        setSelectedIds((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        setPendingDeleteConfirmation(null);
      },
      onError: (err) => {
        const message = err instanceof Error && err.message ? err.message : "Failed to delete vocabulary item.";
        setError(message);
        setPendingDeleteConfirmation(null);
      },
    });
  };

  const handleBulkDelete = (ids: string[]) => {
    setError(null);
    bulkDeleteMutation.mutate(ids, {
      onSuccess: (deletedIds) => {
        const deleted = new Set(deletedIds);
        if (selectedItemId && deleted.has(selectedItemId)) {
          setSelectedItemId(null);
          setDrawerMode("view");
        }
        setSelectedIds(new Set());
        setPendingDeleteConfirmation(null);
      },
      onError: (err) => {
        const message =
          err instanceof Error && err.message ? err.message : "Failed to delete vocabulary items.";
        setError(message);
        setPendingDeleteConfirmation(null);
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
  // Counts active *dimensions* (Type, Status), not selected values within a
  // dimension — shown on the collapsed Filter button so filtering-by-Status
  // (surfaced via the metric strip, not this panel) still registers here.
  const activeFilterDimensions = (typeFilter !== "all" ? 1 : 0) + (statusFilter !== "all" ? 1 : 0);
  const hasActiveSearch = searchInput.trim() !== "";

  const clearFilters = () => {
    setSearchInput("");
    setTypeFilter("all");
    setStatusFilter("all");
    clearSelectionIfAny();
  };

  // Collapsing is a pure visibility toggle — the query is intentionally
  // preserved (and selectedIds left untouched) so the user never loses a
  // search just by closing the panel. Escape while the input is focused
  // goes through this same function. Explicit clearing is a separate,
  // deliberate action — see clearSearch below.
  const closeSearch = () => {
    setSearchOpen(false);
  };

  const clearSearch = () => {
    setSearchInput("");
    clearSelectionIfAny();
    searchInputRef.current?.focus();
  };

  // A real fetch (not a cache hit) is in flight AND there is no data yet —
  // the *only* case allowed to show a loading state. `itemsQuery.isFetching`
  // alone must never gate rendering here: it's also true for background
  // refetches (window refocus, invalidation) that should leave whatever is
  // already on screen untouched.
  const isTrueFirstLoad = itemsQuery.data === undefined && itemsQuery.isFetching;
  const isStatsFirstLoad = statsQuery.data === undefined && statsQuery.isFetching;
  const heroState = deriveHeroState(stats, isStatsFirstLoad);

  const modalSuspended = pendingDeleteConfirmation !== null;

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
            {/* Non-scrolling toolbar: hero, command strip, search/filter,
                and the result count all stay fixed in the viewport — only
                the list below scrolls. The user already knows they're in
                Vocabulary via the active AppHeader nav tab, so the page's
                own heading is semantic-only (screen readers/document
                structure), not a second visible label. */}
            <div className="flex shrink-0 flex-col gap-6">
              <h1 className="sr-only">Vocabulary</h1>

              <section className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
                <div>
                  {heroState.kind === "loading" ? (
                    <div data-testid="vocab-hero-loading">
                      <div className="h-7 w-56 animate-pulse rounded-lg bg-slate-200/80" />
                      <div className="mt-2 h-4 w-72 animate-pulse rounded-lg bg-slate-200/60" />
                    </div>
                  ) : (
                    <>
                      <p className="text-xl font-bold tracking-tight text-slate-900">
                        {heroState.kind === "empty" && "Save your first word"}
                        {heroState.kind === "caughtUp" && "You're all caught up"}
                        {heroState.kind === "newOnly" && "Ready to learn something new"}
                        {heroState.kind === "due" &&
                          `${heroState.due} word${heroState.due === 1 ? "" : "s"} are due`}
                      </p>
                      <p className="text-sm text-slate-500">
                        {heroState.kind === "empty" &&
                          "Words you save during a listening session will appear here."}
                        {heroState.kind === "caughtUp" && "Nothing needs review right now."}
                        {heroState.kind === "newOnly" &&
                          "New vocabulary is ready to be introduced in your next review."}
                        {heroState.kind === "due" && "Review to keep them fresh in memory."}
                      </p>
                    </>
                  )}
                </div>
                <div className="flex w-full flex-wrap gap-2 sm:w-auto">
                  {heroState.kind === "empty" && (
                    <Link
                      href="/"
                      className="inline-block rounded-xl bg-primary-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary-700"
                    >
                      Start a dictation session
                    </Link>
                  )}
                  {(heroState.kind === "newOnly" || heroState.kind === "due") && (
                    <Link
                      href="/vocabulary/review"
                      className="inline-block rounded-xl bg-primary-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary-700"
                    >
                      Start review
                    </Link>
                  )}
                  <a
                    href="/api/vocabulary/export"
                    download
                    className="inline-flex items-center gap-1.5 rounded-xl border border-white/80 bg-white/60 px-4 py-2 text-sm font-semibold text-slate-600 shadow-sm backdrop-blur-xl transition-colors hover:text-primary-600"
                  >
                    <Download size={16} />
                    Export
                  </a>
                </div>
              </section>

              <section className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-3">
                  {selectedIds.size > 0 ? (
                    <VocabularyBulkBar
                      count={selectedIds.size}
                      onClear={() => setSelectedIds(new Set())}
                      onDelete={() =>
                        setPendingDeleteConfirmation({ kind: "bulk", ids: Array.from(selectedIds) })
                      }
                    />
                  ) : (
                    <>
                      <div className="flex w-full flex-wrap gap-3 md:w-auto md:flex-1">
                        <VocabularyMetricButton
                          icon={<BookOpen className={statusFilter === "all" ? "text-white" : "text-primary-500"} size={20} />}
                          label="Total Words"
                          value={stats?.total}
                          isActive={statusFilter === "all"}
                          onClick={() => handleStatusFilterChange("all")}
                        />
                        <VocabularyMetricButton
                          icon={<Sparkles className={statusFilter === "new" ? "text-white" : "text-slate-500"} size={20} />}
                          label="New"
                          value={stats?.new}
                          isActive={statusFilter === "new"}
                          onClick={() => handleStatusFilterChange("new")}
                        />
                        <VocabularyMetricButton
                          icon={<Clock className={statusFilter === "learning" ? "text-white" : "text-indigo-500"} size={20} />}
                          label="Learning"
                          value={stats?.learning}
                          isActive={statusFilter === "learning"}
                          onClick={() => handleStatusFilterChange("learning")}
                        />
                        <VocabularyMetricButton
                          icon={<AlertCircle className={statusFilter === "due" ? "text-white" : "text-amber-500"} size={20} />}
                          label="Due"
                          value={stats?.due}
                          isActive={statusFilter === "due"}
                          onClick={() => handleStatusFilterChange("due")}
                        />
                      </div>
                      <div className="flex items-center gap-2">
                        {searchOpen ? (
                          <button
                            type="button"
                            onClick={closeSearch}
                            aria-label="Close search"
                            className="flex items-center gap-2 rounded-2xl border border-primary-200 bg-primary-50 px-4 py-3 font-semibold text-primary-600 shadow-md backdrop-blur-xl transition-colors"
                          >
                            <X size={18} />
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setSearchOpen(true)}
                            aria-label={hasActiveSearch ? "Search (active)" : "Search"}
                            className={clsx(
                              "relative flex items-center gap-2 rounded-2xl border px-4 py-3 font-semibold shadow-md backdrop-blur-xl transition-colors",
                              hasActiveSearch
                                ? "border-primary-200 bg-primary-50 text-primary-600"
                                : "border-white/80 bg-white/60 text-slate-600 hover:text-primary-600"
                            )}
                          >
                            <Search size={18} />
                            {hasActiveSearch && (
                              <span
                                aria-hidden="true"
                                data-testid="search-active-indicator"
                                className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-primary-600"
                              />
                            )}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setFiltersOpen((v) => !v)}
                          aria-pressed={filtersOpen}
                          className={clsx(
                            "flex items-center gap-2 rounded-2xl border px-4 py-3 font-semibold shadow-md backdrop-blur-xl transition-colors active:translate-y-px",
                            filtersOpen
                              ? "border-primary-200 bg-primary-50 text-primary-600"
                              : "border-white/80 bg-white/60 text-slate-600 hover:text-primary-600"
                          )}
                        >
                          <Filter size={18} />
                          <span className="hidden sm:inline">
                            Filter{activeFilterDimensions > 0 ? ` (${activeFilterDimensions})` : ""}
                          </span>
                        </button>
                      </div>
                    </>
                  )}
                </div>

                {searchOpen && (
                  <div className="relative overflow-hidden rounded-2xl border border-white/60 bg-white/40 shadow-sm backdrop-blur-xl transition-all focus-within:ring-2 focus-within:ring-primary-500/30">
                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                    <input
                      ref={searchInputRef}
                      type="text"
                      placeholder="Search words, notes, or sentences..."
                      value={searchInput}
                      onChange={(e) => handleSearchInputChange(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") closeSearch();
                      }}
                      className="w-full bg-transparent py-3 pl-11 pr-10 font-medium text-slate-800 outline-none placeholder:text-slate-400"
                    />
                    {searchInput && (
                      <button
                        type="button"
                        onClick={clearSearch}
                        aria-label="Clear search"
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 transition-colors hover:text-slate-600"
                      >
                        <X size={16} />
                      </button>
                    )}
                  </div>
                )}

                {filtersOpen && (
                  <div className="flex flex-wrap items-center gap-4 rounded-2xl border border-white/60 bg-white/40 p-3 shadow-sm backdrop-blur-xl">
                    <FilterPillGroup
                      label="Type"
                      options={TYPE_FILTER_OPTIONS}
                      value={typeFilter}
                      onChange={handleTypeFilterChange}
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
            {/* Only this region scrolls. A small inner padded wrapper sits
                between the scroll viewport and the grid so ring/shadow
                effects on edge-column cards (which paint outside the
                card's own border box) have room to render before hitting
                this viewport's clip edge — without it, `overflow-y-auto`
                here computes an effective `overflow-x: auto` too (per the
                CSS Overflow spec, since only one axis is set explicitly),
                and with zero padding that clip box sits flush against the
                grid, hard-cropping shadow-xl/ring-2 on the first/last
                column. `scrollbar-gutter: stable` avoids the auto-fill
                grid's column count flipping when a scrollbar appears. */}
            <div
              className="app-scrollbar h-full min-h-0 overflow-y-auto overscroll-contain"
              style={{ scrollbarGutter: "stable" }}
            >
              <div className="p-1.5">
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
                        isChecked={selectedIds.has(item.id)}
                        atSelectionCap={atSelectionCap}
                        isDeleting={isDeleting}
                        isUpdating={isUpdating}
                        onSelect={handleSelect}
                        onToggleSelect={handleToggleSelect}
                      />
                    );
                  })}
                </section>
              )}
              </div>
            </div>
              <VocabularyDetailDrawer
                item={selectedItem}
                mode={drawerMode}
                onClose={handleCloseDrawer}
                onEdit={() => selectedItem && openForEdit(selectedItem)}
                onRequestDelete={() =>
                  selectedItem && setPendingDeleteConfirmation({ kind: "single", id: selectedItem.id })
                }
                modalSuspended={modalSuspended}
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

      {pendingDeleteConfirmation && pendingDeleteConfirmation.kind === "single" && (
        <ConfirmDialog
          title={`Delete "${items.find((i) => i.id === pendingDeleteConfirmation.id)?.term ?? "this item"}"?`}
          body="This action cannot be undone."
          confirmLabel="Delete"
          isConfirming={deleteMutation.isPending}
          onCancel={() => setPendingDeleteConfirmation(null)}
          onConfirm={() => handleDelete(pendingDeleteConfirmation.id)}
        />
      )}
      {pendingDeleteConfirmation && pendingDeleteConfirmation.kind === "bulk" && (
        <ConfirmDialog
          title={`Delete ${pendingDeleteConfirmation.ids.length} vocabulary item${
            pendingDeleteConfirmation.ids.length === 1 ? "" : "s"
          }?`}
          body="This action cannot be undone."
          confirmLabel={`Delete ${pendingDeleteConfirmation.ids.length} item${
            pendingDeleteConfirmation.ids.length === 1 ? "" : "s"
          }`}
          isConfirming={bulkDeleteMutation.isPending}
          onCancel={() => setPendingDeleteConfirmation(null)}
          onConfirm={() => handleBulkDelete(pendingDeleteConfirmation.ids)}
        />
      )}
    </div>
  );
}
