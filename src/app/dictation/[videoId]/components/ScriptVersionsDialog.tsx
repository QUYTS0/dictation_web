"use client";

import { useEffect, useRef, useState } from "react";
import { Eye, EyeOff, X } from "lucide-react";
import { useTranscriptVersionPreviewQuery, useTranscriptVersionsQuery } from "@/lib/queries/transcriptVersions";
import type { RetentionReason, TranscriptVersion } from "@/lib/types/learning";

const SOURCE_LABEL: Record<TranscriptVersion["source"], string> = {
  cache: "YouTube captions",
  ai: "Generated from audio",
  manual: "Pasted or uploaded",
};

const REASON_LABEL: Record<RetentionReason, string> = {
  current: "the current script",
  processing: "still being generated",
  practice_round: "a practice round uses it",
  attempts: "saved answers or recordings use it",
  legacy_history: "it holds earlier (unverified) history",
  listening: "Listening progress uses it",
  legacy_listening: "earlier Listening history uses it",
  saved_words: "saved words or bookmarks exist for this video",
};

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const formatDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

/** Plain-language retention status — a classification, never "deletable now". */
export function retentionText(r: TranscriptVersion["retention"]): string {
  if (r.reasons.length > 0) {
    if (r.reasons.length === 1 && r.reasons[0] === "current") return "Kept — this is the current script.";
    const why = r.reasons.filter((x) => x !== "current").map((x) => REASON_LABEL[x]);
    return `Kept — ${(r.reasons.includes("current") ? [REASON_LABEL.current, ...why] : why).join("; ")}.`;
  }
  if (r.inGracePeriod && r.eligibleAt) return `Kept until ${formatDate(r.eligibleAt)} (recently replaced).`;
  if (r.cleanupCandidate && r.eligibleAt) return `Eligible for cleanup since ${formatDate(r.eligibleAt)} — cleanup is not enabled.`;
  return "Kept.";
}

