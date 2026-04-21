"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  BookOpen,
  Filter,
  Headphones,
  Pencil,
  Search,
  Star,
  Trash2,
  Volume2,
} from "lucide-react";
import { motion } from "motion/react";
import UserButton from "@/components/UserButton";
import { useAuth } from "@/context/auth";
import type { VocabularyItem } from "@/lib/types";

export default function VocabularyPage() {
  const { user, loading, openAuthModal } = useAuth();
  const [items, setItems] = useState<VocabularyItem[]>([]);
  const [loadingItems, setLoadingItems] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTerm, setEditingTerm] = useState("");
  const [editingSentenceContext, setEditingSentenceContext] = useState("");
  const [editingNote, setEditingNote] = useState("");
  const [searchTerm, setSearchTerm] = useState("");

  useEffect(() => {
    if (!user) return;
    fetch("/api/vocabulary")
      .then(async (res) => {
        if (!res.ok) throw new Error();
        return res.json();
      })
      .then((data) => setItems(data.items ?? []))
      .catch(() => setError("Failed to load vocabulary."))
      .finally(() => setLoadingItems(false));
  }, [user]);

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    setError(null);
    try {
      const res = await fetch(`/api/vocabulary?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || "Failed to delete vocabulary item.");
      }
      setItems((prev) => prev.filter((item) => item.id !== id));
    } catch (err: unknown) {
      const message =
        err instanceof Error && err.message ? err.message : "Failed to delete vocabulary item.";
      setError(message);
    } finally {
      setDeletingId(null);
    }
  };

  const beginEdit = (item: VocabularyItem) => {
    setEditingId(item.id);
    setEditingTerm(item.term);
    setEditingSentenceContext(item.sentence_context);
    setEditingNote(item.note ?? "");
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditingTerm("");
    setEditingSentenceContext("");
    setEditingNote("");
  };

  const handleUpdate = async () => {
    if (!editingId) return;
    setUpdatingId(editingId);
    setError(null);
    try {
      const res = await fetch("/api/vocabulary", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: editingId,
          term: editingTerm,
          sentenceContext: editingSentenceContext,
          note: editingNote,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; item?: VocabularyItem };
      if (!res.ok || !data.item) {
        throw new Error(data.error || "Failed to update vocabulary item.");
      }
      setItems((prev) => prev.map((item) => (item.id === editingId ? data.item! : item)));
      cancelEdit();
    } catch (err: unknown) {
      const message =
        err instanceof Error && err.message ? err.message : "Failed to update vocabulary item.";
      setError(message);
    } finally {
      setUpdatingId(null);
    }
  };

  const filteredItems = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    if (!query) return items;
    return items.filter((item) => {
      return (
        item.term.toLowerCase().includes(query) ||
        item.sentence_context.toLowerCase().includes(query) ||
        (item.note ?? "").toLowerCase().includes(query)
      );
    });
  }, [items, searchTerm]);

  const masteredCount = useMemo(
    () => items.filter((item) => Boolean(item.note && item.note.trim().length > 0)).length,
    [items]
  );

  return (
    <div className="relative z-10 flex min-h-screen w-full flex-1 flex-col bg-slate-50">
      <header className="sticky top-0 z-20 w-full shrink-0 border-b border-white/40 bg-white/30 px-6 py-4 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between">
          <div className="flex items-center gap-2">
            <Link href="/" className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-white shadow-lg shadow-indigo-200">
                <Headphones size={18} />
              </div>
              <span className="text-lg font-bold tracking-tight text-slate-900">
                Dicta<span className="text-indigo-500">Learn</span>
              </span>
            </Link>
            {user && (
              <nav className="ml-4 hidden gap-6 md:flex">
                <Link
                  href="/"
                  className="text-sm font-medium text-slate-500 transition-colors hover:text-indigo-600"
                >
                  Dashboard
                </Link>
                <span className="text-sm font-bold text-indigo-600">Vocabulary</span>
              </nav>
            )}
          </div>
          <UserButton />
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 overflow-y-auto px-4 py-8">
        {loading ? null : !user ? (
          <section className="rounded-3xl border border-white/60 bg-white/40 p-8 shadow-xl backdrop-blur-xl">
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">Vocabulary Bank</h1>
            <p className="mt-2 text-sm text-slate-500">Sign in to review and edit saved vocabulary items.</p>
            <button
              onClick={openAuthModal}
              className="mt-4 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
            >
              Sign in
            </button>
          </section>
        ) : (
          <>
            <section className="flex flex-col items-start justify-between gap-6 md:flex-row md:items-end">
              <div>
                <h1 className="mb-2 text-3xl font-bold tracking-tight text-slate-900">Vocabulary Bank</h1>
                <p className="text-sm text-slate-500">Review and master the words you&apos;ve learned.</p>
              </div>
              <div className="flex w-full gap-4 md:w-auto">
                <div className="flex flex-1 items-center gap-3 rounded-2xl border border-white/60 bg-white/50 p-3 px-5 shadow-sm backdrop-blur-md md:flex-initial">
                  <BookOpen className="text-indigo-500" size={20} />
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Total Words</p>
                    <p className="text-lg font-black leading-none text-slate-800">{items.length}</p>
                  </div>
                </div>
                <div className="flex flex-1 items-center gap-3 rounded-2xl border border-white/60 bg-white/50 p-3 px-5 shadow-sm backdrop-blur-md md:flex-initial">
                  <Star className="fill-amber-500 text-amber-500" size={20} />
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Mastered</p>
                    <p className="text-lg font-black leading-none text-slate-800">{masteredCount}</p>
                  </div>
                </div>
              </div>
            </section>

            <section className="flex gap-3">
              <div className="relative flex-1 overflow-hidden rounded-2xl border border-white/60 bg-white/40 shadow-sm backdrop-blur-xl transition-all focus-within:ring-2 focus-within:ring-indigo-500/30">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                <input
                  type="text"
                  placeholder="Search words, notes, or sentences..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full bg-transparent py-3 pl-11 pr-4 font-medium text-slate-800 outline-none placeholder:text-slate-400"
                />
              </div>
              <button
                type="button"
                className="flex items-center gap-2 rounded-2xl border border-white/80 bg-white/60 px-4 font-semibold text-slate-600 shadow-md backdrop-blur-xl transition-colors active:translate-y-px hover:text-indigo-600"
              >
                <Filter size={18} />
                <span className="hidden sm:inline">Filter</span>
              </button>
            </section>

            {error ? <p className="text-sm text-red-600">{error}</p> : null}

            {loadingItems ? (
              <p className="text-sm text-slate-500">Loading vocabulary…</p>
            ) : filteredItems.length === 0 ? (
              <section className="rounded-3xl border border-white/60 bg-white/40 p-6 text-sm text-slate-500 shadow-xl backdrop-blur-xl">
                No saved vocabulary yet.
              </section>
            ) : (
              <section className="grid gap-6 pb-12 sm:grid-cols-2 lg:grid-cols-3">
                {filteredItems.map((item, idx) => {
                  const hasNote = Boolean(item.note && item.note.trim().length > 0);
                  const mastery = hasNote ? 100 : 60;

                  return (
                    <motion.div
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: idx * 0.05 }}
                      key={item.id}
                      className="group flex h-full flex-col rounded-3xl border border-white/60 bg-white/40 p-6 shadow-xl backdrop-blur-xl transition-all hover:-translate-y-1"
                    >
                      <div className="mb-4 flex items-start justify-between">
                        <div>
                          <h3 className="text-xl font-bold text-indigo-900 transition-colors group-hover:text-indigo-600">
                            {item.term}
                          </h3>
                          <div className="mt-1 flex items-center gap-2">
                            <button
                              type="button"
                              className="rounded-md border border-white/40 bg-white/50 p-1 text-slate-400 shadow-sm transition-colors hover:text-indigo-500"
                              aria-label={`Play pronunciation for ${item.term}`}
                            >
                              <Volume2 size={14} />
                            </button>
                            <span className="rounded-md border border-emerald-200/50 bg-emerald-100/50 px-2 py-0.5 text-xs font-bold text-emerald-600">
                              Saved
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => beginEdit(item)}
                            disabled={deletingId === item.id || updatingId === item.id}
                            className="rounded-xl border border-white/60 bg-white/50 p-2 transition-colors hover:bg-white/80 disabled:opacity-40"
                            aria-label={`Edit vocabulary ${item.term}`}
                          >
                            <Pencil size={16} className="text-slate-500" />
                          </button>
                          <button
                            onClick={() => handleDelete(item.id)}
                            disabled={deletingId === item.id || updatingId === item.id}
                            className="rounded-xl border border-white/60 bg-white/50 p-2 transition-colors hover:bg-red-50 disabled:opacity-40"
                            aria-label={
                              deletingId === item.id
                                ? `Removing vocabulary ${item.term}`
                                : `Remove vocabulary ${item.term}`
                            }
                          >
                            <Trash2 size={16} className="text-slate-500" />
                          </button>
                        </div>
                      </div>

                      <div className="mb-4 flex-1">
                        {editingId === item.id ? (
                          <div className="flex flex-col gap-2">
                            <input
                              value={editingTerm}
                              onChange={(e) => setEditingTerm(e.target.value)}
                              className="rounded-md border border-slate-300 px-2 py-1 text-xs"
                              placeholder="Saved text"
                              aria-label="Edit saved text"
                              autoFocus
                            />
                            <input
                              value={editingSentenceContext}
                              onChange={(e) => setEditingSentenceContext(e.target.value)}
                              className="rounded-md border border-slate-300 px-2 py-1 text-xs"
                              placeholder="Sentence context"
                              aria-label="Edit sentence context"
                            />
                            <input
                              value={editingNote}
                              onChange={(e) => setEditingNote(e.target.value)}
                              className="rounded-md border border-slate-300 px-2 py-1 text-xs"
                              placeholder="Optional note"
                              aria-label="Edit note"
                            />
                            <div className="flex items-center gap-2">
                              <button
                                onClick={handleUpdate}
                                disabled={updatingId === item.id}
                                className="rounded-md bg-indigo-600 px-2 py-1 text-xs text-white disabled:opacity-40"
                              >
                                {updatingId === item.id ? "Saving…" : "Save"}
                              </button>
                              <button
                                onClick={cancelEdit}
                                disabled={updatingId === item.id}
                                className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-600 disabled:opacity-40"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <>
                            {item.note ? <p className="font-medium leading-relaxed text-slate-700">{item.note}</p> : null}
                            <div className="mt-3 rounded-xl border border-white/40 bg-white/30 p-3 shadow-inner">
                              <p className="line-clamp-3 text-sm italic leading-relaxed text-slate-500">
                                &quot;{item.sentence_context}&quot;
                              </p>
                            </div>
                          </>
                        )}
                      </div>

                      <div className="mt-auto border-t border-white/40 pt-4">
                        <div className="mb-2 flex items-center justify-between">
                          <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Mastery</span>
                          <span className="text-[10px] font-bold text-indigo-600">{mastery}%</span>
                        </div>
                        <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-slate-200/50 shadow-inner">
                          <div
                            className="relative h-full rounded-full bg-gradient-to-r from-indigo-400 to-indigo-600"
                            style={{ width: `${mastery}%` }}
                          />
                        </div>
                        <Link
                          href={`/dictation/${item.video_id}`}
                          className="mt-3 inline-block text-xs font-semibold text-indigo-600 underline hover:text-indigo-800"
                        >
                          Open source video
                        </Link>
                      </div>
                    </motion.div>
                  );
                })}
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}
