"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { ArrowRight, Trophy } from "lucide-react";
import { ProfileDialog } from "@/components/ProfileDialog";
import { LeagueAllTimeRows, LeagueWeekRows } from "@/components/league/LeagueRows";
import { LeaguePrivacyNotice } from "@/components/league/LeaguePrivacyNotice";
import { rowsThatFit } from "@/lib/leagues/fit";
import { formatLeagueReset, leagueName, zoneText } from "@/lib/leagues/tiers";
import { useLeaderboardQuery } from "@/lib/queries/leaderboard";
import type { LeagueWeekBoard } from "@/lib/types/leaderboard";

/** Dashboard rows per tab (at least); the full group is on /leaderboard. */
const TOP = 3;

/** The list area's measured room while the card fills a fixed height (`fill`). */
interface Room {
  heightPx: number;
  rowPx: number;
  rem: number;
}

/**
 * The Dashboard's league card (plan §1, §4.3): the tier, when the week
 * resets (viewer-local), This week / All time, the top 3 plus the learner's
 * own row, and the zone line. States: member, not joined yet (no XP this
 * week), hidden. Shows the one-time privacy notice (D7). The full group is
 * on /leaderboard.
 *
 * `fill` (plan D14): on large screens the card runs beside Continue AND the
 * review deck. It then takes its height from that slot (absolutely placed in
 * a `relative` parent, so it never sets the row heights) and lists as many
 * whole rows as fit, at least 3, with the promotion and demotion rows marked
 * as on /leaderboard. Below `lg` it is an ordinary card with the top 3.
 */
