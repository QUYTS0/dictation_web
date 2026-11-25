"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { clsx } from "clsx";
import { MapPin, Search, Trash2 } from "lucide-react";
import { motion } from "motion/react";
import AppHeader from "@/components/AppHeader";
import AppFooter from "@/components/AppFooter";
import { useAuth } from "@/context/auth";
import { usePersistedViewState } from "@/hooks/usePersistedViewState";
import { useScrollRestoration } from "@/hooks/useScrollRestoration";
import { PAGE_PADDING_CLASS, PAGE_WIDTH_CLASS } from "@/lib/layout/pageWidth";
import {
  useBookmarksQuery,
  useDeleteBookmarkMutation,
  useUpdateBookmarkNoteMutation,
  type BookmarkWithVideo,
} from "@/lib/queries/bookmarks";

/** usePersistedViewState reads useSearchParams(), which opts this
 *  otherwise-static route into needing a Suspense boundary at build time —
 *  see the default export below. */
function BookmarksPageContent() {
  const { user, loading, openAuthModal } = useAuth();
  const userId = user?.id;
  const pathname = usePathname();

  const itemsQuery = useBookmarksQuery(userId);
  const deleteMutation = useDeleteBookmarkMutation(userId);
  const updateNoteMutation = useUpdateBookmarkNoteMutation(userId);

  const items = useMemo(() => itemsQuery.data ?? [], [itemsQuery.data]);

  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingNote, setEditingNote] = useState("");

  const [viewState, updateViewState, viewStateHydrated] = usePersistedViewState("bookmarks-viewstate", userId, {
    q: "",
  });
  const [searchInput, setSearchInput] = useState(viewState.q);
  useEffect(() => {
    setSearchInput(viewState.q);
  }, [viewState.q]);
  useEffect(() => {
    const handle = setTimeout(() => {
      if (searchInput !== viewState.q) updateViewState({ q: searchInput });
    }, 300);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  // See the Vocabulary page for why both conditions are needed: hydration
  // resolves type/status-like filters in one render, but this page's own
  // searchInput echo lags one more render behind a sessionStorage-restored
  // viewState.q.
  const viewStateApplied = viewStateHydrated && searchInput === viewState.q;
  useScrollRestoration(pathname, userId, viewStateApplied && !itemsQuery.isLoading);

  const handleDelete = (id: string) => {
    setError(null);
    deleteMutation.mutate(id, {
      onError: (err) => {
        const message = err instanceof Error && err.message ? err.message : "Failed to delete bookmark.";
        setError(message);
      },
    });
  };

  const beginEdit = (item: BookmarkWithVideo) => {
    setEditingId(item.id);
    setEditingNote(item.note ?? "");
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditingNote("");
  };

  const handleUpdateNote = () => {
    if (!editingId) return;
    setError(null);
    updateNoteMutation.mutate(
      { id: editingId, note: editingNote },
      {
        onSuccess: () => cancelEdit(),
        onError: (err) => {
          const message = err instanceof Error && err.message ? err.message : "Failed to update bookmark.";
          setError(message);
        },
      }
    );
  };

  const filteredItems = useMemo(() => {
    const query = searchInput.trim().toLowerCase();
    if (!query) return items;
    return items.filter(
      (item) =>
        item.sentence_text.toLowerCase().includes(query) ||
        (item.note ?? "").toLowerCase().includes(query) ||
        (item.videoTitle ?? "").toLowerCase().includes(query)
    );
  }, [items, searchInput]);

  const isFiltering = searchInput.trim() !== "";

  return (
    <div className="relative flex min-h-screen w-full flex-1 flex-col overflow-hidden bg-page font-sans text-ink antialiased">

      <div className="relative z-10 flex flex-1 flex-col">
        <AppHeader active="bookmarks" />

        <main
          className={clsx(
            "mx-auto flex w-full flex-1 flex-col gap-8 py-8",
            PAGE_WIDTH_CLASS.wide,
            PAGE_PADDING_CLASS.wide
          )}
        >
          {loading ? null : !user ? (
            <section className="rounded-2xl border border-line bg-white p-8 shadow-xs">
              <h1 className="text-2xl font-semibold tracking-tight text-ink">Bookmarks</h1>
              <p className="mt-2 text-sm text-muted">Sign in to review the sentences you&apos;ve bookmarked.</p>
              <button
                onClick={openAuthModal}
                className="mt-4 rounded-xl bg-primary-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary-700"
              >
                Sign in
              </button>
            </section>
          ) : (
            <>
              <section className="flex flex-col items-start justify-between gap-6 md:flex-row md:items-end">
                <div>
                  <h1 className="mb-1 text-2xl font-semibold tracking-tight text-ink">Bookmarks</h1>
                  <p className="text-sm text-muted">Jump back to sentences you&apos;ve marked across every video.</p>
                </div>
                <div className="flex items-center gap-3 rounded-2xl border border-line bg-white p-3 px-5 shadow-sm">
                  <MapPin className="text-primary-500" size={20} />
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-wide text-muted">Total Bookmarks</p>
                    <p className="text-lg font-black leading-none text-ink">{items.length}</p>
                  </div>
                </div>
              </section>

              <section className="flex gap-3">
                <div className="relative flex-1 overflow-hidden rounded-2xl border border-line bg-white shadow-sm transition-all focus-within:ring-2 focus-within:ring-primary-500/30">
                  <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-muted" size={18} />
                  <input
                    type="text"
                    placeholder="Search bookmarked sentences or notes..."
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                    className="w-full bg-transparent py-3 pl-11 pr-4 font-medium text-ink outline-none placeholder:text-muted"
                  />
                </div>
              </section>

              {error ? <p className="text-sm text-red-600">{error}</p> : null}

              {itemsQuery.isLoading ? (
                <p className="text-sm text-muted">Loading bookmarks…</p>
              ) : itemsQuery.isError && items.length === 0 ? (
                <section className="flex items-center justify-between gap-3 rounded-2xl border border-line bg-white p-6 text-sm text-red-600 shadow-xs">
                  <span>Failed to load bookmarks.</span>
                  <button
                    type="button"
                    onClick={() => itemsQuery.refetch()}
                    className="shrink-0 font-semibold underline hover:text-red-700"
                  >
                    Retry
                  </button>
                </section>
              ) : items.length === 0 ? (
                <section className="rounded-2xl border border-line bg-white p-6 text-sm text-muted shadow-xs">
                  No bookmarks yet.
                </section>
              ) : (
                <>
                  {itemsQuery.isError && (
                    <p className="flex items-center gap-2 text-xs text-amber-600">
                      Couldn&apos;t refresh your bookmarks — showing the last loaded list.
                      <button
                        type="button"
                        onClick={() => itemsQuery.refetch()}
                        className="font-semibold underline hover:text-amber-700"
                      >
                        Retry
                      </button>
                    </p>
                  )}
                  {isFiltering && (
                    <p className="text-xs font-medium text-muted">
                      {filteredItems.length} of {items.length} bookmarks
                    </p>
                  )}
                  {filteredItems.length === 0 ? (
                    <section className="flex flex-col items-start gap-2 rounded-2xl border border-line bg-white p-6 text-sm text-muted shadow-xs">
                      No results match your search.
                      <button
                        type="button"
                        onClick={() => setSearchInput("")}
                        className="font-semibold text-primary-600 underline hover:text-primary-700"
                      >
                        Clear search
                      </button>
                    </section>
                  ) : (
                    <section className="grid gap-6 pb-12 grid-cols-[repeat(auto-fill,minmax(300px,1fr))]">
                      {filteredItems.map((item, idx) => {
                        const isDeleting = deleteMutation.isPending && deleteMutation.variables === item.id;
                        const isSavingNote = updateNoteMutation.isPending && editingId === item.id;

                        return (
                          <motion.div
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: idx * 0.05 }}
                            key={item.id}
                            className="group flex h-full w-full max-w-[400px] flex-col rounded-2xl border border-line bg-white p-6 shadow-xs transition-all hover:-translate-y-1"
                          >
                            <div className="mb-3 flex items-start justify-between gap-2">
                              <div>
                                <h3 className="text-sm font-bold text-ink transition-colors group-hover:text-primary-600">
                                  {item.videoTitle ?? `Video ${item.video_id}`}
                                </h3>
                                <p className="mt-0.5 text-xs text-muted">Sentence {item.segment_index + 1}</p>
                              </div>
                              <button
                                onClick={() => handleDelete(item.id)}
                                disabled={isDeleting}
                                className="rounded-xl border border-line bg-white p-2 transition-colors hover:bg-red-50 disabled:opacity-40"
                                aria-label={isDeleting ? `Removing bookmark` : `Remove bookmark`}
                              >
                                <Trash2 size={16} className="text-muted" />
                              </button>
                            </div>

                            <div className="mb-4 flex-1">
                              <div className="rounded-xl border border-line bg-surface p-3">
                                <p className="line-clamp-3 text-sm italic leading-relaxed text-muted">
                                  &quot;{item.sentence_text}&quot;
                                </p>
                              </div>
                              {editingId === item.id ? (
                                <div className="mt-3 flex flex-col items-end gap-1.5">
                                  <textarea
                                    value={editingNote}
                                    onChange={(e) => setEditingNote(e.target.value)}
                                    placeholder="Optional note"
                                    autoFocus
                                    rows={2}
                                    className="w-full min-w-0 resize-y rounded border border-line px-2 py-1 text-xs outline-none focus:border-primary-400 focus:ring-2 focus:ring-primary-100"
                                  />
                                  <div className="flex items-center gap-1.5">
                                    <button
                                      onClick={handleUpdateNote}
                                      disabled={isSavingNote}
                                      className="px-2 py-1 text-xs rounded border border-primary-300 text-primary-700 bg-primary-50 disabled:opacity-50"
                                    >
                                      {isSavingNote ? "Saving…" : "Save"}
                                    </button>
                                    <button
                                      onClick={cancelEdit}
                                      disabled={isSavingNote}
                                      className="px-2 py-1 text-xs rounded border border-line text-muted disabled:opacity-50"
                                    >
                                      Cancel
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <button
                                  onClick={() => beginEdit(item)}
                                  className="mt-3 block w-full whitespace-pre-wrap text-left text-xs font-medium text-muted hover:text-primary-600"
                                >
                                  {item.note ? `📝 ${item.note}` : "+ Add note"}
                                </button>
                              )}
                            </div>

                            <div className="mt-auto border-t border-line pt-4">
                              <Link
                                href={`/dictation/${item.video_id}?segment=${item.segment_index}`}
                                className="inline-block text-xs font-semibold text-primary-600 underline hover:text-primary-700"
                              >
                                Jump to this spot
                              </Link>
                            </div>
                          </motion.div>
                        );
                      })}
                    </section>
                  )}
                </>
              )}
            </>
          )}
        </main>
        <AppFooter />
      </div>
    </div>
  );
}

function BookmarksPageFallback() {
  return (
    <div className="relative flex min-h-screen w-full flex-1 flex-col overflow-hidden bg-page font-sans text-ink antialiased">
      <div className="relative z-10 flex flex-1 flex-col">
        <AppHeader active="bookmarks" />
        <main
          className={clsx(
            "mx-auto flex w-full flex-1 flex-col gap-8 py-8",
            PAGE_WIDTH_CLASS.wide,
            PAGE_PADDING_CLASS.wide
          )}
        >
          <p className="text-sm text-muted">Loading…</p>
        </main>
      </div>
    </div>
  );
}

export default function BookmarksPage() {
  return (
    <Suspense fallback={<BookmarksPageFallback />}>
      <BookmarksPageContent />
    </Suspense>
  );
}
