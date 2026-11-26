"use client";

import { useRef } from "react";
import clsx from "clsx";
import { Flame, Heart } from "lucide-react";
import { useToast } from "@/components/ToastProvider";
import { BUMP, EASE_OUT, playOnce } from "@/lib/motion";
import { useGiveKudosMutation } from "@/lib/queries/leaderboard";
import { formatXp } from "@/lib/xp/levels";
import type { LeagueAllTimeRow, LeagueWeekRow } from "@/lib/types/leaderboard";

const ZONE_LABEL = { promotion: "promotion zone", demotion: "demotion zone", safe: "" } as const;

function Avatar({ initials, isYou }: { initials: string; isYou: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={clsx(
        // Below 360px the name needs the room; rank and name still identify the row.
        "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold max-[359px]:hidden",
        isYou ? "bg-primary-600 text-white" : "bg-surface text-ink ring-1 ring-line"
      )}
    >
      {initials}
    </span>
  );
}

function KudosButton({ row, userId }: { row: LeagueWeekRow; userId: string | undefined }) {
  const give = useGiveKudosMutation(userId);
  const toast = useToast();
  const heartRef = useRef<SVGSVGElement>(null);
  if (row.isYou) {
    return (
      <span className="flex items-center gap-1 text-xs text-muted" aria-label={`${row.kudos} kudos`}>
        <Heart size={13} aria-hidden="true" className={clsx(row.kudos > 0 && "fill-danger/70 text-danger")} />
        <span aria-hidden="true">{row.kudos}</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      data-testid={`kudos-${row.rank}`}
      aria-pressed={row.youGaveKudos}
      disabled={row.youGaveKudos || give.isPending}
      aria-label={row.youGaveKudos ? `You gave kudos to ${row.name}` : `Give kudos to ${row.name}`}
      onClick={() => {
        // The heart fills at once (optimistic) with a small pop.
        playOnce(heartRef.current, BUMP, { duration: 350, easing: EASE_OUT });
        give.mutate(row.memberKey, {
          onError: () => toast({ message: "Couldn't send kudos", sub: "Please try again.", tone: "error" }),
        });
      }}
      className={clsx(
        "flex items-center gap-1 rounded-md px-1.5 py-1 text-xs transition-colors",
        row.youGaveKudos ? "cursor-default text-danger" : "text-muted hover:bg-surface hover:text-danger"
      )}
    >
      <Heart ref={heartRef} size={13} aria-hidden="true" className={clsx(row.youGaveKudos && "fill-current")} />
      <span aria-hidden="true">{row.kudos}</span>
    </button>
  );
}

/**
 * Members of the caller's league group (plan §1, League card and
 * /leaderboard): rank, initials, name, streak, kudos and weekly XP. With
 * `showZones`, promotion and demotion rows are tinted and labelled.
 */
export function LeagueWeekRows({ rows, userId, showZones = false }: { rows: LeagueWeekRow[]; userId: string | undefined; showZones?: boolean }) {
  return (
    <ol aria-label="This week's ranking" className="space-y-1">
      {rows.map((r) => (
        <li
          key={r.memberKey}
          data-testid={`league-row-${r.rank}`}
          data-zone={r.zone}
          data-you={r.isYou}
          className={clsx(
            "flex items-center gap-2.5 rounded-xl border px-2.5 py-2",
            r.isYou ? "border-primary-500/40 bg-primary-50" : "border-transparent",
            showZones && r.zone === "promotion" && !r.isYou && "bg-success/5",
            showZones && r.zone === "demotion" && !r.isYou && "bg-danger/5",
            showZones && r.zone !== "safe" && "border-l-4",
            showZones && r.zone === "promotion" && "border-l-success",
            showZones && r.zone === "demotion" && "border-l-danger"
          )}
        >
          <span className="w-6 shrink-0 text-center font-mono text-xs font-bold text-muted">{r.rank}</span>
          <Avatar initials={r.initials} isYou={r.isYou} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold text-ink">
              {r.name}
              {r.isYou && <span className="ml-1 text-xs font-medium text-primary-600">(you)</span>}
              {showZones && ZONE_LABEL[r.zone] && <span className="sr-only">, {ZONE_LABEL[r.zone]}</span>}
            </span>
            <span className="flex items-center gap-1 whitespace-nowrap text-[11px] text-muted">
              <Flame size={11} aria-hidden="true" className={clsx(r.streakDays > 0 ? "text-reward" : "text-muted")} />
              {r.streakDays} {r.streakDays === 1 ? "day" : "days"}
            </span>
          </span>
          <KudosButton row={r} userId={userId} />
          <span className="w-16 shrink-0 text-right font-mono text-xs font-bold tabular-nums text-ink">{formatXp(r.weekXp)} XP</span>
        </li>
      ))}
    </ol>
  );
}

/** The all-time top rows given (+ the caller when outside them). */
export function LeagueAllTimeRows({ rows, you }: { rows: LeagueAllTimeRow[]; you: { rank: number; totalXp: number } | null }) {
  const youListed = rows.some((r) => r.isYou);
  return (
    <ol aria-label="All-time ranking" className="space-y-1">
      {rows.map((r) => (
        <li key={r.rank} data-testid={`alltime-row-${r.rank}`} data-you={r.isYou} className={clsx("flex items-center gap-2.5 rounded-xl border px-2.5 py-2", r.isYou ? "border-primary-500/40 bg-primary-50" : "border-transparent")}>
          <span className="w-6 shrink-0 text-center font-mono text-xs font-bold text-muted">{r.rank}</span>
          <Avatar initials={r.initials} isYou={r.isYou} />
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
            {r.name}
            {r.isYou && <span className="ml-1 text-xs font-medium text-primary-600">(you)</span>}
          </span>
          <span className="shrink-0 font-mono text-xs font-bold tabular-nums text-ink">{formatXp(r.totalXp)} XP</span>
        </li>
      ))}
      {you && !youListed && (
        <li data-testid="alltime-you" data-you="true" className="flex items-center gap-2.5 rounded-xl border border-primary-500/40 bg-primary-50 px-2.5 py-2">
          <span className="w-6 shrink-0 text-center font-mono text-xs font-bold text-muted">{you.rank}</span>
          <span className="min-w-0 flex-1 text-sm font-semibold text-ink">You</span>
          <span className="shrink-0 font-mono text-xs font-bold tabular-nums text-ink">{formatXp(you.totalXp)} XP</span>
        </li>
      )}
    </ol>
  );
}
