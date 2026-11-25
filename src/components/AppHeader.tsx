"use client";

import { useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { Headphones, Plus } from "lucide-react";
import UserButton from "@/components/UserButton";
import { AddVideoDialog } from "@/components/AddVideoDialog";
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
 * (from lg; hidden while XP is unavailable) and the account menu. The dictation/listening workspace uses its own compact
 * title-bar header instead (back button + progress label, zen-mode aware).
 */
export default function AppHeader({ active }: AppHeaderProps) {
  const { user } = useAuth();
  const streak = useStreakQuery(user?.id).data;
  const xp = useXpQuery(user?.id).data;
  const [addOpen, setAddOpen] = useState(false);
  // Kept here so closing and reopening the dialog keeps a half-typed link.
  const [addUrl, setAddUrl] = useState("");

  return (
    <header className="sticky top-0 z-30 w-full border-b border-line bg-white/95 backdrop-blur-md">
      <div className={clsx("mx-auto flex h-16 w-full items-center justify-between gap-4", PAGE_WIDTH_CLASS.wide, PAGE_PADDING_CLASS.wide)}>
        <Link href="/" className="flex shrink-0 items-center gap-2.5">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary-600 text-white shadow-sm" aria-hidden="true">
            <Headphones size={20} />
          </span>
          <span>
            <span className="block text-xl font-bold leading-none tracking-tight text-ink">
              Dicta<span className="text-primary-600">Learn</span>
            </span>
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted">Studio</span>
          </span>
        </Link>

        <nav aria-label="Primary" className="hidden items-center gap-0.5 md:flex xl:gap-1">
          {NAV_LINKS.map((link) => {
            const isActive = active === link.key;
            return (
              <Link
                key={link.key}
                href={link.href}
                aria-current={isActive ? "page" : undefined}
                className={clsx(
                  "whitespace-nowrap rounded-lg px-2.5 py-1.5 text-xs transition-colors xl:px-3.5 xl:text-sm",
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
              onClick={() => setAddOpen(true)}
              aria-haspopup="dialog"
              aria-label="New video"
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line bg-primary-50 px-2.5 py-1.5 text-xs font-semibold text-primary-600 transition-colors hover:border-primary-500/40 hover:bg-primary-100 sm:px-3"
            >
              <Plus size={14} strokeWidth={2.25} aria-hidden="true" />
              <span className="hidden whitespace-nowrap sm:inline">New video</span>
            </button>
          )}
          {user && streak && <StreakPill streakDays={streak.streakDays} userId={user.id} />}
          {user && xp && <XpPill totalXp={xp.totalXp} level={xp.level} />}
          <UserButton />
        </div>
      </div>
      {addOpen && <AddVideoDialog url={addUrl} onUrlChange={setAddUrl} onClose={() => setAddOpen(false)} />}
    </header>
  );
}
