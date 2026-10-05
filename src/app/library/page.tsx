"use client";

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import { useQueryClient } from "@tanstack/react-query";
import AppHeader from "@/components/AppHeader";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { LibraryCard } from "@/components/library/LibraryCard";
import { useAuth } from "@/context/auth";
import { usePersistedViewState } from "@/hooks/usePersistedViewState";
import { useScrollRestoration } from "@/hooks/useScrollRestoration";
import { PAGE_PADDING_CLASS, PAGE_WIDTH_CLASS } from "@/lib/layout/pageWidth";
import { invalidateLearningViews } from "@/lib/queries/learningInvalidation";
import { removeFromLibrary, useVideoLibraryQuery } from "@/lib/queries/videoLibrary";
import type { LibraryFilter, LibraryItem } from "@/lib/types/learning";

/** The Library's own filters (fn_video_library), in browse order. "continue" is the Dashboard's resume query, not a tab. */
const FILTER_TABS: ReadonlyArray<{ filter: LibraryFilter; label: string }> = [
  { filter: "all", label: "All" },
  { filter: "in_progress", label: "In progress" },
  { filter: "not_started", label: "Not started" },
  { filter: "completed", label: "Completed" },
  { filter: "listening", label: "Listening" },
];

/**
 * My Learning — "what videos have I saved or worked on?". The user's Library
 * (user_videos membership, fn_video_library): one card per video, every
 * state including added-but-not-started, status filters, Load more, and
 * removal (membership only — history is kept). Past activity (rounds,
 * sessions, mistakes) is History, not here.
 */
function LibraryPageContent() {
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const { user, loading, openAuthModal } = useAuth();
  const userId = user?.id;
  const [pendingRemoval, setPendingRemoval] = useState<LibraryItem | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  // Same persisted view-state key the Dashboard Library used, so a saved filter carries over.
  const [view, updateView, viewHydrated] = usePersistedViewState("video-library-viewstate", userId, { filter: "all" });
  const filter: LibraryFilter = FILTER_TABS.some((t) => t.filter === view.filter) ? (view.filter as LibraryFilter) : "all";

  const libraryQuery = useVideoLibraryQuery(userId, filter);
  const items = useMemo(() => libraryQuery.data?.pages.flatMap((p) => p.items) ?? [], [libraryQuery.data]);
  const total = libraryQuery.data?.pages[0]?.total ?? 0;

  useScrollRestoration(pathname, userId, viewHydrated && !libraryQuery.isPlaceholderData && !libraryQuery.isLoading);

  const confirmRemoval = async () => {
    if (!pendingRemoval || !userId) return;
    setRemoving(true);
    setRemoveError(null);
    try {
      await removeFromLibrary(pendingRemoval.videoId);
      invalidateLearningViews(queryClient, userId);
      setPendingRemoval(null);
    } catch {
      setRemoveError("Couldn't remove the video. Please try again.");
    } finally {
      setRemoving(false);
    }
  };

  return (
    <div className="relative flex min-h-screen w-full flex-1 flex-col overflow-hidden bg-[#f6f7fc] font-sans text-slate-900 antialiased">
      <div className="pointer-events-none absolute -left-[10%] -top-[10%] z-0 h-[40%] w-[40%] rounded-full bg-purple-200 opacity-40 blur-[120px]" />

      <div className="relative z-10 flex flex-1 flex-col">
        <AppHeader active="library" />

        <main className={clsx("mx-auto flex w-full flex-1 flex-col gap-6 py-8", PAGE_WIDTH_CLASS.wide, PAGE_PADDING_CLASS.wide)}>
          {loading ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : !user ? (
            <section className="rounded-3xl border border-white/60 bg-white/40 p-8 shadow-xl backdrop-blur-xl">
              <h1 className="text-2xl font-semibold tracking-tight text-slate-900">My Learning</h1>
              <p className="mt-2 text-sm text-slate-500">Sign in to see the videos you have saved and worked on.</p>
              <button
                onClick={openAuthModal}
                className="mt-4 rounded-xl bg-primary-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary-700"
              >
                Sign in
              </button>
            </section>
          ) : (
            <>
              <section className="flex flex-col gap-1">
                <h1 className="text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">
                  My Learning {total > 0 && filter === "all" && <span className="text-lg font-medium text-slate-400">({total})</span>}
                </h1>
                <p className="text-sm text-slate-500 sm:text-base">Your saved videos and learning progress.</p>
              </section>

              <div className="flex flex-wrap gap-2" role="tablist" aria-label="Filter my learning">
                {FILTER_TABS.map(({ filter: f, label }) => (
                  <button
                    key={f}
                    type="button"
                    role="tab"
                    aria-selected={filter === f}
                    onClick={() => updateView({ filter: f })}
                    className={clsx(
                      "rounded-full px-3.5 py-1.5 text-sm font-semibold transition-colors",
                      filter === f ? "bg-primary-600 text-white" : "bg-white/70 text-slate-600 ring-1 ring-slate-200/70 hover:bg-white"
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {removeError && <p className="text-sm text-red-600">{removeError}</p>}
              {libraryQuery.isError && !libraryQuery.data ? (
                <p className="text-sm text-red-600">
                  Couldn&apos;t load your videos.{" "}
                  <button type="button" onClick={() => libraryQuery.refetch()} className="font-semibold underline">
                    Retry
                  </button>
                </p>
              ) : !libraryQuery.data ? (
                <p className="text-sm text-slate-500">Loading your videos…</p>
              ) : items.length === 0 ? (
                <div className="rounded-3xl border border-slate-200/70 bg-white/60 p-6 text-sm text-slate-500">
                  {filter === "all" ? (
                    <>
                      You haven&apos;t saved any videos yet.{" "}
                      <Link href="/dashboard" className="font-semibold text-primary-600 hover:text-primary-700">
                        Add one from the Dashboard
                      </Link>
                    </>
                  ) : (
                    "No videos match this filter."
                  )}
                </div>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4" data-testid="library-grid">
                  {items.map((item) => (
                    <LibraryCard key={item.videoId} item={item} onRemove={(it) => setPendingRemoval(it)} />
                  ))}
                </div>
              )}
              {libraryQuery.hasNextPage && (
                <button
                  onClick={() => libraryQuery.fetchNextPage()}
                  disabled={libraryQuery.isFetchingNextPage}
                  className="self-center rounded-xl bg-white/70 px-4 py-2 text-sm font-semibold text-slate-600 ring-1 ring-slate-200/70 transition-colors hover:bg-white disabled:opacity-50"
                >
                  {libraryQuery.isFetchingNextPage ? "Loading…" : "Load more"}
                </button>
              )}
            </>
          )}
        </main>
      </div>

      {pendingRemoval && (
        <ConfirmDialog
          title="Remove from My Learning?"
          body={`“${pendingRemoval.title ?? pendingRemoval.videoId}” will disappear from My Learning. Your rounds, answers, recordings, reports and listening progress are kept — adding the video again brings them back.`}
          confirmLabel="Remove"
          busyLabel="Removing…"
          isConfirming={removing}
          onConfirm={confirmRemoval}
          onCancel={() => setPendingRemoval(null)}
        />
      )}
    </div>
  );
}

export default function LibraryPage() {
  return (
    <Suspense fallback={<p className="p-8 text-sm text-slate-500">Loading…</p>}>
      <LibraryPageContent />
    </Suspense>
  );
}
