import { useState } from "react";
import { clsx } from "clsx";
import { VocabularyEditForm } from "@/components/VocabularyEditForm";
import type { LessonSavedItem } from "../types";

export function LessonSavedItemsList({
  items,
  compact = false,
  scrollClassName,
  deletingId,
  updatingId,
  onDelete,
  onUpdate,
}: {
  items: LessonSavedItem[];
  compact?: boolean;
  scrollClassName?: string;
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
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTerm, setEditingTerm] = useState("");
  const [editingSentenceContext, setEditingSentenceContext] = useState("");
  const [editingNote, setEditingNote] = useState("");
  const [editingTranslation, setEditingTranslation] = useState("");
  const [editingPhonetic, setEditingPhonetic] = useState("");
  const [editingPartOfSpeech, setEditingPartOfSpeech] = useState("");
  const [editingDefinition, setEditingDefinition] = useState("");

  const beginEdit = (item: LessonSavedItem) => {
    setEditingId(item.id);
    setEditingTerm(item.term);
    setEditingSentenceContext(item.sentence_context);
    setEditingNote(item.note ?? "");
    setEditingTranslation(item.translation ?? "");
    setEditingPhonetic(item.phonetic ?? "");
    setEditingPartOfSpeech(item.part_of_speech ?? "");
    setEditingDefinition(item.definition ?? "");
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditingTerm("");
    setEditingSentenceContext("");
    setEditingNote("");
    setEditingTranslation("");
    setEditingPhonetic("");
    setEditingPartOfSpeech("");
    setEditingDefinition("");
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
            "rounded-lg border border-[var(--border)] bg-[var(--surface-2)] backdrop-blur-md p-3 flex flex-col gap-1",
            compact && "p-2 rounded-md"
          )}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              {item.image_thumbnail_url && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={item.image_thumbnail_url}
                  alt=""
                  className="h-6 w-6 shrink-0 rounded object-cover"
                />
              )}
              <span className={clsx("truncate text-sm text-[var(--text)]", compact && "text-xs font-semibold")}>
                {item.term}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] uppercase tracking-wide rounded-full bg-[var(--accent-soft)] text-[var(--accent)] px-2 py-0.5">
                {item.type}
              </span>
              {item.type === "word" && (
                <button
                  onClick={() => beginEdit(item)}
                  disabled={updatingId === item.id || deletingId === item.id}
                  className="h-5 px-1.5 rounded border border-[var(--border)] text-[10px] text-[var(--text-muted)] hover:border-[var(--accent-border)] hover:text-[var(--accent)] disabled:opacity-40"
                  title="Edit saved word"
                  aria-label={`Edit saved word ${item.term}`}
                >
                  Edit
                </button>
              )}
              <button
                onClick={() => onDelete(item.id)}
                disabled={deletingId === item.id || updatingId === item.id}
                className="h-5 w-5 rounded-full border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--red)] hover:border-[var(--red)] focus:text-[var(--red)] focus:border-[var(--red)] focus:outline-none focus:ring-2 focus:ring-[var(--red)]/30 disabled:opacity-40"
                aria-label={
                  deletingId === item.id
                    ? `Removing saved item ${item.term}`
                    : `Remove saved item ${item.term}`
                }
                aria-live="polite"
                title="Remove saved item"
              >
                {deletingId === item.id ? (
                  <svg
                    viewBox="0 0 20 20"
                    aria-hidden="true"
                    className="h-3.5 w-3.5 mx-auto animate-spin"
                  >
                    <circle
                      cx="10"
                      cy="10"
                      r="7"
                      fill="none"
                      stroke="currentColor"
                      strokeOpacity="0.25"
                      strokeWidth="2"
                    />
                    <path d="M10 3a7 7 0 0 1 7 7" fill="none" stroke="currentColor" strokeWidth="2" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 20 20" aria-hidden="true" className="h-3.5 w-3.5 mx-auto">
                    <path
                      d="M6 6l8 8M14 6l-8 8"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                    />
                  </svg>
                )}
              </button>
            </div>
          </div>
          {(item.phonetic || item.part_of_speech) && (
            <div className="flex flex-wrap items-center gap-1.5">
              {item.phonetic && (
                <span className={clsx("text-xs text-[var(--text-muted)]", compact && "text-[11px]")}>{item.phonetic}</span>
              )}
              {item.part_of_speech && (
                <span className="rounded-full bg-[var(--accent-soft)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--accent)]">
                  {item.part_of_speech}
                </span>
              )}
            </div>
          )}
          {item.definition && (
            <span className={clsx("text-xs text-[var(--text-muted)]", compact && "text-[11px] line-clamp-2")}>
              {item.definition}
            </span>
          )}
          {item.translation && (
            <span className={clsx("text-sm font-medium text-[var(--accent)]", compact && "text-xs")}>
              {item.translation}
            </span>
          )}
          <span className={clsx("text-xs text-[var(--text-faint)]", compact && "text-[11px]")}>
            Sentence {item.segment_index + 1}
          </span>
          <span className={clsx("text-xs text-[var(--text-muted)]", compact && "text-[11px] line-clamp-2")}>
            {item.sentence_context}
          </span>
          {item.note && (
            <span className={clsx("whitespace-pre-wrap text-xs text-[var(--text-muted)]", compact && "text-[11px]")}>
              📝 {item.note}
            </span>
          )}
          {editingId === item.id && (
            <div className="mt-1">
              <VocabularyEditForm
                size="compact"
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
                onSave={() =>
                  onUpdate(item.id, {
                    term: editingTerm,
                    sentenceContext: editingSentenceContext,
                    note: editingNote,
                    translation: editingTranslation,
                    phonetic: editingPhonetic,
                    partOfSpeech: editingPartOfSpeech,
                    definition: editingDefinition,
                  })
                }
                onCancel={cancelEdit}
                saving={updatingId === item.id}
                autoFocusTerm
              />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
