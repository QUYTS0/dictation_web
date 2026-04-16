"use client";

import Link from "next/link";
import { useAuth } from "@/context/auth";

/**
 * Shows a "Sign in" button for guests, or a compact user avatar / email +
 * sign-out dropdown for authenticated users.
 */
export default function UserButton() {
  const { user, loading, signOut, openAuthModal } = useAuth();

  if (loading) return null;

  if (!user) {
    return (
      <button
        onClick={openAuthModal}
        className="px-4 py-1.5 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 transition-colors"
      >
        Sign in
      </button>
    );
  }

  const initials = (user.user_metadata?.full_name as string)?.[0]?.toUpperCase()
    ?? user.email?.[0]?.toUpperCase()
    ?? "U";
  const avatarUrl = user.user_metadata?.avatar_url as string | undefined;

  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-slate-600 hidden sm:block truncate max-w-[160px]">
        {user.email}
      </span>
      {/* Avatar with hover dropdown */}
      <div className="relative group">
        {avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={avatarUrl}
            alt="User avatar"
            width={32}
            height={32}
            className="w-8 h-8 rounded-full cursor-pointer border-2 border-slate-200"
          />
        ) : (
          <div className="w-8 h-8 rounded-full bg-indigo-600 text-white flex items-center justify-center text-sm font-bold cursor-pointer select-none">
            {initials}
          </div>
        )}
        {/* Dropdown */}
        <div className="absolute right-0 top-full mt-1 hidden group-hover:block bg-white border border-slate-200 rounded-xl shadow-lg py-1 min-w-[120px] z-50">
          <Link
            href="/dashboard"
            className="block w-full text-left px-4 py-2 text-sm text-slate-700 hover:bg-slate-50"
          >
            Dashboard
          </Link>
          <Link
            href="/vocabulary"
            className="block w-full text-left px-4 py-2 text-sm text-slate-700 hover:bg-slate-50"
          >
            Vocabulary
          </Link>
          <button
            onClick={signOut}
            className="block w-full text-left px-4 py-2 text-sm text-slate-700 hover:bg-slate-50"
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
