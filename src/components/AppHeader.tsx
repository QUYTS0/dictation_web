"use client";

import Link from "next/link";
import { Headphones } from "lucide-react";
import UserButton from "@/components/UserButton";

const NAV_LINKS = [
  { key: "dashboard", href: "/dashboard", label: "Dashboard" },
  { key: "listening", href: "/listening", label: "Listening" },
  { key: "vocabulary", href: "/vocabulary", label: "Vocabulary" },
  { key: "history", href: "/history", label: "History" },
] as const;

type NavKey = (typeof NAV_LINKS)[number]["key"];

interface AppHeaderProps {
  /** Highlights the matching nav link as the current page. */
  active?: NavKey;
}

/**
 * Shared app-shell header (logo + primary nav + UserButton) used by every
 * signed-in page (home, dashboard, listening). The dictation/listening
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
        <div className="flex items-center gap-6">
          <nav className="hidden gap-6 md:flex">
            {NAV_LINKS.map((link) => (
              <Link
                key={link.key}
                href={link.href}
                className={
                  active === link.key
                    ? "text-sm font-bold text-primary-600"
                    : "text-sm font-medium text-slate-500 transition-colors hover:text-primary-600"
                }
              >
                {link.label}
              </Link>
            ))}
          </nav>
          <UserButton />
        </div>
      </div>
    </header>
  );
}
