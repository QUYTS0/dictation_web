"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
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

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-white border-b border-slate-200 px-4 py-3 flex items-center gap-4">
        <Link href="/" className="text-indigo-600 hover:text-indigo-800 text-sm font-medium">
          ← Back
        </Link>
        <h1 className="text-base font-bold text-slate-800 truncate flex-1">Vocabulary</h1>
        <UserButton />
      </header>

      <main className="max-w-4xl mx-auto w-full p-4 md:p-6">
        {loading ? null : !user ? (
          <div className="rounded-xl border border-slate-200 bg-white p-6">
            <p className="font-semibold text-slate-800">Sign in required</p>
            <p className="text-sm text-slate-500 mt-1">
              Vocabulary is available for authenticated users only.
            </p>
            <button
              onClick={openAuthModal}
              className="mt-3 px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm"
            >
              Sign in
            </button>
          </div>
        ) : error ? (
          <p className="text-red-600 text-sm">{error}</p>
        ) : loadingItems ? (
          <p className="text-slate-500 text-sm">Loading vocabulary…</p>
        ) : items.length === 0 ? (
          <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500">
            No saved terms yet.
          </div>
        ) : (
          <ul className="space-y-3">
            {items.map((item) => (
              <li key={item.id} className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex items-start justify-between gap-3">
                  <p className="font-semibold text-slate-800">{item.term}</p>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => beginEdit(item)}
                      disabled={deletingId === item.id || updatingId === item.id}
                      className="h-7 px-2 rounded-md border border-slate-300 text-xs text-slate-600 hover:border-indigo-300 hover:text-indigo-700 disabled:opacity-40"
                      aria-label={`Edit vocabulary ${item.term}`}
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => handleDelete(item.id)}
                      disabled={deletingId === item.id || updatingId === item.id}
                      className="h-7 px-2 rounded-md border border-slate-300 text-xs text-slate-600 hover:text-red-600 hover:border-red-300 disabled:opacity-40"
                      aria-label={
                        deletingId === item.id
                          ? `Removing vocabulary ${item.term}`
                          : `Remove vocabulary ${item.term}`
                      }
                    >
                      {deletingId === item.id ? "Removing…" : "Remove"}
                    </button>
                  </div>
                </div>
                {editingId === item.id ? (
                  <div className="mt-2 flex flex-col gap-2">
                    <input
                      value={editingTerm}
                      onChange={(e) => setEditingTerm(e.target.value)}
                      className="rounded-md border border-slate-300 px-2 py-1 text-xs"
                      placeholder="Saved text"
                    />
                    <input
                      value={editingSentenceContext}
                      onChange={(e) => setEditingSentenceContext(e.target.value)}
                      className="rounded-md border border-slate-300 px-2 py-1 text-xs"
                      placeholder="Sentence context"
                    />
                    <input
                      value={editingNote}
                      onChange={(e) => setEditingNote(e.target.value)}
                      className="rounded-md border border-slate-300 px-2 py-1 text-xs"
                      placeholder="Optional note"
                    />
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={handleUpdate}
                        disabled={updatingId === item.id}
                        className="h-7 px-2 rounded-md bg-indigo-600 text-white text-xs disabled:opacity-40"
                      >
                        {updatingId === item.id ? "Saving…" : "Save"}
                      </button>
                      <button
                        onClick={cancelEdit}
                        disabled={updatingId === item.id}
                        className="h-7 px-2 rounded-md border border-slate-300 text-xs text-slate-600 disabled:opacity-40"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <p className="text-xs text-slate-500 mt-1">{item.sentence_context}</p>
                    {item.note && <p className="text-xs text-indigo-600 mt-1">Note: {item.note}</p>}
                  </>
                )}
                <Link
                  href={`/dictation/${item.video_id}`}
                  className="inline-block mt-2 text-xs text-indigo-600 hover:text-indigo-800 underline"
                >
                  Open source video
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
