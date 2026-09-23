"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Download, FileText, Captions, FileType, Loader2, AlertCircle } from "lucide-react";
import {
  TRANSCRIPT_EXPORT_FORMATS,
  buildTranscriptTxt,
  buildTranscriptSrt,
  buildExportFilename,
  type TranscriptExportFormat,
  type ExportableSegment,
} from "@/lib/utils/transcriptExport";
import { downloadBlob } from "@/lib/utils/download";

const FORMAT_ICON: Record<TranscriptExportFormat, typeof FileText> = {
  txt: FileText,
  srt: Captions,
  pdf: FileType,
};

interface TranscriptDownloadMenuProps {
  /** The full segment list of the transcript revision currently displayed
   *  (never a virtualized/visible-only subset, and never re-fetched here —
   *  see useDictationSession's `segments`, already resolved to the pinned
   *  revision for an existing session or the current one otherwise). */
  segments: ExportableSegment[];
  videoId: string;
  title: string | null | undefined;
  /** The revision's real version number, when the caller has it — never
   *  fabricated when absent. */
  version: number | null | undefined;
}

/**
 * Replaces the previous single-click "download .txt" button with a small
 * format-selection menu (TXT/SRT/PDF). Every export reads only from the
 * `segments`/`title`/`videoId`/`version` props already captured at click
 * time — it never fetches, never touches translation/vocab-highlight
 * state, and never issues any player/session command, so opening the menu
 * or downloading a file can't seek, play, pause, restart, or reset the
 * lesson.
 */
export function TranscriptDownloadMenu({ segments, videoId, title, version }: TranscriptDownloadMenuProps) {
  const [open, setOpen] = useState(false);
  const [preparing, setPreparing] = useState<TranscriptExportFormat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const hasTranscript = segments.length > 0;

  const closeMenu = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    // Move focus onto the first item as soon as the menu opens, matching
    // standard menu-button behavior.
    itemRefs.current[0]?.focus();

    const handlePointerDown = (event: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        closeMenu(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu(true);
    };
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [open, closeMenu]);

  const handleMenuKeyDown = useCallback((event: React.KeyboardEvent) => {
    const items = itemRefs.current.filter((el): el is HTMLButtonElement => el !== null);
    if (items.length === 0) return;
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      items[(currentIndex + 1) % items.length]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      items[(currentIndex - 1 + items.length) % items.length]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      items[items.length - 1]?.focus();
    }
  }, []);

  const handleSelectFormat = useCallback(
    async (format: TranscriptExportFormat) => {
      if (preparing) return; // a download is already in progress — ignore duplicate activations
      // Snapshot the exact revision being viewed at the moment of
      // selection — every field this function reads from here on is a
      // local copy, never re-read from props mid-export, so a
      // regeneration that publishes a different revision while a (slow,
      // e.g. PDF) export is in flight can't change what gets downloaded.
      const snapshotSegments = segments;
      const snapshotTitle = title ?? null;
      const snapshotVideoId = videoId;
      const snapshotVersion = version ?? null;

      setPreparing(format);
      setError(null);
      try {
        const filename = buildExportFilename(format, { title: snapshotTitle, videoId: snapshotVideoId, version: snapshotVersion });
        const meta = TRANSCRIPT_EXPORT_FORMATS.find((f) => f.format === format);
        if (!meta) throw new Error("Unknown export format.");

        if (format === "txt") {
          downloadBlob(buildTranscriptTxt(snapshotSegments), meta.mimeType, filename);
        } else if (format === "srt") {
          downloadBlob(buildTranscriptSrt(snapshotSegments), meta.mimeType, filename);
        } else {
          // Loaded on demand so pdf-lib/fontkit and the embedded font
          // assets never ship with the initial lesson bundle.
          const { generateTranscriptPdf } = await import("@/lib/utils/transcriptPdf");
          const pdfBytes = await generateTranscriptPdf({
            title: snapshotTitle,
            videoId: snapshotVideoId,
            version: snapshotVersion,
            segments: snapshotSegments,
          });
          downloadBlob(new Blob([new Uint8Array(pdfBytes)], { type: meta.mimeType }), meta.mimeType, filename);
        }
        closeMenu(true);
      } catch (err) {
        // Keep the menu open so the error is visible next to the option
        // the user can retry — a plain click on the same item tries again.
        setError(err instanceof Error ? err.message : "Failed to prepare the download. Please try again.");
      } finally {
        setPreparing(null);
      }
    },
    [preparing, segments, title, videoId, version, closeMenu]
  );

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        onClick={() => setOpen((v) => !v)}
        disabled={!hasTranscript}
        className="hidden h-8 w-8 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface-glass)] text-[var(--text-muted)] transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40 md:flex"
        title="Download transcript"
        aria-label="Download transcript"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Download size={15} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.97 }}
            transition={{ duration: 0.12 }}
            role="menu"
            aria-label="Download transcript as"
            onKeyDown={handleMenuKeyDown}
            className="absolute right-0 top-full z-50 mt-2 w-[220px] max-w-[calc(100vw-2rem)] rounded-2xl border border-[var(--border-strong)] bg-[var(--surface)] p-1.5 shadow-2xl"
          >
            <p className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-faint)]">
              Download transcript
            </p>
            {TRANSCRIPT_EXPORT_FORMATS.map((fmt, i) => {
              const Icon = FORMAT_ICON[fmt.format];
              const isPreparing = preparing === fmt.format;
              return (
                <button
                  key={fmt.format}
                  ref={(el) => {
                    itemRefs.current[i] = el;
                  }}
                  role="menuitem"
                  disabled={preparing !== null}
                  onClick={() => void handleSelectFormat(fmt.format)}
                  className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm text-[var(--text)] transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isPreparing ? (
                    <Loader2 size={16} className="shrink-0 animate-spin text-[var(--text-muted)]" />
                  ) : (
                    <Icon size={16} className="shrink-0 text-[var(--text-muted)]" />
                  )}
                  <span className="flex-1">{fmt.label}</span>
                  <span className="text-xs text-[var(--text-faint)]">{fmt.description}</span>
                </button>
              );
            })}
            {error && (
              <div className="mt-1 flex items-start gap-1.5 rounded-xl bg-[var(--red)]/10 px-2.5 py-2 text-xs text-[var(--red)]">
                <AlertCircle size={14} className="mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
