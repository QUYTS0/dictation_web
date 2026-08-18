"use client";

import Link from "next/link";
import clsx from "clsx";
import { BookOpen, Headphones, History, LayoutDashboard } from "lucide-react";
import UserButton from "@/components/UserButton";

const NAV_LINKS = [
  { key: "dashboard", href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { key: "vocabulary", href: "/vocabulary", label: "Vocabulary", icon: BookOpen },
  { key: "history", href: "/history", label: "History", icon: History },
] as const;

type NavKey = (typeof NAV_LINKS)[number]["key"];

interface AppHeaderProps {
  /** Highlights the matching nav link as the current page. */
  active?: NavKey;
}

/**
 * Shared app-shell header (logo + primary nav + UserButton) used by every
 * signed-in page (dashboard, vocabulary, history). The dictation/listening
 * workspace pages use their own compact title-bar header instead, since
 * that's a distinct pattern (back button + progress label, zen-mode aware).
 */
export default function AppHeader({ active }: AppHeaderProps) {
  return (
    <header className="sticky top-0 z-10 w-full border-b border-white/40 bg-white/30 px-6 py-4 backdrop-blur-md">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between">
        <Link href="/" className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-600 text-white">
            <Headphones size={18} />
          </div>
          <span className="text-lg font-semibold tracking-tight text-slate-900">DictaLearn</span>
        </Link>
        <div className="flex items-center gap-4">
          <nav className="hidden items-center gap-1 rounded-full border border-white/60 bg-white/40 p-1 shadow-sm backdrop-blur-md md:flex">
            {NAV_LINKS.map((link) => {
              const Icon = link.icon;
              const isActive = active === link.key;
              return (
                <Link
                  key={link.key}
                  href={link.href}
                  className={clsx(
                    "flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-semibold transition-colors",
                    isActive
                      ? "bg-primary-600 text-white shadow-sm"
                      : "text-slate-600 hover:bg-white/80 hover:text-slate-900"
                  )}
                >
                  <Icon size={16} />
                  {link.label}
                </Link>
              );
            })}
          </nav>
          <UserButton />
        </div>
      </div>
    </header>
  );
}
