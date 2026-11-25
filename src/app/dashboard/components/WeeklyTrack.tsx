"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import { Check } from "lucide-react";
import type { DashboardWeek } from "@/lib/types/learning";
import type { XpDay, XpSummary } from "@/lib/types/xp";
import { dayDetails, formatDayKey, formatDayMinutesLong, formatDayMinutesShort, weeklyTrack, type TrackDay } from "@/lib/dashboard/week";
import { formatXp } from "@/lib/xp/levels";
import { ActiveEmber } from "./ActiveEmber";

type OpenDay = { index: number; pinned: boolean } | null;

/** Where a day's popover sits so the first/last columns stay inside the hero. */
const POPOVER_ALIGN = ["left-0", "left-0", "left-1/2 -translate-x-1/2", "left-1/2 -translate-x-1/2", "left-1/2 -translate-x-1/2", "right-0", "right-0"];

function dayStatusText(day: TrackDay, xpDay: XpDay | undefined): string {
  if (day.state === "future") return "upcoming";
  if (!day.practiced) return day.state === "today" ? "no practice yet" : "no practice";
  return ["practiced", day.activeSec > 0 ? formatDayMinutesLong(day.activeSec) : null, xpDay && xpDay.xp > 0 ? `+${formatXp(xpDay.xp)} XP` : null]
    .filter(Boolean)
    .join(", ");
}

/** Under a day: its XP ("+85") when XP is available, else its minutes. */
function dayValueLabel(day: TrackDay, xpDay: XpDay | undefined, hasXp: boolean): string {
  if (day.state === "future") return "";
  if (!hasXp) return formatDayMinutesShort(day.activeSec);
  return xpDay && xpDay.xp > 0 ? `+${formatXp(xpDay.xp)}` : "—";
}

/**
 * The hero's Weekly consistency track (plan §1, §4.5.5): Monday–Sunday of the
 * viewer's local week. ✓ = any practice that day (the streak's own day set,
 * word reviews included); the ember marks today; later days are plain dots.
 * Under each day: the XP earned that day (its active minutes while XP is
 * unavailable).
 *
 * A practiced day is a button with a details popover — hover (mouse), focus
 * (keyboard) or tap/click (pins it open); Escape, leaving or tapping outside
 * closes it. It shows the date, the active time, the Dictation and
 * Shadowing sentences and words reviewed, and the day's XP; zero values are
 * left out. Inactive and future days have no popover.
 */
