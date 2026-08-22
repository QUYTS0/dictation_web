"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { MapPin, Search, Trash2 } from "lucide-react";
import { motion } from "motion/react";
import AppHeader from "@/components/AppHeader";
import { useAuth } from "@/context/auth";
import type { Bookmark } from "@/lib/types";

interface BookmarkWithVideo extends Bookmark {
  videoTitle: string | null;
}

export default function BookmarksPage() {
  const { user, loading, openAuthModal } = useAuth();
  const [items, setItems] = useState<BookmarkWithVideo[]>([]);
  const [loadingItems, setLoadingItems] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingNote, setEditingNote] = useState("");
  const [searchTerm, setSearchTerm] = useState("");

  useEffect(() => {
    if (!user) return;
    fetch("/api/bookmarks")
      .then(async (res) => {
        if (!res.ok) throw new Error();
        return res.json();
      })
      .then((data) => setItems(data.items ?? []))
      .catch(() => setError("Failed to load bookmarks."))
      .finally(() => setLoadingItems(false));
  }, [user]);

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    setError(null);
    try {
      const res = await fetch(`/api/bookmarks?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || "Failed to delete bookmark.");
      }
      setItems((prev) => prev.filter((item) => item.id !== id));
    } catch (err: unknown) {
      const message = err instanceof Error && err.message ? err.message : "Failed to delete bookmark.";
      setError(message);
    } finally {
      setDeletingId(null);
    }
  };

  const beginEdit = (item: BookmarkWithVideo) => {
    setEditingId(item.id);
    setEditingNote(item.note ?? "");
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditingNote("");
  };

  const handleUpdateNote = async () => {
    if (!editingId) return;
    setError(null);
    try {
      const res = await fetch("/api/bookmarks", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: editingId, note: editingNote }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; item?: Bookmark };
      if (!res.ok || !data.item) {
        throw new Error(data.error || "Failed to update bookmark.");
      }
      setItems((prev) =>
        prev.map((item) => (item.id === editingId ? { ...item, note: data.item!.note } : item))
      );
      cancelEdit();
    } catch (err: unknown) {
      const message = err instanceof Error && err.message ? err.message : "Failed to update bookmark.";
      setError(message);
    }
  };

  const filteredItems = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    if (!query) return items;
    return items.filter(
      (item) =>
        item.sentence_text.toLowerCase().includes(query) ||
        (item.note ?? "").toLowerCase().includes(query) ||
        (item.videoTitle ?? "").toLowerCase().includes(query)
    );
  }, [items, searchTerm]);

  return (
    <div className="relative flex min-h-screen w-full flex-1 flex-col overflow-hidden bg-[#f4f7ff] font-sans text-slate-900 antialiased">
      <div className="pointer-events-none absolute -left-[10%] -top-[10%] z-0 h-[40%] w-[40%] rounded-full bg-purple-200 opacity-60 blur-[120px]" />
      <div className="pointer-events-none absolute bottom-[10%] right-[0%] z-0 h-[40%] w-[40%] rounded-full bg-blue-200 opacity-60 blur-[120px]" />

      <div className="relative z-10 flex flex-1 flex-col">
        <AppHeader active="bookmarks" />

        <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-4 py-8">
          {loading ? null : !user ? (
            <section className="rounded-3xl border border-white/60 bg-white/40 p-8 shadow-xl backdrop-blur-xl">
              <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Bookmarks</h1>
              <p className="mt-2 text-sm text-slate-500">Sign in to review the sentences you&apos;ve bookmarked.</p>
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
                  <h1 className="mb-1 text-2xl font-semibold tracking-tight text-slate-900">Bookmarks</h1>
                  <p className="text-sm text-slate-500">Jump back to sentences you&apos;ve marked across every video.</p>
                </div>
                <div className="flex items-center gap-3 rounded-2xl border border-white/60 bg-white/50 p-3 px-5 shadow-sm backdrop-blur-md">
                  <MapPin className="text-primary-500" size={20} />
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Total Bookmarks</p>
                    <p className="text-lg font-black leading-none text-slate-800">{items.length}</p>
                  </div>
                </div>
              </section>

              <section className="flex gap-3">
                <div className="relative flex-1 overflow-hidden rounded-2xl border border-white/60 bg-white/40 shadow-sm backdrop-blur-xl transition-all focus-within:ring-2 focus-within:ring-primary-500/30">
                  <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                  <input
                    type="text"
                    placeholder="Search bookmarked sentences or notes..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="w-full bg-transparent py-3 pl-11 pr-4 font-medium text-slate-800 outline-none placeholder:text-slate-400"
                  />
                </div>
              </section>

              {error ? <p className="text-sm text-red-600">{error}</p> : null}

              {loadingItems ? (
                <p className="text-sm text-slate-500">Loading bookmarks…</p>
              ) : filteredItems.length === 0 ? (
                <section className="rounded-3xl border border-white/60 bg-white/40 p-6 text-sm text-slate-500 shadow-xl backdrop-blur-xl">
                  No bookmarks yet.
                </section>
              ) : (
                <section className="grid gap-6 pb-12 sm:grid-cols-2 lg:grid-cols-3">
                  {filteredItems.map((item, idx) => (
                    <motion.div
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: idx * 0.05 }}
                      key={item.id}
                      className="group flex h-full flex-col rounded-3xl border border-white/60 bg-white/40 p-6 shadow-xl backdrop-blur-xl transition-all hover:-translate-y-1"
                    >
                      <div className="mb-3 flex items-start justify-between gap-2">
                        <div>
                          <h3 className="text-sm font-bold text-slate-900 transition-colors group-hover:text-primary-600">
                            {item.videoTitle ?? `Video ${item.video_id}`}
                          </h3>
                          <p className="mt-0.5 text-xs text-slate-500">Sentence {item.segment_index + 1}</p>
                        </div>
                        <button
                          onClick={() => handleDelete(item.id)}
                          disabled={deletingId === item.id}
                          className="rounded-xl border border-white/60 bg-white/50 p-2 transition-colors hover:bg-red-50 disabled:opacity-40"
                          aria-label={deletingId === item.id ? `Removing bookmark` : `Remove bookmark`}
                        >
                          <Trash2 size={16} className="text-slate-500" />
                        </button>
                      </div>

                      <div className="mb-4 flex-1">
                        <div className="rounded-xl border border-white/40 bg-white/30 p-3 shadow-inner">
                          <p className="line-clamp-3 text-sm italic leading-relaxed text-slate-500">
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
                              className="w-full min-w-0 resize-y rounded border border-slate-300 px-2 py-1 text-xs outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
                            />
                            <div className="flex items-center gap-1.5">
                              <button
                                onClick={handleUpdateNote}
                                className="px-2 py-1 text-xs rounded border border-indigo-300 text-indigo-700 bg-indigo-50"
                              >
                                Save
                              </button>
                              <button
                                onClick={cancelEdit}
                                className="px-2 py-1 text-xs rounded border border-slate-300 text-slate-600"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <button
                            onClick={() => beginEdit(item)}
                            className="mt-3 block w-full whitespace-pre-wrap text-left text-xs font-medium text-slate-500 hover:text-primary-600"
                          >
                            {item.note ? `📝 ${item.note}` : "+ Add note"}
                          </button>
                        )}
                      </div>

                      <div className="mt-auto border-t border-white/40 pt-4">
                        <Link
                          href={`/dictation/${item.video_id}?segment=${item.segment_index}`}
                          className="inline-block text-xs font-semibold text-primary-600 underline hover:text-primary-700"
                        >
                          Jump to this spot
                        </Link>
                      </div>
                    </motion.div>
                  ))}
                </section>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
