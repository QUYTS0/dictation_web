import { useEffect, useRef, useState, type ReactNode } from "react";
import { clsx } from "clsx";
import { Ellipsis, ImageOff, Pencil, Trash2, Volume2 } from "lucide-react";
import { VocabularyEditForm } from "@/components/VocabularyEditForm";
import { usePronunciationPlayback } from "@/hooks/usePronunciationPlayback";
import { canonicalFormDiffersFromSurface } from "@/lib/utils/vocabulary";
import type { VocabularyAudioSource } from "@/lib/types";
import { ReportDialogShell } from "./ReportDialogShell";
import { VocabularyImageLightbox } from "./VocabularyImageLightbox";
import { splitSentenceForHighlight, type VocabularyHighlightMeta } from "../helpers";
import type { LessonSavedItem } from "../types";

type ImageLoadState = "loading" | "loaded" | "error";

/** Prefers the full-size image over the list's compact thumbnail — the
 *  detail window has room to show it larger — but falls back to the
 *  thumbnail for any row that somehow only has one of the two (both are
 *  normally saved together, see lookupWordImage in src/lib/image.ts, but
 *  nothing in the schema *guarantees* it for older/edited rows). Returns
 *  null only when neither field has anything to show. Also what the
 *  enlarged view uses — there is no separate higher-resolution field in the
 *  current image data (Openverse doesn't give us one), so "full size" here
 *  really is the largest version this app has. */
function resolveVocabularyImageSrc(item: Pick<LessonSavedItem, "image_url" | "image_thumbnail_url">): string | null {
  return item.image_url ?? item.image_thumbnail_url ?? null;
}

function capitalize(text: string): string {
  return text.length > 0 ? text[0].toUpperCase() + text.slice(1) : text;
}

/**
 * Registers a capture-phase Escape handler that stops the keypress from
 * ever reaching other (bubble-phase) listeners — specifically
 * ReportDialogShell's own Escape handler on the parent vocabulary dialog.
 * Without this, a single Escape press while this menu is open would close
 * both the menu AND the dialog underneath it; capture phase always runs
 * before bubble phase for the same event, so stopImmediatePropagation here
 * reliably wins regardless of listener registration order.
 */
function useTopmostEscape(active: boolean, onEscape: () => void) {
  useEffect(() => {
    if (!active) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onEscape();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [active, onEscape]);
}

/** The "⋯" overflow menu — currently just Delete, kept in its own small
 *  component so the destructive action isn't sitting right next to Edit
 *  where a mis-tap is easy. Hand-rolled (open state + outside-click +
 *  Escape) rather than a shared menu primitive: none exists in this
 *  codebase yet (every popover here — WordMatchInfoPopover,
 *  MetricInfoPopover, the script-selection popover — follows this same
 *  local pattern), so this matches existing convention rather than
 *  introducing a new one for a single menu item. */
function MoreActionsMenu({
  onDelete,
  deleting,
}: {
  onDelete: () => void;
  deleting: boolean;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };
  useTopmostEscape(open, close);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener("mousedown", handlePointerDown);
    return () => window.removeEventListener("mousedown", handlePointerDown);
  }, [open]);

  return (
    <div className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More vocabulary actions"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--accent-border)] hover:text-[var(--accent)]"
      >
        <Ellipsis size={16} />
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Vocabulary actions"
          className="absolute right-0 top-[calc(100%+4px)] z-10 w-48 max-w-[calc(100vw-2.5rem)] overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)] py-1 shadow-2xl"
        >
          <button
            type="button"
            role="menuitem"
            disabled={deleting}
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-semibold text-[var(--red)] hover:bg-[var(--red)]/10 disabled:opacity-40"
          >
            <Trash2 size={13} /> {deleting ? "Removing…" : "Delete from vocabulary"}
          </button>
        </div>
      )}
    </div>
  );
}

