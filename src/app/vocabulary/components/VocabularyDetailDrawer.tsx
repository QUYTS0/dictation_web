"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Pencil, Trash2, X } from "lucide-react";
import { VocabularyEditForm } from "@/components/VocabularyEditForm";
import { canonicalFormDiffersFromSurface } from "@/lib/utils/vocabulary";
import type { VocabularyItem } from "@/lib/types";
import { VocabularyPronunciationButton } from "./VocabularyPronunciationButton";
import { VocabularyStatusBadge } from "./VocabularyStatusBadge";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

/** ≥1024px (`lg`) matches the grid's own `lg:grid-cols-3` cutover — the
 *  point at which the page has room for a 3-column grid *and* a non-modal
 *  420px side panel without either becoming unusable. Below it the drawer
 *  is a real modal instead (see the plan's §B/§H). Drives backdrop
 *  presence, focus-trap activation, and aria-modal in lockstep with the
 *  CSS `lg:` breakpoint used for positioning below. */
function useIsDesktopViewport(): boolean {
  const [isDesktop, setIsDesktop] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(min-width: 1024px)").matches
  );

  useEffect(() => {
    const mql = window.matchMedia("(min-width: 1024px)");
    const handleChange = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mql.addEventListener("change", handleChange);
    return () => mql.removeEventListener("change", handleChange);
  }, []);

  return isDesktop;
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export interface VocabularyDetailDrawerProps {
  item: VocabularyItem | null;
  mode: "view" | "edit";
  onClose: () => void;
  onEdit: () => void;
  onDelete: (id: string) => void;
  isDeleting: boolean;
  isSaving: boolean;
  term: string;
  onTermChange: (value: string) => void;
  sentenceContext: string;
  onSentenceContextChange: (value: string) => void;
  translation: string;
  onTranslationChange: (value: string) => void;
  phonetic: string;
  onPhoneticChange: (value: string) => void;
  partOfSpeech: string;
  onPartOfSpeechChange: (value: string) => void;
  definition: string;
  onDefinitionChange: (value: string) => void;
  note: string;
  onNoteChange: (value: string) => void;
  onSave: () => void;
  onCancelEdit: () => void;
}

/**
 * Single shared detail view for the Vocabulary Bank, three presentation
 * tiers by breakpoint (all non-modal except the smallest):
 *  - `< lg`: full-screen/near-full-screen modal (backdrop + focus trap +
 *    aria-modal="true").
 *  - `lg`–`<xl`: floating overlay, `absolute`, scoped to the cards-viewport
 *    wrapper (not the whole app), no backdrop/trap.
 *  - `xl`+: docked — `position: static`, a real cell in the outer split-grid
 *    built in page.tsx (only present there when an item is selected). The
 *    `xl:` classes below don't just set position/inset/width for this tier —
 *    they also explicitly neutralize `lg:max-w-[calc(100%-2rem)]`
 *    (`xl:max-w-none`), which would otherwise still apply at `xl`+ (max-width
 *    isn't position-gated the way inset/z-index are) and clip the panel
 *    narrower than its actual grid-cell width, leaving an unwanted gap
 *    inside the cell instead of the panel filling it.
 * One component, one content tree — only position/sizing and modality
 * change by breakpoint. See the Vocabulary Bank width-system plan
 * §E/§F/§G for the full rationale.
 */
