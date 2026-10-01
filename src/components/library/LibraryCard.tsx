"use client";

import Link from "next/link";
import { clsx } from "clsx";
import { Headphones, PlayCircle, Trash2 } from "lucide-react";
import type { LibraryItem } from "@/lib/types/learning";

const MODE_LABEL = { dictation: "Dictation", listening: "Listening", shadowing: "Shadowing" } as const;

/**
 * Where "Continue"/"Start" opens the video. Without `?mode=` the practice
 * page uses the server's saved last mode (cross-device resume); only a
 * Listening-only video that never had an explicit mode switch is opened in
 * Listening explicitly.
 */
export function libraryPracticeHref(item: LibraryItem): string {
  const listeningOnly = item.state === "listening" || item.state === "listening_prior_revision";
  if (!item.lastMode && listeningOnly) return `/dictation/${item.videoId}?mode=listening`;
  return `/dictation/${item.videoId}`;
}

/** Practice coverage of the card's round — never accuracy (plan §10.3). */
export function practiceCoverageText(item: LibraryItem): string | null {
  const p = item.round?.progress;
  if (!p || !p.requiredSentenceCount) return null;
  return `${p.coveredSentences.overall}/${p.requiredSentenceCount} sentences practiced`;
}

export function listeningText(item: LibraryItem): string | null {
  const l = item.listening;
  if (l.listenedThrough) return "Listened through";
  if (l.coverageRatio !== null && l.coverageRatio > 0) return `Listened ${Math.round(l.coverageRatio * 100)}%`;
  if (l.historyOnOtherRevision) return "Previously listened (script updated)";
  return null;
}

const STATE_BADGE: Record<LibraryItem["state"], { label: string; className: string }> = {
  not_started: { label: "Not started", className: "bg-slate-100 text-slate-600" },
  in_progress: { label: "In progress", className: "bg-primary-50 text-primary-600" },
  completed: { label: "Practice complete", className: "bg-emerald-50 text-emerald-600" },
  listening: { label: "Listening", className: "bg-sky-50 text-sky-700" },
  listening_prior_revision: { label: "Listening", className: "bg-sky-50 text-sky-700" },
};

export function LibraryCard({
  item,
  compact = false,
  onRemove,
}: {
  item: LibraryItem;
  compact?: boolean;
  onRemove?: (item: LibraryItem) => void;
}) {
  const coverage = practiceCoverageText(item);
  const listening = listeningText(item);
  const progress = item.round?.progress;
  const ratio = progress?.coverage.overall ?? null;
  const badge =
    item.state === "completed" && !item.hasCompletedRound && item.hasLegacyCompletion
      ? { label: "Completed earlier (unverified)", className: "bg-amber-50 text-amber-700" }
      : STATE_BADGE[item.state];
  const reviewRoundId = item.round?.status === "completed" ? item.round.roundId : null;
  const accuracy = progress?.sentenceAccuracy;

  return (
    <article
      data-testid={`library-card-${item.videoId}`}
      className={clsx(
        "group flex gap-4 rounded-3xl border border-white/60 bg-white/50 p-4 shadow-xl backdrop-blur-md",
        compact ? "flex-col sm:flex-row" : "flex-col"
      )}
    >
      <Link
        href={libraryPracticeHref(item)}
        className={clsx("relative aspect-video shrink-0 overflow-hidden rounded-xl bg-slate-800", compact ? "w-full sm:w-44" : "w-full")}
        aria-label={`Open ${item.title ?? item.videoId}`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`https://img.youtube.com/vi/${item.videoId}/hqdefault.jpg`}
          alt=""
          className="h-full w-full object-cover opacity-80 transition-opacity group-hover:opacity-100"
          loading="lazy"
        />
        <span className="absolute inset-0 flex items-center justify-center">
          <PlayCircle className="fill-white/20 text-white" size={28} />
        </span>
      </Link>

      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-start justify-between gap-2">
          <h3 className="line-clamp-2 font-semibold text-slate-900">{item.title ?? `Video ${item.videoId}`}</h3>
          {onRemove && (
            <button
              type="button"
              onClick={() => onRemove(item)}
              className="shrink-0 rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-white hover:text-red-600"
              aria-label={`Remove ${item.title ?? item.videoId} from your library`}
              title="Remove from library"
            >
              <Trash2 size={15} />
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-semibold">
          <span className={clsx("rounded-full px-2 py-0.5", badge.className)}>{badge.label}</span>
          {item.state === "in_progress" && item.hasCompletedRound && (
            <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-emerald-600">Completed before</span>
          )}
          {item.lastMode && <span className="rounded-full bg-purple-50 px-2 py-0.5 text-purple-600">{MODE_LABEL[item.lastMode]}</span>}
        </div>

        {coverage && (
          <div data-testid="library-coverage">
            <p className="text-xs text-slate-600">{coverage}</p>
            {ratio !== null && (
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-100" aria-hidden="true">
                <div className="h-full rounded-full bg-primary-500" style={{ width: `${Math.min(100, Math.max(0, ratio * 100))}%` }} />
              </div>
            )}
          </div>
        )}
        {accuracy && accuracy.practiced > 0 && item.state === "completed" && (
          <p className="text-xs text-slate-500" data-testid="library-accuracy">
            Sentence accuracy {Math.round((100 * accuracy.correct) / accuracy.practiced)}% ({accuracy.correct}/{accuracy.practiced} latest answers)
          </p>
        )}
        {listening && (
          <p className="flex items-center gap-1 text-xs text-sky-700" data-testid="library-listening">
            <Headphones size={12} /> {listening}
          </p>
        )}
        <p className="text-[11px] text-slate-400">
          {item.state === "not_started" ? "Added" : "Last activity"} {new Date(item.state === "not_started" ? item.addedAt : item.lastActivityAt).toLocaleDateString()}
        </p>

        <div className="mt-auto flex flex-wrap gap-2 pt-1">
          <Link
            href={libraryPracticeHref(item)}
            className="rounded-xl bg-primary-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-primary-700"
          >
            {item.state === "not_started" ? "Start" : item.state === "completed" ? "Open" : "Continue"}
          </Link>
          {reviewRoundId && (
            <Link
              href={`/results/${reviewRoundId}`}
              className="rounded-xl border border-white/60 bg-white/60 px-3 py-1.5 text-xs font-semibold text-slate-700 transition-colors hover:bg-white"
            >
              Review report
            </Link>
          )}
        </div>
      </div>
    </article>
  );
}
