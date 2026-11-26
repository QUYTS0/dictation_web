"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import clsx from "clsx";
import { Headphones, Plus } from "lucide-react";
import UserButton from "@/components/UserButton";
import { useNewVideoDialog } from "@/components/NewVideoDialog";
import { StreakPill } from "@/components/StreakPill";
import { XpPill } from "@/components/XpPill";
import { useAuth } from "@/context/auth";
import { useStreakQuery } from "@/lib/queries/streak";
import { useXpQuery } from "@/lib/queries/xp";
import { PAGE_PADDING_CLASS, PAGE_WIDTH_CLASS } from "@/lib/layout/pageWidth";

const NAV_LINKS = [
  { key: "dashboard", href: "/dashboard", label: "Dashboard" },
  // The user's Library (saved videos and their state), shown as "My Learning".
  { key: "library", href: "/library", label: "My Learning" },
  { key: "vocabulary", href: "/vocabulary", label: "Vocabulary" },
  { key: "bookmarks", href: "/bookmarks", label: "Bookmarks" },
  { key: "history", href: "/history", label: "History" },
  { key: "leaderboard", href: "/leaderboard", label: "Leaderboard" },
] as const;

type NavKey = (typeof NAV_LINKS)[number]["key"];

interface AppHeaderProps {
  /** Highlights the matching nav link as the current page. */
  active?: NavKey;
}

/**
 * Shared app-shell header used by every signed-in page (dashboard, my
 * learning, vocabulary, bookmarks, history, leaderboard, results): brand, primary nav,
 * and — for a signed-in learner — "New video", the streak pill, the XP pill
 * (from xl; hidden while XP is unavailable) and the account menu. The dictation/listening workspace uses its own compact
 * title-bar header instead (back button + progress label, zen-mode aware).
 *
 * Layout by width (measured, not guessed: the six tabs need ~510px in the
 * one-row header, ~630px at 2xl's larger text):
 *  - below lg (phones, tablets): two rows; the tabs get their own full-width
 *    row, which scrolls sideways only on a phone.
 *  - lg: one row; "New video" is icon-only and the XP pill is hidden.
 *  - xl: the XP pill and the "New video" label come back.
 *  - 2xl: the larger tab text.
 * If the row still runs short (long streak/XP numbers, browser zoom), the
 * tabs scroll instead of pushing the account menu off the screen.
 */
export default function AppHeader({ active }: AppHeaderProps) {
  const { user } = useAuth();
  const streak = useStreakQuery(user?.id).data;
  const xp = useXpQuery(user?.id).data;
  // The app's one New video dialog (also opened by the Dashboard hero); it keeps a half-typed link.
  const newVideo = useNewVideoDialog();
  const navRef = useRef<HTMLElement>(null);

  // When the tabs scroll (a phone, or a squeezed one-row header), bring the
  // current page's tab into view, e.g. "Leaderboard". A no-op when they fit.
  useEffect(() => {
    const nav = navRef.current;
    const current = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !current || nav.scrollWidth <= nav.clientWidth) return;
    const navBox = nav.getBoundingClientRect();
    const tabBox = current.getBoundingClientRect();
    nav.scrollLeft += tabBox.left - navBox.left - (navBox.width - tabBox.width) / 2;
  }, [active]);

  return (
    <header className="sticky top-0 z-30 w-full border-b border-line bg-white/95 backdrop-blur-md">
      {/* One nav for every width: inline from lg; below lg it wraps onto its
          own row under the brand, so phones and tablets keep every tab. */}
      <div
        className={clsx(
          "mx-auto flex w-full flex-wrap items-center justify-between gap-x-3 sm:gap-x-4 lg:h-16 lg:flex-nowrap",
          PAGE_WIDTH_CLASS.wide,
          PAGE_PADDING_CLASS.wide
        )}
      >
        {/* Compact on phones so the brand and the account buttons share one
            row down to 360px; narrower than that, only the icon shows. */}
        <Link href="/" className="flex h-14 shrink-0 items-center gap-2 sm:gap-2.5 lg:h-auto">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary-600 text-white shadow-sm sm:h-10 sm:w-10" aria-hidden="true">
            <Headphones size={20} />
          </span>
          <span className="max-[359px]:sr-only">
            <span className="block text-lg font-bold leading-none tracking-tight text-ink sm:text-xl">
              Dicta<span className="text-primary-600">Learn</span>
            </span>
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted">Studio</span>
          </span>
        </Link>

        <nav
          ref={navRef}
          aria-label="Primary"
          className={clsx(
            // Below lg: a full-bleed row (the negative margins cancel
            // PAGE_PADDING_CLASS.wide) that scrolls sideways if it must.
            // Scrollbar hidden at every width.
            "order-last -mx-4 flex w-[calc(100%+2rem)] items-center gap-1 overflow-x-auto px-4 pb-2.5 [scrollbar-width:none] sm:-mx-6 sm:w-[calc(100%+3rem)] sm:px-6 [&::-webkit-scrollbar]:hidden",
            // lg+: inline between brand and actions; min-w-0 lets it give way
            // (and scroll) before the account menu is pushed off-screen.
            "lg:order-none lg:mx-0 lg:w-auto lg:min-w-0 lg:gap-0.5 lg:px-0 lg:py-1 2xl:gap-1"
          )}
        >
          {NAV_LINKS.map((link) => {
            const isActive = active === link.key;
            return (
              <Link
                key={link.key}
                href={link.href}
                aria-current={isActive ? "page" : undefined}
                className={clsx(
                  "shrink-0 whitespace-nowrap rounded-lg px-3 py-2 text-sm transition-colors lg:px-2.5 lg:py-1.5 lg:text-xs 2xl:px-3.5 2xl:text-sm",
                  isActive ? "bg-primary-50 font-semibold text-primary-600" : "font-medium text-muted hover:bg-surface hover:text-ink"
                )}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>

        <div className="flex shrink-0 items-center gap-2 sm:gap-3">
          {user && (
            <button
              type="button"
              onClick={newVideo.open}
              aria-haspopup="dialog"
              aria-label="New video"
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line bg-primary-50 px-2.5 py-1.5 text-xs font-semibold text-primary-600 transition-colors hover:border-primary-500/40 hover:bg-primary-100 sm:px-3"
            >
              <Plus size={14} strokeWidth={2.25} aria-hidden="true" />
              <span className="hidden whitespace-nowrap sm:inline lg:hidden xl:inline">New video</span>
            </button>
          )}
          {user && streak && <StreakPill streakDays={streak.streakDays} userId={user.id} />}
          {user && xp && <XpPill totalXp={xp.totalXp} level={xp.level} />}
          <UserButton />
        </div>
      </div>
      {newVideo.dialog}
    </header>
  );
}
