"use client";

import { Fragment } from "react";
import Link from "next/link";
import clsx from "clsx";
import type { LucideIcon } from "lucide-react";
import { ArrowRight, Headphones, Mic, PenTool, Play } from "lucide-react";
import { libraryPracticeHref, listeningText, practiceCoverageText } from "@/components/library/LibraryCard";
import type { LibraryItem } from "@/lib/types/learning";
import { formatLastActive } from "@/lib/utils/time";

const MODE_LABEL = { dictation: "Dictation", listening: "Listening", shadowing: "Shadowing" } as const;

const clampRatio = (ratio: number | null | undefined) => Math.min(1, Math.max(0, ratio ?? 0));

function ProgressRow({
  icon: Icon,
  label,
  value,
  ratio,
  barClass,
  valueTestId,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  ratio: number | null;
  barClass: string;
  valueTestId?: string;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-3 text-xs font-medium">
        <span className="flex items-center gap-1.5 text-ink">
          <Icon size={14} aria-hidden="true" className="text-muted" />
          {label}
        </span>
        <span data-testid={valueTestId} className="font-mono font-semibold tabular-nums text-ink">
          {value}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-line" aria-hidden="true">
        <div className={clsx("h-full rounded-full transition-[width] duration-500", barClass)} style={{ width: `${clampRatio(ratio) * 100}%` }} />
      </div>
    </div>
  );
}

/**
 * The Dashboard's primary resume card: the ONE resume item — the top
 * Continue Learning item, the same one Focus evaluates. Each progress bar is
 * that mode's own canonical coverage (never accuracy, never blended); the
 * overall "x/N sentences practiced" stays the round's headline number.
 * Report/Library/History navigation lives on those pages, not here.
 */
export function ContinueLearningCard({ item }: { item: LibraryItem }) {
  const href = libraryPracticeHref(item);
  const title = item.title ?? `Video ${item.videoId}`;
  const listeningOnly = item.state === "listening" || item.state === "listening_prior_revision";
  const mode = item.lastMode ? MODE_LABEL[item.lastMode] : listeningOnly ? "Listening" : null;
  const round = item.round;
  const progress = round?.progress;
  const required = progress?.requiredSentenceCount ?? null;
  const coverage = practiceCoverageText(item);
  const listening = listeningText(item);
  const listeningRatio = item.listening.listenedThrough ? 1 : item.listening.coverageRatio;
  const lastActive = formatLastActive(item.lastActivityAt);
  // Segment indexes are 0-based and shown +1 (as Bookmarks does). No "of N":
  // the round's required count skips empty segments, the index doesn't.
  const resumeAt =
    round?.status === "active" && (round.currentSegmentIndex > 0 || (progress?.coveredSentences.overall ?? 0) > 0)
      ? round.currentSegmentIndex + 1
      : null;
  const meta = [mode, round ? `Round ${round.roundNumber}` : null, lastActive ? `Last practiced ${lastActive}` : null].filter(
    (part): part is string => !!part
  );
  const bars = round && progress && required ? { roundNumber: round.roundNumber, progress, required } : null;

  return (
    <section
      aria-labelledby="continue-learning"
      data-testid="continue-learning"
      className="rounded-2xl border border-line bg-white p-5 shadow-xs sm:p-6"
    >
      <div className="mb-3 flex items-center gap-2">
        <span className="h-2 w-2 rounded-full bg-primary-600 motion-safe:animate-pulse" aria-hidden="true" />
        <h2 id="continue-learning" className="text-xs font-bold uppercase tracking-wider text-primary-600">
          Pick up where you left off
        </h2>
      </div>

      <article data-testid={`continue-card-${item.videoId}`} className="min-w-0">
        <div className="mb-4">
          {meta.length > 0 && (
            <p data-testid="continue-meta" className="mb-1 text-xs text-muted">
              {meta.map((part, i) => (
                <Fragment key={part}>
                  {i > 0 && " · "}
                  <span className={i === 0 && mode ? "font-semibold text-ink" : undefined}>{part}</span>
                </Fragment>
              ))}
            </p>
          )}
          <h3 className="line-clamp-2 text-lg font-bold leading-snug text-ink sm:text-xl">{title}</h3>
        </div>

        <div className="grid grid-cols-1 items-center gap-5 md:grid-cols-12 md:gap-6">
          <Link
            href={href}
            tabIndex={-1}
            aria-hidden="true"
            className="group relative block aspect-video overflow-hidden rounded-xl border border-line bg-slate-900 shadow-sm md:col-span-5"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`https://img.youtube.com/vi/${item.videoId}/hqdefault.jpg`}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover transition-transform duration-500 motion-safe:group-hover:scale-105"
            />
            <span className="absolute inset-0 bg-gradient-to-t from-slate-950/80 via-slate-950/30 to-transparent" />
            <span className="absolute inset-0 flex items-center justify-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-white text-primary-600 shadow-lg transition-transform motion-safe:group-hover:scale-110">
                <Play size={20} className="ml-0.5 fill-current" />
              </span>
            </span>
            {(round || mode) && (
              <span className="absolute inset-x-2.5 bottom-2.5 flex items-center justify-between text-[11px] font-semibold text-white">
                {round ? <span className="rounded-md bg-black/70 px-2 py-0.5 font-mono backdrop-blur-sm">Round {round.roundNumber}</span> : <span />}
                {mode && <span className="rounded-md bg-primary-600 px-2 py-0.5">{mode}</span>}
              </span>
            )}
          </Link>

          <div className="min-w-0 space-y-3 md:col-span-7">
            {(bars || listening) && (
              <div className="space-y-2.5 rounded-xl border border-line bg-surface p-3">
                {bars && coverage && (
                  <p className="text-xs font-semibold text-ink">
                    Round {bars.roundNumber} progress
                    <span className="font-normal text-muted">
                      {" · "}
                      <span data-testid="continue-coverage">{coverage}</span>
                    </span>
                  </p>
                )}
                {bars && (
                  <>
                    <ProgressRow
                      icon={PenTool}
                      label="Dictation"
                      value={`${bars.progress.coveredSentences.dictation}/${bars.required}`}
                      ratio={bars.progress.coverage.dictation}
                      barClass="bg-primary-600"
                    />
                    <ProgressRow
                      icon={Mic}
                      label="Shadowing"
                      value={`${bars.progress.coveredSentences.shadowing}/${bars.required}`}
                      ratio={bars.progress.coverage.shadowing}
                      barClass="bg-primary-700"
                    />
                  </>
                )}
                {listening && (
                  <ProgressRow
                    icon={Headphones}
                    label="Listening"
                    value={listening}
                    ratio={listeningRatio}
                    barClass="bg-success"
                    valueTestId="continue-listening"
                  />
                )}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3">
              {resumeAt !== null ? (
                <p data-testid="continue-resume" className="text-xs text-muted">
                  Resume at <span className="font-semibold text-ink">sentence {resumeAt}</span>
                </p>
              ) : (
                <span />
              )}
              <Link
                href={href}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary-600 px-6 py-2.5 text-sm font-semibold text-white shadow-xs transition-colors hover:bg-primary-700 sm:w-auto"
              >
                Continue learning <ArrowRight size={16} aria-hidden="true" />
              </Link>
            </div>
          </div>
        </div>
      </article>
    </section>
  );
}
