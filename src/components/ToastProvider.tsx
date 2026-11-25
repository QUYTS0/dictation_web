"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { AlertCircle, Sparkles, X } from "lucide-react";

export interface ToastInput {
  message: string;
  sub?: string;
  tone?: "default" | "error";
}

interface Toast extends ToastInput {
  id: number;
}

const DURATION_MS = 3200;
const MAX_VISIBLE = 3;

const ToastContext = createContext<((toast: ToastInput) => void) | null>(null);
const noop = () => {};

/**
 * App-wide toasts (level-ups, unlocks, goal met, failed writes). Polite live
 * region, bottom-right, auto-dismissed, at most three at once. Mounted once
 * in Providers; `useToast()` outside it is a no-op so components stay
 * renderable in isolation (tests, stories).
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const show = useCallback(
    (toast: ToastInput) => {
      const id = nextId.current++;
      setToasts((current) => [...current.slice(-(MAX_VISIBLE - 1)), { ...toast, id }]);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), DURATION_MS)
      );
    },
    [dismiss]
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
    };
  }, []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed bottom-6 right-6 z-[100] flex max-w-[calc(100vw-3rem)] flex-col items-end gap-2"
      >
        {toasts.map((toast) => {
          const isError = toast.tone === "error";
          const Icon = isError ? AlertCircle : Sparkles;
          return (
            <div
              key={toast.id}
              data-testid="toast"
              className="pointer-events-auto flex items-center gap-3 rounded-2xl border border-hero-2 bg-hero px-4 py-3 text-white shadow-xl"
            >
              <span
                className={
                  isError
                    ? "flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-danger/20 text-danger"
                    : "flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary-600/30 text-primary-100"
                }
                aria-hidden="true"
              >
                <Icon size={14} />
              </span>
              <div className="min-w-0">
                <p className="text-xs font-semibold leading-tight">{toast.message}</p>
                {toast.sub && <p className="text-[11px] text-slate-300">{toast.sub}</p>}
              </div>
              <button
                type="button"
                onClick={() => dismiss(toast.id)}
                aria-label="Dismiss notification"
                className="ml-1 rounded-md p-1 text-slate-400 transition-colors hover:bg-white/10 hover:text-white"
              >
                <X size={13} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): (toast: ToastInput) => void {
  return useContext(ToastContext) ?? noop;
}
