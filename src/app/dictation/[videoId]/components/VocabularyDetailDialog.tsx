import { useState, type ReactNode } from "react";
import { clsx } from "clsx";
import { ArrowRight, Pencil, Trash2 } from "lucide-react";
import { VocabularyEditForm } from "@/components/VocabularyEditForm";
import { canonicalFormDiffersFromSurface } from "@/lib/utils/vocabulary";
import { ReportDialogShell } from "./ReportDialogShell";
import { splitSentenceForHighlight, type VocabularyHighlightMeta } from "../helpers";
import type { LessonSavedItem } from "../types";

type EditValues = {
  term: string;
  sentenceContext: string;
  note: string;
  translation: string;
  phonetic: string;
  partOfSpeech: string;
  definition: string;
};

function editValuesFor(item: LessonSavedItem): EditValues {
  return {
    term: item.term,
    sentenceContext: item.sentence_context,
    note: item.note ?? "",
    translation: item.translation ?? "",
    phonetic: item.phonetic ?? "",
    partOfSpeech: item.part_of_speech ?? "",
    definition: item.definition ?? "",
  };
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-faint)]">{children}</p>
  );
}

/**
 * The full-information Vocabulary study window — opened from a
 * VocabularyListItem row. Built on ReportDialogShell (the app's existing
 * portal/focus-trap/mobile-sheet dialog primitive) rather than the small
 * anchored script-selection popover, which has none of that accessibility
 * plumbing and is meant for a different job (live preview before saving).
 */