export function WeeklyTrack({ week, xp }: { week: DashboardWeek; xp?: XpSummary }) {
  const { days, activeCount, todayIndex } = weeklyTrack(week);
  const xpByDate = new Map((xp?.days ?? []).map((d) => [d.date, d]));
  const [open, setOpen] = useState<OpenDay>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const baseId = useId();

  // A tap or click anywhere else closes a pinned popover (touch browsers
  // that never move focus off the button included).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!listRef.current?.contains(e.target as Node)) setOpen(null);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const show = (index: number) => setOpen((o) => (o?.index === index ? o : { index, pinned: false }));
  const hide = (index: number, evenIfPinned = false) =>
    setOpen((o) => (o && o.index === index && (evenIfPinned || !o.pinned) ? null : o));
  const toggle = (index: number) => setOpen((o) => (o?.index === index && o.pinned ? null : { index, pinned: true }));
  const onKeyDown = (index: number) => (e: KeyboardEvent) => {
    if (e.key === "Escape" && open?.index === index) {
      e.stopPropagation();
      setOpen(null);
    }
  };

  // The rail runs from Monday's center to Sunday's; it's lit up to today.
  const litPct = todayIndex > 0 ? (100 * todayIndex) / 6 : 0;

  return (
    <div data-testid="weekly-track" className="max-w-lg pt-2">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-300">Weekly consistency track</h2>
        <span className="font-mono text-xs text-slate-400" data-testid="weekly-track-count">
          · {activeCount}/7 active
        </span>
      </div>

      <div className="relative">
        <div aria-hidden="true" className="pointer-events-none absolute left-[7.14%] right-[7.14%] top-9 h-[1.5px] -translate-y-1/2">
          <div className="h-full w-full bg-white/[0.08]" />
          <div
            className="absolute left-0 top-0 h-full rounded-full"
            style={{
              width: `${litPct}%`,
              background: "linear-gradient(90deg, rgba(47, 174, 155, 0.38) 0%, rgba(47, 174, 155, 0.38) 82%, rgba(239, 176, 68, 0.35) 100%)",
            }}
          />
        </div>

        <ol ref={listRef} aria-label="This week, Monday to Sunday" className="relative grid grid-cols-7">
          {days.map((day, i) => {
            const isToday = day.state === "today";
            const isOpen = open?.index === i;
            const date = formatDayKey(day.date);
            const xpDay = xpByDate.get(day.date);
            const label = `${isToday ? `Today, ${date}` : date}: ${dayStatusText(day, xpDay)}`;
            const details = isOpen ? dayDetails(day, xpDay) : null;
            const popoverId = `${baseId}-day-${i}`;
            const marker = isToday ? (
              <ActiveEmber size={24} />
            ) : day.state === "done" ? (
              <span aria-hidden="true" className="flex h-6 w-6 items-center justify-center rounded-full bg-success text-hero">
                <Check size={14} strokeWidth={3} />
              </span>
            ) : (
              <span aria-hidden="true" className={clsx("flex h-6 w-6 items-center justify-center rounded-full", day.state === "future" ? "bg-white/[0.06]" : "bg-white/10")}>
                <span className={clsx("h-1.5 w-1.5 rounded-full", day.state === "future" ? "bg-slate-600" : "bg-slate-500")} />
              </span>
            );

            return (
              <li key={day.date} data-testid={`track-day-${day.date}`} data-state={day.state} className="relative flex flex-col items-center">
                <span
                  aria-hidden="true"
                  className={clsx(
                    "mb-2 h-4 text-[11px] font-semibold leading-4 tracking-wider",
                    day.practiced || isToday ? "text-slate-300" : "text-slate-500"
                  )}
                >
                  {day.weekday}
                </span>

                {day.practiced ? (
                  <button
                    type="button"
                    aria-label={label}
                    aria-expanded={isOpen}
                    aria-controls={isOpen ? popoverId : undefined}
                    onMouseEnter={() => show(i)}
                    onMouseLeave={() => hide(i)}
                    onFocus={() => show(i)}
                    onBlur={() => hide(i, true)}
                    onClick={() => toggle(i)}
                    onKeyDown={onKeyDown(i)}
                    className="relative flex h-6 w-6 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-hero"
                  >
                    {marker}
                  </button>
                ) : (
                  <span className="relative flex h-6 w-6 items-center justify-center">
                    {marker}
                    <span className="sr-only">{label}</span>
                  </span>
                )}

                <span
                  aria-hidden="true"
                  className={clsx(
                    "mt-1.5 h-3 font-mono text-[10px] leading-3 tabular-nums",
                    isToday ? "font-medium text-reward" : day.practiced ? "text-slate-400" : "text-slate-600"
                  )}
                >
                  {dayValueLabel(day, xpDay, !!xp)}
                </span>

                {details && (
                  <div
                    id={popoverId}
                    data-testid="day-details"
                    className={clsx(
                      "absolute bottom-full z-20 mb-1 w-max max-w-[13rem] rounded-lg border border-line bg-white px-3 py-2 text-left text-xs text-ink shadow-lg",
                      POPOVER_ALIGN[i]
                    )}
                  >
                    <p className="font-semibold">{isToday ? `Today · ${date}` : date}</p>
                    <p className="mt-0.5 text-muted">{details.parts.join(" · ")}</p>
                    {details.xpLabel && <p className="mt-1 font-mono font-bold text-primary-600">{details.xpLabel}</p>}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
