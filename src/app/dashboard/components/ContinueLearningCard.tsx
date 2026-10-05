"use client";

import Link from "next/link";
import { ArrowRight, Headphones, PlayCircle } from "lucide-react";
import { libraryPracticeHref, listeningText, practiceCoverageText } from "@/components/library/LibraryCard";
import type { LibraryItem } from "@/lib/types/learning";

const MODE_LABEL = { dictation: "Dictation", listening: "Listening", shadowing: "Shadowing" } as const;

/**
 * The Dashboard's primary hero: the ONE resume item — the top Continue
 * Learning item, the same one Focus evaluates. A small fixed thumbnail
 * supports the title; the item's own canonical progress; one CTA.
 * Report/Library/History navigation lives on those pages, not here.
 */
export function ContinueLearningCard({ item }: { item: LibraryItem }) {
  const href = libraryPracticeHref(item);
  const title = item.title ?? `Video ${item.videoId}`;
  const coverage = practiceCoverageText(item);
  const listening = listeningText(item);
  const ratio = item.round?.progress.coverage.overall ?? null;
  const mode = item.lastMode ? MODE_LABEL[item.lastMode] : item.state === "listening" || item.state === "listening_prior_revision" ? "Listening" : null;

  return (
    <section
      aria-labelledby="continue-learning"
      data-testid="continue-learning"
      className="rounded-3xl border border-primary-100 bg-gradient-to-br from-primary-100/80 via-primary-50 to-white p-5 shadow-sm sm:p-6"
    >
      <h2 id="continue-learning" className="mb-4 text-sm font-semibold text-primary-700">
        Pick up where you left off
      </h2>
      <article data-testid={`continue-card-${item.videoId}`} className="flex min-w-0 gap-4 sm:gap-5">
        <Link
          href={href}
          tabIndex={-1}
          aria-hidden="true"
          className="group relative aspect-video w-28 shrink-0 self-start overflow-hidden rounded-2xl bg-slate-800 sm:w-44 lg:w-52"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`https://img.youtube.com/vi/${item.videoId}/mqdefault.jpg`}
            alt=""
            className="h-full w-full object-cover opacity-90 transition-opacity group-hover:opacity-100"
            loading="lazy"
          />
          <span className="absolute inset-0 flex items-center justify-center">
            <PlayCircle className="fill-white/20 text-white" size={24} />
          </span>
        </Link>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <h3 className="line-clamp-2 text-base font-semibold leading-snug text-slate-900 sm:text-xl">{title}</h3>
          {mode && <p className="text-xs font-medium text-slate-500 sm:text-sm">{mode}</p>}
          {coverage && (
            <div data-testid="continue-coverage" className="max-w-sm">
              {ratio !== null && (
                <div className="mb-1.5 h-2 w-full overflow-hidden rounded-full bg-white ring-1 ring-primary-100" aria-hidden="true">
                  <div className="h-full rounded-full bg-primary-500" style={{ width: `${Math.min(100, Math.max(0, ratio * 100))}%` }} />
                </div>
              )}
              <p className="text-xs text-slate-600 sm:text-sm">{coverage}</p>
            </div>
          )}
          {listening && (
            <p className="flex items-center gap-1 text-xs text-sky-700 sm:text-sm" data-testid="continue-listening">
              <Headphones size={13} /> {listening}
            </p>
          )}
          <div className="mt-1 sm:mt-2">
            <Link
              href={href}
              className="inline-flex items-center gap-2 rounded-xl bg-primary-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-primary-700"
            >
              Continue learning <ArrowRight size={16} aria-hidden="true" />
            </Link>
          </div>
        </div>
      </article>
    </section>
  );
}
