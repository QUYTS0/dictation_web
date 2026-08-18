import { clsx } from "clsx";

export interface VocabularyEditFormProps {
  term: string;
  onTermChange: (value: string) => void;
  note: string;
  onNoteChange: (value: string) => void;
  sentenceContext?: string;
  onSentenceContextChange?: (value: string) => void;
  onSave: () => void;
  onCancel?: () => void;
  saving?: boolean;
  saveDisabled?: boolean;
  size?: "compact" | "default";
  saveLabel?: string;
  savingLabel?: string;
  cancelLabel?: string;
  autoFocusTerm?: boolean;
}

export function VocabularyEditForm({
  term,
  onTermChange,
  note,
  onNoteChange,
  sentenceContext,
  onSentenceContextChange,
  onSave,
  onCancel,
  saving = false,
  saveDisabled = false,
  size = "default",
  saveLabel = "Save",
  savingLabel = "Saving…",
  cancelLabel = "Cancel",
  autoFocusTerm = false,
}: VocabularyEditFormProps) {
  const inputClass = clsx(
    "border border-slate-300 px-2 py-1",
    size === "compact" ? "rounded text-[11px]" : "rounded-md text-xs"
  );
  const buttonClass = clsx(
    "font-medium text-white disabled:opacity-40",
    size === "compact" ? "rounded px-2 py-1 text-[11px]" : "rounded-md px-2 py-1 text-xs"
  );
  const cancelClass = clsx(
    "border border-slate-300 text-slate-600 disabled:opacity-40",
    size === "compact" ? "rounded px-2 py-1 text-[11px]" : "rounded-md px-2 py-1 text-xs"
  );

  return (
    <div className="flex flex-col gap-1.5">
      <input
        value={term}
        onChange={(e) => onTermChange(e.target.value)}
        className={inputClass}
        placeholder="Saved text"
        aria-label="Edit saved text"
        autoFocus={autoFocusTerm}
      />
      {onSentenceContextChange && (
        <input
          value={sentenceContext ?? ""}
          onChange={(e) => onSentenceContextChange(e.target.value)}
          className={inputClass}
          placeholder="Sentence context"
          aria-label="Edit sentence context"
        />
      )}
      <input
        value={note}
        onChange={(e) => onNoteChange(e.target.value)}
        className={inputClass}
        placeholder="Optional note"
        aria-label="Edit note"
      />
      <div className="flex items-center gap-1.5">
        <button
          onClick={onSave}
          disabled={saving || saveDisabled}
          className={clsx(buttonClass, "bg-primary-600")}
        >
          {saving ? savingLabel : saveLabel}
        </button>
        {onCancel && (
          <button onClick={onCancel} disabled={saving} className={cancelClass}>
            {cancelLabel}
          </button>
        )}
      </div>
    </div>
  );
}
