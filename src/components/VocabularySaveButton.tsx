"use client";

import { useState } from "react";
import { useRequireAuth } from "@/context/auth";

interface VocabularySaveButtonProps {
  videoId: string;
  segmentIndex: number;
  sentenceContext: string;
}

export default function VocabularySaveButton({
  videoId,
  segmentIndex,
  sentenceContext,
}: VocabularySaveButtonProps) {
  const requireAuth = useRequireAuth();
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    if (!term.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/vocabulary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoId,
          segmentIndex,
          term,
          sentenceContext,
          note,
        }),
      });
      if (!res.ok) throw new Error();
      setSaved(true);
      setOpen(false);
      setTerm("");
      setNote("");
      setTimeout(() => setSaved(false), 1500);
    } catch {
      setError("Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <button
        onClick={() =>
          requireAuth(() => {
            setOpen((v) => !v);
            setError(null);
          })
        }
        className="self-start text-xs text-indigo-600 hover:text-indigo-800 underline"
      >
        {saved ? "✅ Saved" : "Save vocabulary"}
      </button>
      {open && (
        <div className="flex flex-col gap-2 mt-1 p-2 border rounded-md bg-slate-50">
          <input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="Word or short phrase"
            className="rounded border border-slate-300 px-2 py-1 text-xs"
          />
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note (optional)"
            className="rounded border border-slate-300 px-2 py-1 text-xs"
          />
          <button
            onClick={handleSave}
            disabled={saving || !term.trim()}
            className="self-start px-2 py-1 text-xs rounded bg-indigo-600 text-white disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save"}
          </button>
          {error && <span className="text-xs text-red-600">{error}</span>}
        </div>
      )}
    </div>
  );
}
