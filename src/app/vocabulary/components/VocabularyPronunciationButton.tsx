"use client";

import { clsx } from "clsx";
import { Volume2 } from "lucide-react";
import { usePronunciationPlayback } from "@/hooks/usePronunciationPlayback";
import type { VocabularyItem } from "@/lib/types";

/** Speaker button shared by VocabularyCard and VocabularyDetailDrawer — mirrors
 *  the dictation page's own PronunciationButton (see VocabularyDetailDialog.tsx)
 *  but styled for this page's Tailwind slate palette rather than the dictation
 *  route's CSS-variable theme; both share the same usePronunciationPlayback
 *  state machine. `relative z-10` lifts it above VocabularyCard's stretched
 *  "open details" button so it stays independently clickable — see
 *  VocabularyCard.tsx. */
export function VocabularyPronunciationButton({ item }: { item: VocabularyItem }) {
  const { status, errorMessage, toggle, canRecoverWithGenerated, requestGeneratedAlternative } = usePronunciationPlayback({
    itemId: item.id,
    knownAudioUrl: item.audio_url,
    term: item.term,
    canonicalForm: item.canonical_form,
  });

  const label =
    status === "playing"
      ? `Stop pronunciation for ${item.term}`
      : status === "ready"
      ? `Tap to play pronunciation for ${item.term}`
      : `Play pronunciation for ${item.term}`;

  return (
    <span className="relative z-10 inline-flex items-center gap-1">
      <button
        type="button"
        onClick={toggle}
        aria-label={label}
        className={clsx(
          "rounded-md border p-1 shadow-sm transition-colors",
          status === "playing" || status === "ready"
            ? "border-primary-200 bg-primary-50 text-primary-600"
            : "border-white/40 bg-white/50 text-slate-400 hover:text-primary-500"
        )}
      >
        {status === "loading" ? (
          <span className="block h-3.5 w-3.5 animate-spin rounded-full border-2 border-slate-300 border-t-primary-500" />
        ) : (
          <Volume2 size={14} />
        )}
      </button>
      {status === "error" && (
        <span role="status" className="flex items-center gap-1.5 text-[11px] text-red-500">
          {errorMessage ?? "Couldn't play pronunciation."}
          {canRecoverWithGenerated && (
            <button
              type="button"
              onClick={requestGeneratedAlternative}
              className="font-semibold text-primary-600 underline hover:text-primary-700"
            >
              Use generated pronunciation
            </button>
          )}
        </span>
      )}
    </span>
  );
}