function VersionRow({
  version,
  onScreen,
  previewOpen,
  onTogglePreview,
  children,
}: {
  version: TranscriptVersion;
  onScreen: boolean;
  previewOpen: boolean;
  onTogglePreview: () => void;
  children?: React.ReactNode;
}) {
  const s = version.size;
  return (
    <li className="flex flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3" data-testid={`script-version-${version.version}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-[var(--text)]">Version {version.version}</span>
        {version.isCurrent && (
          <span className="rounded-full bg-[var(--green)]/15 px-2 py-0.5 text-[11px] font-semibold text-[var(--green)]">Current</span>
        )}
        {onScreen && (
          <span className="rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[11px] font-semibold text-[var(--accent)]">Showing now</span>
        )}
        {version.yourRound && (
          <span className="rounded-full border border-[var(--border)] px-2 py-0.5 text-[11px] font-semibold text-[var(--text-muted)]">
            Used by your round {version.yourRound.roundNumber}
            {version.yourRound.status === "active" ? " (in progress)" : version.yourRound.status === "completed" ? " (completed)" : ""}
          </span>
        )}
        {version.status !== "ready" && (
          <span className="rounded-full bg-[var(--red)]/15 px-2 py-0.5 text-[11px] font-semibold text-[var(--red)]">
            {version.status === "processing" ? "Generating" : "Failed"}
          </span>
        )}
      </div>
      <p className="text-xs text-[var(--text-muted)]">
        {formatDate(version.createdAt)} · {SOURCE_LABEL[version.source] ?? version.source} · {version.sentenceCount} sentence
        {version.sentenceCount === 1 ? "" : "s"}
      </p>
      <p className="text-xs text-[var(--text)]" data-testid="script-version-retention">
        {retentionText(version.retention)}
      </p>
      <details className="text-xs text-[var(--text-muted)]">
        <summary className="cursor-pointer select-none">Estimated storage: {formatBytes(s.totalBytes)}</summary>
        <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5">
          <dt>Script text</dt>
          <dd>{formatBytes(s.textBytes)}</dd>
          <dt>Sentences</dt>
          <dd>{formatBytes(s.segmentsBytes)}</dd>
          <dt>Translations</dt>
          <dd>{formatBytes(s.translationsBytes)}</dd>
          <dt>Word highlights</dt>
          <dd>{formatBytes(s.highlightsBytes)}</dd>
          <dt>Files</dt>
          <dd>{formatBytes(s.filesBytes)}</dd>
        </dl>
        <p className="mt-1">
          An estimate of this version&apos;s stored rows — not disk usage, and not what removing it would free.
          {version.retention.cleanupCandidate ? ` Eligible for removal: ${formatBytes(version.eligibleForRemovalBytes)}.` : ""}
        </p>
      </details>
      {version.status !== "processing" && (
        <button
          type="button"
          onClick={onTogglePreview}
          aria-expanded={previewOpen}
          className="inline-flex items-center gap-1.5 self-start rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs font-semibold text-[var(--text)] hover:bg-white/10"
        >
          {previewOpen ? <EyeOff size={13} /> : <Eye size={13} />} {previewOpen ? "Hide preview" : `Preview version ${version.version}`}
        </button>
      )}
      {children}
    </li>
  );
}

function Preview({ videoId, transcriptId }: { videoId: string; transcriptId: string }) {
  const preview = useTranscriptVersionPreviewQuery(videoId, transcriptId);
  if (preview.isError) return <p className="text-xs text-[var(--red)]">Couldn&apos;t load this version.</p>;
  if (!preview.data) return <p className="text-xs text-[var(--text-muted)]">Loading preview…</p>;
  return (
    <ol className="flex max-h-60 flex-col gap-1 overflow-y-auto rounded-lg border border-[var(--border)] p-2 text-xs" aria-label={`Version ${preview.data.version} preview`}>
      {preview.data.segments.map((s) => (
        <li key={s.segmentIndex} className="text-[var(--text)]">
          <span className="mr-1.5 text-[var(--text-faint)]">{s.segmentIndex + 1}.</span>
          {s.text}
        </li>
      ))}
    </ol>
  );
}

/**
 * Script Versions (Phase 9, plan §10.7): every revision of this video's
 * script — current badge, the version on screen, YOUR round's version,
 * sentence count, size estimate and why each is kept — with a read-only
 * preview. Nothing here changes which version is current or what your
 * round uses, and there is no delete action for anyone in v1 (deletion is
 * disabled for every video at the database).
 */
export function ScriptVersionsDialog({
  open,
  onClose,
  userId,
  videoId,
  onScreenTranscriptId,
}: {
  open: boolean;
  onClose: () => void;
  userId: string | undefined;
  videoId: string;
  onScreenTranscriptId: string | null;
}) {
  const query = useTranscriptVersionsQuery(userId, videoId, open);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // Mounted fresh on each opening (the page renders it only while open),
    // so no preview stays expanded from a previous visit.
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  const revisions = query.data?.revisions ?? [];

  return (
    <div className="fixed inset-0 z-[90] flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="script-versions-title"
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85svh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl border border-[var(--border-strong)] bg-[var(--surface)] text-[var(--text)] shadow-xl sm:rounded-2xl"
      >
        <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
          <h2 id="script-versions-title" className="text-sm font-semibold">
            Script versions
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close script versions"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-white/10"
          >
            <X size={16} />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
          <p className="text-xs text-[var(--text-muted)]">
            Each time this video&apos;s script is regenerated or replaced, a new version is kept. Your rounds keep the version they started with.
            Old versions are never removed while anything uses them.
          </p>
          {query.isError ? (
            <p className="text-sm text-[var(--red)]" role="alert">
              Couldn&apos;t load script versions.{" "}
              <button type="button" onClick={() => query.refetch()} className="font-semibold underline">
                Retry
              </button>
            </p>
          ) : !query.data ? (
            <p className="text-sm text-[var(--text-muted)]">Loading script versions…</p>
          ) : revisions.length === 0 ? (
            <p className="text-sm text-[var(--text-muted)]">This video has no script yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {revisions.map((v) => (
                <VersionRow
                  key={v.transcriptId}
                  version={v}
                  onScreen={v.transcriptId === onScreenTranscriptId}
                  previewOpen={previewId === v.transcriptId}
                  onTogglePreview={() => setPreviewId((id) => (id === v.transcriptId ? null : v.transcriptId))}
                >
                  {previewId === v.transcriptId && <Preview videoId={videoId} transcriptId={v.transcriptId} />}
                </VersionRow>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
