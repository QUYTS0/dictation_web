"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/context/auth";

/**
 * Shows a "Sign in" button for guests, or a compact user avatar / email +
 * sign-out dropdown for authenticated users.
 */
export default function UserButton() {
  const { user, loading, signOut, openAuthModal } = useAuth();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (e: PointerEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

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
      <div className="relative" ref={containerRef}>
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Account menu"
          className="block rounded-full"
        >
          {avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={avatarUrl}
              alt=""
              width={36}
              height={36}
              className="w-9 h-9 rounded-full cursor-pointer border-2 border-slate-200"
            />
          ) : (
            <div className="w-9 h-9 rounded-full bg-indigo-600 text-white flex items-center justify-center text-sm font-bold cursor-pointer select-none">
              {initials}
            </div>
          )}
        </button>
        {open && (
          <div
            role="menu"
            aria-label="Account menu"
            className="absolute right-0 top-full mt-1 block bg-white border border-slate-200 rounded-xl shadow-lg py-1 min-w-[180px] z-50"
          >
            <div
              className="px-4 py-2 text-xs text-slate-500 border-b border-slate-100 truncate"
              aria-label="User account email"
            >
              {user.email}
            </div>
            <button
              role="menuitem"
              onClick={() => {
                setOpen(false);
                signOut();
              }}
              className="block w-full text-left px-4 py-2 text-sm text-slate-700 hover:bg-slate-50"
            >
              Sign out
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