export function VocabularyDetailDialog({
  item,
  highlightMeta,
  sentenceTranslation,
  onClose,
  onDelete,
  onUpdate,
  deletingId,
  updatingId,
  learningError,
  learningErrorRetry,
  onSeekToSegment,
}: {
  item: LessonSavedItem | null;
  highlightMeta: VocabularyHighlightMeta;
  sentenceTranslation?: string;
  onClose: () => void;
  onDelete: (itemId: string) => void;
  onUpdate: (itemId: string, values: EditValues) => void;
  deletingId: string | null;
  updatingId: string | null;
  learningError: string | null;
  learningErrorRetry: (() => void) | null;
  onSeekToSegment: (segmentIndex: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<EditValues | null>(null);

  // Keeps rendering the last-open item's content while ReportDialogShell
  // plays its close animation (item briefly becomes null the instant the
  // list clears the selection, before the dialog has faded out). Updating
  // state directly during render (guarded by an identity check, the
  // React-documented pattern for "reset/derive state when a prop changes")
  // also resets any in-progress edit whenever the open item's identity
  // changes — including closing to null — without needing an effect.
  //
  // trackedItemId mirrors item?.id (including null) so the guard converges
  // after one extra render even when closing: if only lastItem's id were
  // compared, it never becomes null again once set, and the reset branch
  // would re-fire on every subsequent render forever (an infinite loop).
  const [lastItem, setLastItem] = useState<LessonSavedItem | null>(null);
  const [trackedItemId, setTrackedItemId] = useState<string | null>(null);
  if (item && item !== lastItem) {
    setLastItem(item);
  }
  const currentItemId = item?.id ?? null;
  if (currentItemId !== trackedItemId) {
    setTrackedItemId(currentItemId);
    setEditing(false);
    setDraft(null);
  }
  const displayItem = item ?? lastItem;

  if (!displayItem) return null;

  const isSaving = updatingId === displayItem.id;
  const isDeleting = deletingId === displayItem.id;
  // Canonical-form-as-primary-title, surface term as an "In this sentence:"
  // secondary line, matches the convention already established by the
  // click-to-save popover, hover tooltip, and the Sentences tab's saved-item
  // cards (see canonicalFormDiffersFromSurface's other call sites) — kept
  // consistent here rather than inventing a different "Dictionary form:"
  // treatment for just this dialog.
  const hasDifferentCanonicalForm = canonicalFormDiffersFromSurface(highlightMeta.canonicalForm, displayItem.term);
  // canonicalFormDiffersFromSurface's `canonicalForm is string` predicate
  // already guarantees this is a string when true — TS just can't narrow
  // through the boolean alias here since the checked value is a property
  // access, not a plain local, so the cast is asserting a fact already
  // proven above rather than sidestepping a real unknown.
  const dialogTitle = hasDifferentCanonicalForm ? (highlightMeta.canonicalForm as string) : displayItem.term;

  const beginEdit = () => {
    setDraft(editValuesFor(displayItem));
    setEditing(true);
  };
  const cancelEdit = () => {
    setEditing(false);
    setDraft(null);
  };
  const saveEdit = () => {
    if (!draft) return;
    onUpdate(displayItem.id, draft);
  };

  const handleDelete = () => {
    const confirmed = window.confirm(`Delete "${displayItem.term}" from your vocabulary?`);
    if (!confirmed) return;
    onDelete(displayItem.id);
    onClose();
  };

  const moreDetails = [
    displayItem.part_of_speech && { label: "Part of speech", value: displayItem.part_of_speech },
    displayItem.phonetic && { label: "Pronunciation", value: displayItem.phonetic },
    displayItem.definition && { label: "Definition", value: displayItem.definition },
    displayItem.note && { label: "Note", value: displayItem.note },
  ].filter((entry): entry is { label: string; value: string } => Boolean(entry));
  const hasMoreDetails = moreDetails.length > 0 || Boolean(displayItem.image_url);

  return (
    <ReportDialogShell
      open={Boolean(item)}
      onClose={onClose}
      titleId="vocabulary-detail-title"
      title={dialogTitle}
      size="compact"
    >
      <div className="flex flex-col gap-4">
        {/* Header — the title itself (canonical form when meaningfully
            different, else the surface term) is already shown in
            ReportDialogShell's own sticky header bar (also where its close
            button and aria-labelledby target live), so this row only adds
            what that bar doesn't: the surface term when it was swapped out
            for the canonical form above, type, saved date, edit. */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="shrink-0 rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--accent)]">
                {displayItem.type === "word" ? "Word" : "Phrase"}
              </span>
              <span className="text-[11px] text-[var(--text-faint)]">
                Saved {new Date(displayItem.created_at).toLocaleDateString()}
              </span>
            </div>
            {hasDifferentCanonicalForm && (
              <p className="text-xs text-[var(--text-faint)]">In this sentence: {displayItem.term}</p>
            )}
          </div>
          {!editing && (
            <button
              type="button"
              onClick={beginEdit}
              className="flex shrink-0 items-center gap-1 rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs font-semibold text-[var(--text-muted)] hover:border-[var(--accent-border)] hover:text-[var(--accent)]"
            >
              <Pencil size={13} /> Edit
            </button>
          )}
        </div>

        {learningError && (
          <p role="alert" className="flex items-center gap-2 rounded-lg bg-[var(--red)]/10 px-3 py-2 text-xs text-[var(--red)]">
            {learningError}
            {learningErrorRetry && (
              <button
                type="button"
                onClick={() => learningErrorRetry()}
                className="font-semibold underline hover:brightness-110"
              >
                Retry
              </button>
            )}
          </p>
        )}

        {editing && draft ? (
          <VocabularyEditForm
            term={draft.term}
            onTermChange={(term) => setDraft({ ...draft, term })}
            sentenceContext={draft.sentenceContext}
            onSentenceContextChange={(sentenceContext) => setDraft({ ...draft, sentenceContext })}
            translation={draft.translation}
            onTranslationChange={(translation) => setDraft({ ...draft, translation })}
            phonetic={draft.phonetic}
            onPhoneticChange={(phonetic) => setDraft({ ...draft, phonetic })}
            partOfSpeech={draft.partOfSpeech}
            onPartOfSpeechChange={(partOfSpeech) => setDraft({ ...draft, partOfSpeech })}
            definition={draft.definition}
            onDefinitionChange={(definition) => setDraft({ ...draft, definition })}
            note={draft.note}
            onNoteChange={(note) => setDraft({ ...draft, note })}
            onSave={saveEdit}
            onCancel={cancelEdit}
            saving={isSaving}
            autoFocusTerm
          />
        ) : (
          <>
            {/* Main meaning */}
            {displayItem.translation && (
              <div>
                <SectionLabel>Meaning</SectionLabel>
                <p className="mt-1 text-xl font-semibold text-[var(--text)]">{displayItem.translation}</p>
              </div>
            )}

            {/* Learning pattern — first-class, not tucked into More details */}
            {highlightMeta.learningPattern && (
              <div className="rounded-lg border border-[var(--accent-border)] bg-[var(--accent-soft)] px-3 py-2">
                <SectionLabel>Pattern</SectionLabel>
                <p className="mt-1 font-mono text-sm text-[var(--text)]">{highlightMeta.learningPattern}</p>
              </div>
            )}

            {/* Context */}
            {displayItem.sentence_context && (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <SectionLabel>Sentence {displayItem.segment_index + 1}</SectionLabel>
                  <button
                    type="button"
                    onClick={() => onSeekToSegment(displayItem.segment_index)}
                    className="flex shrink-0 items-center gap-1 rounded-lg border border-[var(--border)] px-2 py-1 text-[11px] font-semibold text-[var(--accent)] hover:border-[var(--accent-border)] hover:bg-[var(--accent-soft)]"
                  >
                    Jump to sentence <ArrowRight size={12} />
                  </button>
                </div>
                <p className="text-sm leading-relaxed text-[var(--text)]">
                  {splitSentenceForHighlight(displayItem.sentence_context, displayItem.term).map((segment, idx) =>
                    segment.matched ? (
                      <mark
                        key={idx}
                        className="rounded bg-[var(--accent-soft)] px-0.5 text-[var(--accent)]"
                      >
                        {segment.text}
                      </mark>
                    ) : (
                      <span key={idx}>{segment.text}</span>
                    )
                  )}
                </p>
                {sentenceTranslation && (
                  <p className="text-sm text-[var(--text-muted)]">{sentenceTranslation}</p>
                )}
              </div>
            )}

            {/* More details */}
            {hasMoreDetails && (
              <details className="group rounded-lg border border-[var(--border)] px-3 py-2">
                <summary className="cursor-pointer list-none text-xs font-semibold text-[var(--text-muted)] marker:content-none">
                  More details
                </summary>
                <div className="mt-2 flex flex-col gap-2">
                  {displayItem.image_url && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={displayItem.image_url}
                      alt=""
                      className="max-h-40 w-full rounded-lg object-cover"
                    />
                  )}
                  {moreDetails.map((entry) => (
                    <div key={entry.label}>
                      <SectionLabel>{entry.label}</SectionLabel>
                      <p className="mt-0.5 whitespace-pre-wrap text-sm text-[var(--text)]">{entry.value}</p>
                    </div>
                  ))}
                </div>
              </details>
            )}

            {/* Delete */}
            <button
              type="button"
              onClick={handleDelete}
              disabled={isDeleting}
              className={clsx(
                "mt-1 flex items-center gap-1.5 self-start rounded-lg px-2.5 py-1.5 text-xs font-semibold",
                "text-[var(--red)] hover:bg-[var(--red)]/10 disabled:opacity-40"
              )}
            >
              <Trash2 size={13} /> {isDeleting ? "Removing…" : "Delete from vocabulary"}
            </button>
          </>
        )}
      </div>
    </ReportDialogShell>
  );
}