/** Speaker button near the heading that plays a pronunciation clip — either
 *  the dictionary-sourced audio for a single word with one (item.audio_url,
 *  see lookupWordDetails in src/lib/dictionary.ts) or, for anything else
 *  (a word with no dictionary audio, or any phrase — dictionary lookup
 *  never applies to phrases), an on-demand Azure TTS clip resolved via
 *  POST /api/vocabulary/pronounce on first tap. Always rendered now: every
 *  saved item is a pronunciation candidate. Never autoplays — `play()` only
 *  ever runs inside a click handler, satisfying iOS's synchronous-gesture
 *  requirement; a freshly-resolved (not-yet-played) clip surfaces a
 *  distinct "ready" affordance instead of playing itself, since the
 *  `await fetch` that resolved it already broke that gesture chain. */
function PronunciationButton({
  itemId,
  audioUrl,
  term,
  canonicalForm,
  active,
  onSourceResolved,
}: {
  itemId: string;
  audioUrl: string | null;
  term: string;
  /** The item's currently-resolved canonical form (persisted or, for a
   *  legacy row, the live highlight-cache fallback) — passed through so the
   *  hook can detect an in-place edit (same itemId, different text) and
   *  discard any stale resolved/in-flight audio for the old text. Never
   *  sent to the server. */
  canonicalForm?: string | null;
  active: boolean;
  onSourceResolved?: (source: VocabularyAudioSource) => void;
}) {
  const { status, errorMessage, toggle, canRecoverWithGenerated, requestGeneratedAlternative } = usePronunciationPlayback({
    itemId,
    knownAudioUrl: audioUrl,
    term,
    canonicalForm,
    active,
    onResolved: onSourceResolved,
  });

  const label =
    status === "playing"
      ? `Stop pronunciation of "${term}"`
      : status === "ready"
      ? `Tap to play pronunciation of "${term}"`
      : `Play pronunciation of "${term}"`;

  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        onClick={toggle}
        aria-label={label}
        className={clsx(
          "flex h-7 w-7 items-center justify-center rounded-full border transition-colors",
          status === "playing" || status === "ready"
            ? "border-[var(--accent-border)] bg-[var(--accent-soft)] text-[var(--accent)]"
            : "border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--accent-border)] hover:text-[var(--accent)]"
        )}
      >
        {status === "loading" ? (
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-[var(--border)] border-t-[var(--accent)]" />
        ) : (
          <Volume2 size={14} />
        )}
      </button>
      {status === "ready" && <span className="text-[11px] text-[var(--accent)]">Tap to play</span>}
      {status === "error" && (
        <span role="status" className="flex items-center gap-1.5 text-[11px] text-[var(--red)]">
          {errorMessage ?? "Couldn't play pronunciation."}
          {canRecoverWithGenerated && (
            <button
              type="button"
              onClick={requestGeneratedAlternative}
              className="font-semibold text-[var(--accent)] underline hover:brightness-110"
            >
              Use generated pronunciation
            </button>
          )}
        </span>
      )}
    </span>
  );
}

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
 *
 * Content order: term -> Vietnamese meaning -> image -> source sentence +
 * translation -> collapsed secondary metadata. ReportDialogShell's own
 * header bar still carries the accessible dialog title (small, for
 * aria-labelledby) — the large heading below is a second, purely visual
 * rendering of the same text, not a competing title.
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
  // Keyed to item identity, not to the image URL string, so switching to a
  // different item always resets to "loading" even if (edge case) it
  // happens to share the exact same image URL as the previous one — and so
  // a broken-image fallback shown for one item can never "stick" and
  // silently apply to the next item opened before its own <img> has fired
  // onLoad/onError.
  const [imageState, setImageState] = useState<ImageLoadState>("loading");
  // Bumped by the retry button to force the <img> to remount (a fresh
  // element re-issues the request even if the previous one's onerror had
  // already fired) without needing to mutate the URL itself.
  const [imageAttempt, setImageAttempt] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  // Set only when this item's pronunciation button actually resolves
  // through the Azure path (the dictionary-audio case never calls
  // onSourceResolved, since it plays directly with no network round trip)
  // — drives the "Synthesized voice" Details line below.
  const [audioSource, setAudioSource] = useState<VocabularyAudioSource | null>(null);
  const imageTriggerRef = useRef<HTMLButtonElement>(null);
  // Per-mount dedupe for the canonical-form backfill effect below — keyed
  // by item id + resolved values, not persisted, so a failed backfill is
  // simply re-attempted the next time this item is opened in a fresh mount.
  const backfilledKeysRef = useRef<Set<string>>(new Set());
  if (item && item !== lastItem) {
    setLastItem(item);
  }
  const currentItemId = item?.id ?? null;
  if (currentItemId !== trackedItemId) {
    setTrackedItemId(currentItemId);
    setEditing(false);
    setDraft(null);
    setImageState("loading");
    setImageAttempt(0);
    setLightboxOpen(false);
    setAudioSource(null);
  }
  const displayItem = item ?? lastItem;

  // Best-effort backfill: a legacy row (canonical_form persisted null) can
  // still resolve a canonicalForm/learningPattern via the live
  // highlight-cache fallback (see resolveVocabularyHighlightMeta in
  // helpers.ts) — that fallback is what the heading below already renders.
  // Left unpersisted, though, the server's pronunciation resolution (which
  // only ever trusts the persisted column, and deliberately never
  // re-derives from the client's session-local highlight cache) would
  // disagree with what's displayed. Silently catching the server up the
  // moment such a fallback is resolved keeps both in sync going forward,
  // without trusting any NEW client-supplied text — this is the exact same
  // pipeline-derived value the original save-time flow already trusts (see
  // previewMatchesSave in useLessonCapture.ts), just persisted late
  // instead of at save time. Backfill-only: the PATCH route applies it
  // only when canonical_form is still null, never overwriting a verified
  // value, so a redundant or failed call here is harmless.
  useEffect(() => {
    if (!item) return; // only the actually-open item, not the lingering lastItem during close
    if (item.canonical_form) return;
    if (!highlightMeta.canonicalForm && !highlightMeta.learningPattern) return;
    const key = `${item.id}::${highlightMeta.canonicalForm ?? ""}::${highlightMeta.learningPattern ?? ""}`;
    if (backfilledKeysRef.current.has(key)) return;
    backfilledKeysRef.current.add(key);
    void fetch("/api/vocabulary", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: item.id,
        canonicalForm: highlightMeta.canonicalForm,
        learningPattern: highlightMeta.learningPattern,
      }),
    }).catch(() => {
      // Best-effort — a failed backfill just means the fallback keeps
      // being used this session; retried the next time this item is
      // opened in a fresh mount (backfilledKeysRef isn't persisted).
    });
  }, [item, highlightMeta.canonicalForm, highlightMeta.learningPattern]);

  if (!displayItem) return null;

  const isSaving = updatingId === displayItem.id;
  const isDeleting = deletingId === displayItem.id;
  // Canonical-form-as-primary-title, surface term as an "In this sentence:"
  // secondary line, matches the convention already established by the
  // click-to-save popover, hover tooltip, and the Sentences tab's saved-item
  // cards (see canonicalFormDiffersFromSurface's other call sites) — kept
  // consistent here rather than inventing a different "Dictionary form:"
  // treatment for just this dialog. canonicalFormDiffersFromSurface is the
  // one existing "is this verified enough to show" gate — there's no
  // separate confidence score anywhere upstream, so falling back to the
  // surface term whenever it returns false already IS "fall back when
  // uncertain".
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

  const imageSrc = resolveVocabularyImageSrc(displayItem);
  // Selection-type badge ("Word"/"Phrase") vs. grammatical classification:
  // part_of_speech is real dictionary data (single words only — see
  // lookupWordDetails) and, when present, is strictly more useful than the
  // generic "Word" label, so it replaces it rather than adding a second,
  // redundant badge. Phrases never get a grammatical label here — the
  // vocab-highlight pipeline does compute an internal phrasal_verb/idiom/
  // multiword_expression/topic_phrase classification, but that's
  // documented (src/lib/vocabHighlights/types.ts) as never crossing into
  // the public API — several of those internal buckets (e.g.
  // "topic_phrase") aren't real grammatical categories a learner should
  // see, so guessing a label from it would violate "omit rather than
  // guess". "Phrase" stays a plain, honest selection-type badge.
  const typeBadgeLabel =
    displayItem.type === "word" && displayItem.part_of_speech
      ? capitalize(displayItem.part_of_speech)
      : displayItem.type === "word"
      ? "Word"
      : "Phrase";
  const definitionValue = displayItem.definition;
  const noteValue = displayItem.note;

  return (
    <>
      <ReportDialogShell
        open={Boolean(item)}
        onClose={onClose}
        titleId="vocabulary-detail-title"
        title={dialogTitle}
        size="compact"
      >
        <div className="flex flex-col gap-4">
          {/* Heading — the actual prominent, wrapping term/phrase. The
              small text in ReportDialogShell's own header bar (same string)
              stays there purely to carry the dialog's accessible name via
              aria-labelledby; this is what the user actually reads. */}
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              {/* A styled paragraph, not an <h1> — ReportDialogShell's own
                  header <h2> (same text, via aria-labelledby) is already
                  this dialog's one accessible heading; a second, deeper-
                  than-its-parent heading here would invert the document's
                  heading order for no benefit. */}
              <p className="break-words text-[22px] font-bold leading-tight text-[var(--text)] sm:text-[26px]">
                {dialogTitle}
              </p>
              {hasDifferentCanonicalForm && (
                <p className="mt-1 text-xs text-[var(--text-faint)]">In this sentence: {displayItem.term}</p>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="shrink-0 rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--accent)]">
                  {typeBadgeLabel}
                </span>
                {displayItem.phonetic && (
                  <span className="font-mono text-sm text-[var(--text-muted)]">{displayItem.phonetic}</span>
                )}
                {/* Always rendered now — every saved item (word or phrase)
                    is a pronunciation candidate, via dictionary audio when
                    known or on-demand Azure synthesis otherwise. Keyed by
                    item id so switching items always unmounts the previous
                    button (stopping any in-flight playback/fetch via its
                    own cleanup effect) instead of reusing the same instance
                    with stale state pointed at the old item. */}
                <PronunciationButton
                  key={displayItem.id}
                  itemId={displayItem.id}
                  audioUrl={displayItem.audio_url}
                  term={displayItem.term}
                  canonicalForm={highlightMeta.canonicalForm}
                  active={Boolean(item)}
                  onSourceResolved={setAudioSource}
                />
              </div>
            </div>
            {!editing && (
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  onClick={beginEdit}
                  className="flex shrink-0 items-center gap-1 rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs font-semibold text-[var(--text-muted)] hover:border-[var(--accent-border)] hover:text-[var(--accent)]"
                >
                  <Pencil size={13} /> Edit
                </button>
                <MoreActionsMenu onDelete={handleDelete} deleting={isDeleting} />
              </div>
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
              {/* Meaning */}
              {displayItem.translation && (
                <div>
                  <SectionLabel>Meaning</SectionLabel>
                  <p className="mt-1 text-xl font-semibold text-[var(--text)]">{displayItem.translation}</p>
                </div>
              )}

              {/* Learning pattern — first-class and right by the meaning,
                  never forced onto an item that doesn't have one (a plain
                  noun phrase like "curb extension" has no pattern). */}
              {highlightMeta.learningPattern && (
                <div className="rounded-lg border border-[var(--accent-border)] bg-[var(--accent-soft)] px-3 py-2">
                  <SectionLabel>Pattern</SectionLabel>
                  <p className="mt-1 font-mono text-sm text-[var(--text)]">{highlightMeta.learningPattern}</p>
                </div>
              )}

              {/* Image — compact and centered, sized to the image itself
                  (capped) rather than a full-width frame with empty side
                  bars. Click/tap enlarges via VocabularyImageLightbox.
                  Collapses entirely when there's no image. */}
              {imageSrc && (
                <div className="flex justify-center">
                  {imageState === "error" ? (
                    // A plain box, not the enlarge-trigger button below — an
                    // image that failed to load has nothing worth enlarging,
                    // and nesting the Retry button inside that trigger would
                    // mean one interactive control inside another.
                    <div className="flex h-32 w-32 flex-col items-center justify-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 text-center">
                      <ImageOff size={20} className="text-[var(--text-faint)]" aria-hidden="true" />
                      <p className="text-[11px] text-[var(--text-muted)]">Image failed to load.</p>
                      <button
                        type="button"
                        onClick={() => {
                          setImageState("loading");
                          setImageAttempt((n) => n + 1);
                        }}
                        className="text-[11px] font-semibold text-[var(--accent)] underline hover:brightness-110"
                      >
                        Retry
                      </button>
                    </div>
                  ) : (
                    <button
                      ref={imageTriggerRef}
                      type="button"
                      disabled={imageState !== "loaded"}
                      onClick={() => setLightboxOpen(true)}
                      aria-label={`Enlarge image for "${displayItem.term}"`}
                      className={clsx(
                        "overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface-2)]",
                        imageState === "loaded" && "cursor-zoom-in"
                      )}
                    >
                      {imageState === "loading" && (
                        <div className="flex h-32 w-32 items-center justify-center" aria-hidden="true">
                          <div className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--border)] border-t-[var(--accent)]" />
                        </div>
                      )}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        key={`${displayItem.id}-${imageAttempt}`}
                        src={imageSrc}
                        alt=""
                        className={clsx(
                          "block max-h-56 max-w-[min(20rem,80vw)] object-contain sm:max-h-64",
                          imageState === "loading" && "hidden"
                        )}
                        onLoad={() => setImageState("loaded")}
                        onError={() => setImageState("error")}
                      />
                    </button>
                  )}
                </div>
              )}

              {/* Source sentence + translation */}
              {displayItem.sentence_context && (
                <div className="flex flex-col gap-1.5">
                  <p className="text-base leading-relaxed text-[var(--text)]">
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
                    <p className="text-base text-[var(--text-muted)]">{sentenceTranslation}</p>
                  )}
                  <div className="flex items-center gap-1 text-[11px] text-[var(--text-faint)]">
                    <span>Sentence {displayItem.segment_index + 1}</span>
                    <span aria-hidden="true">·</span>
                    <button
                      type="button"
                      onClick={() => onSeekToSegment(displayItem.segment_index)}
                      className="font-semibold text-[var(--accent)] hover:underline"
                    >
                      View in video
                    </button>
                  </div>
                </div>
              )}

              {/* Secondary/administrative metadata — collapsed since none of
                  it is needed to understand or study the word itself. */}
              <details className="group rounded-lg border border-[var(--border)] px-3 py-2">
                <summary className="cursor-pointer list-none text-xs font-semibold text-[var(--text-muted)] marker:content-none">
                  Details
                </summary>
                <div className="mt-2 flex flex-col gap-2">
                  <div>
                    <SectionLabel>Saved</SectionLabel>
                    <p className="mt-0.5 text-sm text-[var(--text)]">
                      {new Date(displayItem.created_at).toLocaleDateString()}
                    </p>
                  </div>
                  {definitionValue && (
                    <div>
                      <SectionLabel>Definition</SectionLabel>
                      <p className="mt-0.5 whitespace-pre-wrap text-sm text-[var(--text)]">{definitionValue}</p>
                    </div>
                  )}
                  {noteValue && (
                    <div>
                      <SectionLabel>Note</SectionLabel>
                      <p className="mt-0.5 whitespace-pre-wrap text-sm text-[var(--text)]">{noteValue}</p>
                    </div>
                  )}
                  {(audioSource === "cached" || audioSource === "synthesized") && (
                    // No dialect claim beyond "generic US English" unless
                    // explicitly known — the default voice is a generic US
                    // English neural voice, never an invented "UK"/"AU" label.
                    <div>
                      <SectionLabel>Pronunciation</SectionLabel>
                      <p className="mt-0.5 text-sm text-[var(--text)]">Synthesized voice</p>
                    </div>
                  )}
                </div>
              </details>
            </>
          )}
        </div>
      </ReportDialogShell>

      {lightboxOpen && imageSrc && (
        <VocabularyImageLightbox
          src={imageSrc}
          alt={displayItem.term}
          onClose={() => {
            setLightboxOpen(false);
            imageTriggerRef.current?.focus();
          }}
        />
      )}
    </>
  );
}
