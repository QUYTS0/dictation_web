import { AlignLeft, MapPin } from "lucide-react";
import type { Bookmark } from "@/lib/types";
import { LessonSavedItemsList } from "./LessonSavedItemsList";
import { BookmarksList } from "./BookmarksList";
import type { LessonSavedItem } from "../types";

export function SentencesTab({
  sentenceItems,
  deletingId,
  updatingId,
  onDelete,
  onUpdate,
  learningError,
  learningErrorRetry,
  bookmarks,
  bookmarksLoading,
  bookmarksError,
  bookmarksErrorRetry,
  bookmarkDeletingId,
  onDeleteBookmark,
  onUpdateBookmarkNote,
  onJumpBookmark,
}: {
  sentenceItems: LessonSavedItem[];
  deletingId: string | null;
  updatingId: string | null;
  onDelete: (itemId: string) => void;
  onUpdate: (
    itemId: string,
    values: {
      term: string;
      sentenceContext: string;
      note: string;
      translation: string;
      phonetic: string;
      partOfSpeech: string;
      definition: string;
    }
  ) => void;
  learningError: string | null;
  learningErrorRetry: (() => void) | null;
  bookmarks: Bookmark[];
  bookmarksLoading: boolean;
  bookmarksError: string | null;
  bookmarksErrorRetry: (() => void) | null;
  bookmarkDeletingId: string | null;
  onDeleteBookmark: (id: string) => void;
  onUpdateBookmarkNote: (id: string, note: string) => void;
  onJumpBookmark: (segmentIndex: number) => void;
}) {
  return (
    <div className="momentum-scroll flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overflow-x-hidden overscroll-contain">
      <div className="flex flex-col gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-faint)]">Saved sentences</p>
        {sentenceItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-6 text-center px-4">
            <AlignLeft size={28} className="text-[var(--text-faint)] mb-2" />
            <p className="text-[var(--text-muted)] text-xs font-medium">No saved sentences yet.</p>
          </div>
        ) : (
          <LessonSavedItemsList
            items={sentenceItems}
            compact
            deletingId={deletingId}
            updatingId={updatingId}
            onDelete={onDelete}
            onUpdate={onUpdate}
          />
        )}
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-faint)]">Bookmarks</p>
        {bookmarksError ? (
          <p role="alert" className="flex items-center gap-2 text-xs text-[var(--red)]">
            {bookmarksError}
            {bookmarksErrorRetry && (
              <button
                type="button"
                onClick={() => bookmarksErrorRetry()}
                className="font-semibold underline text-[var(--red)] hover:brightness-110"
              >
                Retry
              </button>
            )}
          </p>
        ) : bookmarksLoading ? (
          <p className="text-xs text-[var(--text-muted)]">Loading bookmarks…</p>
        ) : bookmarks.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-6 text-center px-4">
            <MapPin size={28} className="text-[var(--text-faint)] mb-2" />
            <p className="text-[var(--text-muted)] text-xs font-medium">
              No bookmarks yet. Use the bookmark button to save a sentence for later.
            </p>
          </div>
        ) : (
          <BookmarksList
            items={bookmarks}
            compact
            deletingId={bookmarkDeletingId}
            onDelete={onDeleteBookmark}
            onUpdateNote={onUpdateBookmarkNote}
            onJump={onJumpBookmark}
          />
        )}
      </div>

      {learningError && (
        <p role="alert" className="flex items-center gap-2 text-xs text-[var(--red)]">
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
