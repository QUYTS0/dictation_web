import { useState } from "react";
import { clsx } from "clsx";
import type { Bookmark } from "@/lib/types";

export function BookmarksList({
  items,
  compact = false,
  scrollClassName,
  deletingId,
  onDelete,
  onUpdateNote,
  onJump,
}: {
  items: Bookmark[];
  compact?: boolean;
  scrollClassName?: string;
  deletingId: string | null;
  onDelete: (id: string) => void;
  onUpdateNote: (id: string, note: string) => void;
  onJump: (segmentIndex: number) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingNote, setEditingNote] = useState("");

  const beginEdit = (item: Bookmark) => {
    setEditingId(item.id);
    setEditingNote(item.note ?? "");
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditingNote("");
  };

  return (
    <div
      className={clsx(
        "flex flex-col gap-2 overflow-y-auto pr-1",
        compact && "pr-0",
        scrollClassName ?? "max-h-52"
      )}
    >
      {items.map((item) => (
        <div
          key={item.id}
          className={clsx(
            "rounded-lg border border-white/60 bg-white/50 backdrop-blur-md p-3 flex flex-col gap-1",
            compact && "p-2 rounded-md"
          )}
        >
          <div className="flex items-center justify-between gap-2">
            <button
              onClick={() => onJump(item.segment_index)}
              className={clsx(
                "text-sm font-semibold text-indigo-600 hover:underline",
                compact && "text-xs"
              )}
            >
              Sentence {item.segment_index + 1}
            </button>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => beginEdit(item)}
                className="h-5 px-1.5 rounded border border-slate-300 text-[10px] text-slate-600 hover:border-indigo-300 hover:text-indigo-700"
                title="Edit note"
                aria-label={`Edit note for sentence ${item.segment_index + 1}`}
              >
                Edit
              </button>
              <button
                onClick={() => onDelete(item.id)}
                disabled={deletingId === item.id}
                className="h-5 w-5 rounded-full border border-slate-300 text-slate-500 hover:text-red-600 hover:border-red-300 focus:text-red-600 focus:border-red-300 focus:outline-none focus:ring-2 focus:ring-red-200 disabled:opacity-40"
                aria-label={
                  deletingId === item.id
                    ? `Removing bookmark for sentence ${item.segment_index + 1}`
                    : `Remove bookmark for sentence ${item.segment_index + 1}`
                }
                aria-live="polite"
                title="Remove bookmark"
              >
                {deletingId === item.id ? (
                  <svg viewBox="0 0 20 20" aria-hidden="true" className="h-3.5 w-3.5 mx-auto animate-spin">
                    <circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
                    <path d="M10 3a7 7 0 0 1 7 7" fill="none" stroke="currentColor" strokeWidth="2" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 20 20" aria-hidden="true" className="h-3.5 w-3.5 mx-auto">
                    <path d="M6 6l8 8M14 6l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  </svg>
                )}
              </button>
            </div>
          </div>
          <span className={clsx("text-xs text-slate-600", compact && "text-[11px] line-clamp-2")}>
            {item.sentence_text}
          </span>
          {item.note && (
            <span className={clsx("whitespace-pre-wrap text-xs text-slate-700", compact && "text-[11px]")}>
              📝 {item.note}
            </span>
          )}
          {editingId === item.id && (
            <div className="mt-1 flex flex-col items-end gap-1.5">
              <textarea
                value={editingNote}
                onChange={(e) => setEditingNote(e.target.value)}
                placeholder="Optional note"
                autoFocus
                rows={2}
                className="w-full min-w-0 resize-y rounded border border-slate-300 px-2 py-1 text-[11px] outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
              />
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => {
                    onUpdateNote(item.id, editingNote);
                    cancelEdit();
                  }}
                  className="px-2 py-1 text-[11px] rounded border border-indigo-300 text-indigo-700 bg-indigo-50"
                >
                  Save
                </button>
                <button
                  onClick={cancelEdit}
                  className="px-2 py-1 text-[11px] rounded border border-slate-300 text-slate-600"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