export function VocabularyDetailDrawer({
  item,
  mode,
  onClose,
  onEdit,
  onDelete,
  isDeleting,
  isSaving,
  term,
  onTermChange,
  sentenceContext,
  onSentenceContextChange,
  translation,
  onTranslationChange,
  phonetic,
  onPhoneticChange,
  partOfSpeech,
  onPartOfSpeechChange,
  definition,
  onDefinitionChange,
  note,
  onNoteChange,
  onSave,
  onCancelEdit,
}: VocabularyDetailDrawerProps) {
  const isDesktop = useIsDesktopViewport();
  const containerRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  // Escape closes at every breakpoint, in both view and edit mode.
  useEffect(() => {
    if (!item) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [item, onClose]);

  // Focus trap only applies to the modal (below-lg) presentation — the
  // desktop drawer is non-modal and must let Tab/Shift+Tab leave it.
  useEffect(() => {
    if (!item || isDesktop) return;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    const container = containerRef.current;
    const initialFocusable = container?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
    initialFocusable?.[0]?.focus();

    function handleTab(e: KeyboardEvent) {
      if (e.key !== "Tab" || !container) return;
      const nodes = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", handleTab);
    return () => {
      window.removeEventListener("keydown", handleTab);
      previousFocusRef.current?.focus();
    };
  }, [item, isDesktop]);

  if (!item) return null;

  const displayTerm = item.canonical_form ?? item.term;
  const sourceHref = `/dictation/${item.video_id}?segment=${item.segment_index}`;
  const lastReviewed = formatDate(item.last_reviewed_at);
  const nextReview = formatDate(item.next_review_at);

  return (
    <>
      {!isDesktop && (
        <div
          data-testid="vocab-drawer-backdrop"
          aria-hidden="true"
          onClick={onClose}
          className="fixed inset-0 z-[70] bg-black/50"
        />
      )}
      <div
        ref={containerRef}
        id="vocabulary-detail-drawer"
        role="dialog"
        aria-modal={isDesktop ? "false" : "true"}
        aria-label="Vocabulary details"
        className="fixed inset-0 z-[75] flex flex-col overflow-y-auto border border-white/60 bg-white/95 shadow-2xl backdrop-blur-xl sm:inset-6 sm:rounded-3xl lg:absolute lg:left-auto lg:right-4 lg:top-4 lg:bottom-4 lg:w-[420px] lg:max-w-[calc(100%-2rem)] lg:rounded-3xl xl:static xl:inset-auto xl:h-full xl:w-auto xl:max-w-none xl:min-h-0"
      >
        <div className="flex items-start justify-between gap-3 border-b border-white/40 p-5">
          <div className="flex min-w-0 items-start gap-3">
            {item.image_thumbnail_url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={item.image_thumbnail_url}
                alt=""
                className="h-16 w-16 shrink-0 rounded-2xl object-cover"
              />
            )}
            <div className="min-w-0">
              <h2 className="text-2xl font-bold text-slate-900">{displayTerm}</h2>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <VocabularyPronunciationButton item={item} />
                {item.phonetic && <span className="text-xs text-slate-500">{item.phonetic}</span>}
                {item.part_of_speech && (
                  <span className="rounded-full bg-primary-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-primary-700">
                    {item.part_of_speech}
                  </span>
                )}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close vocabulary details"
            className="shrink-0 rounded-xl border border-white/60 bg-white/50 p-2 transition-colors hover:bg-white/80"
          >
            <X size={16} className="text-slate-500" />
          </button>
        </div>

        <div className="flex-1 p-5">
          {mode === "edit" ? (
            <VocabularyEditForm
              term={term}
              onTermChange={onTermChange}
              sentenceContext={sentenceContext}
              onSentenceContextChange={onSentenceContextChange}
              translation={translation}
              onTranslationChange={onTranslationChange}
              phonetic={phonetic}
              onPhoneticChange={onPhoneticChange}
              partOfSpeech={partOfSpeech}
              onPartOfSpeechChange={onPartOfSpeechChange}
              definition={definition}
              onDefinitionChange={onDefinitionChange}
              note={note}
              onNoteChange={onNoteChange}
              onSave={onSave}
              onCancel={onCancelEdit}
              saving={isSaving}
              autoFocusTerm
            />
          ) : (
            <div className="flex flex-col gap-4">
              {item.translation ? (
                <p className="text-lg font-medium leading-relaxed text-slate-700">{item.translation}</p>
              ) : null}

              {item.definition ? (
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Definition</p>
                  <p className="text-sm leading-relaxed text-slate-600">{item.definition}</p>
                </div>
              ) : null}

              {item.learning_pattern ? (
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Pattern</p>
                  <p className="text-sm leading-relaxed text-slate-600">{item.learning_pattern}</p>
                </div>
              ) : null}

              {item.note ? (
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-500">📝 {item.note}</p>
              ) : null}

              {canonicalFormDiffersFromSurface(item.canonical_form, item.term) && (
                <p className="text-xs text-slate-400">In this sentence: {item.term}</p>
              )}

              <div className="rounded-xl border border-white/40 bg-white/30 p-3 shadow-inner">
                <p className="text-sm italic leading-relaxed text-slate-500">&quot;{item.sentence_context}&quot;</p>
              </div>

              <div className="flex items-center justify-between border-t border-white/40 pt-4">
                <div>
                  <p className="mb-1 text-[10px] font-bold uppercase tracking-widest text-slate-400">Status</p>
                  <VocabularyStatusBadge item={item} />
                </div>
                <div className="text-right text-xs text-slate-400">
                  {lastReviewed && <p>Last reviewed {lastReviewed}</p>}
                  {nextReview && <p>Next review {nextReview}</p>}
                </div>
              </div>

              <Link
                href={sourceHref}
                className="inline-block w-fit text-sm font-semibold text-primary-600 underline hover:text-primary-700"
              >
                ↗ Open source video
              </Link>
            </div>
          )}
        </div>

        {mode === "view" && (
          <div className="flex items-center gap-2 border-t border-white/40 p-5">
            <button
              type="button"
              onClick={onEdit}
              className="flex items-center gap-1.5 rounded-xl border border-white/60 bg-white/50 px-3 py-2 text-sm font-semibold text-slate-600 transition-colors hover:bg-white/80"
            >
              <Pencil size={14} />
              Edit
            </button>
            <button
              type="button"
              onClick={() => onDelete(item.id)}
              disabled={isDeleting}
              className="flex items-center gap-1.5 rounded-xl border border-white/60 bg-white/50 px-3 py-2 text-sm font-semibold text-slate-600 transition-colors hover:bg-red-50 disabled:opacity-40"
            >
              <Trash2 size={14} />
              {isDeleting ? "Removing…" : "Delete"}
            </button>
          </div>
        )}
      </div>
    </>
  );
}
