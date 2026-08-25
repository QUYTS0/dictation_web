"use client";

import type { ReactNode } from "react";
import { motion, AnimatePresence } from "motion/react";

/**
 * A phone-only (sm:hidden) sheet that slides up from the bottom, used for
 * secondary controls that don't fit the compact phone toolbar. Desktop/
 * tablet callers should render their own layout instead of this component.
 */
export function MobileBottomSheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-[65] bg-slate-950/50 sm:hidden"
            onClick={onClose}
          />
          <motion.div
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "tween", ease: "easeOut", duration: 0.25 }}
            className="fixed inset-x-0 bottom-0 z-[70] max-h-[80dvh] overflow-y-auto rounded-t-3xl border-t border-white/60 bg-white/95 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl backdrop-blur-xl sm:hidden"
            role="dialog"
            aria-modal="true"
            aria-label={title}
          >
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-slate-300" aria-hidden="true" />
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
              <button
                type="button"
                onClick={onClose}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100"
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            {children}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
