"use client";

import { useId, useMemo } from "react";
import { useVideoRoundListQuery } from "@/lib/queries/historySessions";
import type { VideoRoundOption } from "@/lib/types/learning";

const STATUS: Record<VideoRoundOption["status"], string> = { active: "In progress", completed: "Completed", abandoned: "Ended" };

export const roundOptionLabel = (r: Pick<VideoRoundOption, "roundNumber" | "status" | "startedAt">) =>
  `Round ${r.roundNumber} · ${STATUS[r.status]} · started ${new Date(r.startedAt).toLocaleDateString()}`;

export const roundCountText = (n: number) => `${n} ${n === 1 ? "round" : "rounds"}`;

/**
 * The report page's round navigation (one selector): how many rounds this
 * video has for this account (the exact total, not the loaded page), and
 * which one is being viewed. Choosing another round only navigates — the
 * caller goes to that round's canonical /results/<roundId> URL; nothing here
 * writes, starts or resumes anything. The explicitly opened round always
 * stays selectable, even when it's older than the loaded page.
 */
export function RoundSelector({
  userId,
  videoId,
  selected,
  onSelect,
}: {
  userId: string;
  videoId: string;
  /** The round being viewed (from its report, or the cached list while it loads). */
  selected: VideoRoundOption | { roundId: string };
  onSelect: (roundId: string) => void;
}) {
  const selectId = useId();
  const query = useVideoRoundListQuery(userId, videoId);
  const total = typeof query.data?.pages[0]?.total === "number" ? query.data.pages[0].total : null;
  const options = useMemo(() => {
    const loaded = query.data?.pages.flatMap((p) => p.items ?? []) ?? [];
    const all = loaded.some((r) => r.roundId === selected.roundId) || !("startedAt" in selected) ? loaded : [...loaded, selected];
    // Newest first (the History order), the opened round included.
    return [...all].sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.roundId.localeCompare(a.roundId));
  }, [query.data, selected]);
  const known = options.find((r) => r.roundId === selected.roundId) ?? null;
  const remaining = total !== null ? total - (query.data?.pages.reduce((n, p) => n + (p.items?.length ?? 0), 0) ?? 0) : 0;

  return (
    <div className="flex w-full min-w-0 flex-col gap-1.5 sm:w-80" data-testid="round-selector">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={selectId} className="text-xs font-semibold text-slate-700">
          Viewing round
        </label>
        <span className="text-xs text-slate-500" data-testid="round-count">
          {total !== null ? roundCountText(total) : query.isError ? "" : "Counting rounds…"}
        </span>
      </div>
      <select
        id={selectId}
        value={selected.roundId}
        disabled={options.length <= 1}
        onChange={(e) => {
          if (e.target.value && e.target.value !== selected.roundId) onSelect(e.target.value);
        }}
        className="w-full min-w-0 max-w-full truncate rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm focus:outline-none focus:ring-2 focus:ring-primary-300 disabled:cursor-default disabled:opacity-100"
      >
        {!known && <option value={selected.roundId}>Loading this round…</option>}
        {options.map((r) => (
          <option key={r.roundId} value={r.roundId}>
            {roundOptionLabel(r)}
          </option>
        ))}
      </select>
      {query.isError && (
        <p className="text-xs text-red-600" role="alert">
          Couldn&apos;t load this video&apos;s rounds.{" "}
          <button type="button" onClick={() => query.refetch()} className="font-semibold underline">
            Retry
          </button>
        </p>
      )}
      {query.hasNextPage && (
        <button
          type="button"
          onClick={() => query.fetchNextPage()}
          disabled={query.isFetchingNextPage}
          className="self-start text-xs font-semibold text-primary-600 underline disabled:opacity-50"
        >
          {query.isFetchingNextPage ? "Loading older rounds…" : `Show older rounds (${remaining} more)`}
        </button>
      )}
    </div>
  );
}
