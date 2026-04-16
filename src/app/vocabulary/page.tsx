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
                <p className="font-semibold text-slate-800">{item.term}</p>
                <p className="text-xs text-slate-500 mt-1">{item.sentence_context}</p>
                {item.note && <p className="text-xs text-indigo-600 mt-1">Note: {item.note}</p>}
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