export function LeagueCard({ userId, board, fill = false }: { userId: string; board: LeagueWeekBoard; fill?: boolean }) {
  const [tab, setTab] = useState<"week" | "all">("week");
  const [prefsOpen, setPrefsOpen] = useState(false);
  const prefsReturnRef = useRef<HTMLElement | null>(null);
  const allTime = useLeaderboardQuery(userId, "all", tab === "all");
  const cardRef = useRef<HTMLElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState<Room | null>(null);
  const hidden = board.status === "hidden";

  // Measure the list area whenever its size changes (resize, the rows beside
  // it growing, the privacy notice going away). Only while the card really is
  // filling its slot; otherwise (below lg) it shows the plain top 3.
  useEffect(() => {
    const card = cardRef.current;
    const panel = panelRef.current;
    if (!fill || hidden || !card || !panel || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (getComputedStyle(card).position !== "absolute") return setRoom(null);
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const rowPx = panel.querySelector("li")?.getBoundingClientRect().height || 3.5 * rem;
      setRoom((prev) =>
        prev && prev.heightPx === panel.clientHeight && prev.rowPx === rowPx && prev.rem === rem ? prev : { heightPx: panel.clientHeight, rowPx, rem }
      );
    });
    observer.observe(panel);
    return () => observer.disconnect();
  }, [fill, hidden]);

  const openPreferences = () => {
    prefsReturnRef.current = document.activeElement as HTMLElement | null;
    setPrefsOpen(true);
  };
  const mine = board.rows.find((r) => r.isYou);
  const gapPx = room ? room.rem / 4 : 0; // the rows' space-y-1
  const weekTop = room
    ? rowsThatFit({ heightPx: room.heightPx, rowPx: room.rowPx, gapPx, youExtraPx: 1.25 * room.rem + room.rowPx, youRank: mine?.rank ?? null, min: TOP })
    : TOP;
  const allTimeTop = room
    ? rowsThatFit({ heightPx: room.heightPx, rowPx: room.rowPx, gapPx, reservePx: 1.75 * room.rem, youExtraPx: gapPx + room.rowPx, youRank: allTime.data?.you?.rank ?? null, min: TOP })
    : TOP;
  const shown = board.rows.slice(0, weekTop);
  const extraYou = mine && mine.rank > weekTop ? [mine] : [];
  const zone = zoneText(board);

  return (
    <section
      ref={cardRef}
      data-testid="league-card"
      data-fill={fill || undefined}
      aria-labelledby="league-heading"
      className={clsx("flex h-full flex-col gap-3.5 rounded-2xl border border-line bg-white p-5 shadow-xs", fill && "lg:absolute lg:inset-0")}
    >
      <div className="flex items-start justify-between gap-2">
        <h2 id="league-heading" className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-ink">
          <Trophy size={16} className="text-reward" aria-hidden="true" />
          {leagueName(board.tier)} League
        </h2>
        <span data-testid="league-reset" className="font-mono text-[11px] text-muted">
          Resets {formatLeagueReset(board.weekEndsAt)}
        </span>
      </div>

      {hidden ? (
        <div data-testid="league-hidden" className="space-y-2 text-sm text-muted">
          <p>You&apos;re hidden from leaderboards, so you don&apos;t see them either.</p>
          <button type="button" onClick={openPreferences} className="font-semibold text-primary-600 hover:text-primary-700">
            Show me in Preferences
          </button>
        </div>
      ) : (
        <>
          <div role="tablist" aria-label="Leaderboard period" className="flex gap-1 rounded-lg bg-surface p-1 text-xs font-semibold">
            {(["week", "all"] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                id={`league-tab-${t}`}
                aria-selected={tab === t}
                aria-controls={`league-panel-${t}`}
                onClick={() => setTab(t)}
                className={clsx("flex-1 rounded-md px-2 py-1.5 transition-colors", tab === t ? "bg-white text-ink shadow-xs" : "text-muted hover:text-ink")}
              >
                {t === "week" ? "This week" : "All time"}
              </button>
            ))}
          </div>

          <div
            ref={panelRef}
            role="tabpanel"
            id={`league-panel-${tab}`}
            aria-labelledby={`league-tab-${tab}`}
            className={clsx("min-h-0 flex-1", fill && "lg:overflow-hidden")}
          >
            {tab === "week" ? (
              board.status === "not_joined" ? (
                <p data-testid="league-not-joined" className="text-sm text-muted">
                  Practice anything this week to join this week&apos;s {leagueName(board.tier)} league.
                </p>
              ) : (
                <>
                  <LeagueWeekRows rows={shown} userId={userId} showZones={!!room} />
                  {extraYou.length > 0 && (
                    <>
                      <p aria-hidden="true" className="py-0.5 text-center text-xs text-muted">
                        ···
                      </p>
                      <LeagueWeekRows rows={extraYou} userId={userId} showZones={!!room} />
                    </>
                  )}
                </>
              )
            ) : allTime.data ? (
              <>
                <LeagueAllTimeRows rows={allTime.data.rows.slice(0, allTimeTop)} you={allTime.data.you} />
                <p className="mt-2 text-[11px] text-muted">Updated hourly.</p>
              </>
            ) : allTime.isError ? (
              <p className="text-sm text-muted">Couldn&apos;t load the all-time ranking.</p>
            ) : (
              <div aria-busy="true" aria-label="Loading the all-time ranking" className="h-32 animate-pulse rounded-xl bg-surface" />
            )}
          </div>

          {tab === "week" && zone && (
            <p data-testid="league-zone" className="border-t border-line pt-3 text-xs leading-relaxed text-muted">
              {zone}
            </p>
          )}

          <LeaguePrivacyNotice userId={userId} displayName={board.displayName} onOpenPreferences={openPreferences} />
        </>
      )}

      <Link href="/leaderboard" className="mt-auto inline-flex items-center gap-1 text-xs font-semibold text-primary-600 hover:text-primary-700">
        Full leaderboard <ArrowRight size={13} aria-hidden="true" />
      </Link>

      {prefsOpen && <ProfileDialog onClose={() => setPrefsOpen(false)} returnFocusRef={prefsReturnRef} />}
    </section>
  );
}
