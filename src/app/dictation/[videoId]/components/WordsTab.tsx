import { Type } from "lucide-react";
import { LessonSavedItemsList } from "./LessonSavedItemsList";
import type { LessonSavedItem } from "../types";

export function WordsTab({
  items,
  deletingId,
  updatingId,
  onDelete,
  onUpdate,
  learningError,
  learningErrorRetry,
}: {
  items: LessonSavedItem[];
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
}) {
  return (
    <>
      {items.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-full text-center px-4">
          <Type size={32} className="text-[var(--text-faint)] mb-3" />
          <p className="text-[var(--text-muted)] text-xs font-medium">No saved words or phrases yet.</p>
        </div>
      ) : (
        <LessonSavedItemsList
          items={items}
          compact
          scrollClassName="h-full"
          deletingId={deletingId}
          updatingId={updatingId}
          onDelete={onDelete}
          onUpdate={onUpdate}
        />
      )}
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
    </>
  );
}
