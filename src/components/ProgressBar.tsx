"use client";

import { clsx } from "clsx";
import { AnimatePresence, motion } from "motion/react";

interface ProgressBarProps {
  currentIndex: number;
  totalSegments: number;
  accuracy: number;
  combo?: number;
}

export default function ProgressBar({
  currentIndex,
  totalSegments,
  accuracy,
  combo = 0,
}: ProgressBarProps) {
  const pct = totalSegments > 0 ? Math.round((currentIndex / totalSegments) * 100) : 0;

  return (
    <div className="flex flex-col gap-1">
      {/* Labels row */}
      <div className="flex justify-between items-center text-xs text-slate-500 font-medium">
        <span>
          Sentence {currentIndex + 1} / {totalSegments}
        </span>
        <div className="flex items-center gap-2">
          <AnimatePresence>
            {combo >= 2 && (
              <motion.span
                key={combo}
                initial={{ opacity: 0, scale: 0.6 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.6 }}
                transition={{ type: "spring", stiffness: 500, damping: 20 }}
                className="rounded-full bg-orange-100 px-2 py-0.5 text-[11px] font-bold text-orange-600"
              >
                🔥 {combo} in a row
              </motion.span>
            )}
          </AnimatePresence>
          <span>
            Accuracy{" "}
            <span
              className={clsx(
                "font-bold",
                accuracy >= 80 ? "text-emerald-600" : accuracy >= 50 ? "text-amber-600" : "text-red-500"
              )}
            >
              {accuracy}%
            </span>
          </span>
        </div>
      </div>

      {/* Progress track */}
      <div className="h-2 w-full rounded-full bg-slate-200 overflow-hidden">
        <div
          className="h-full rounded-full bg-indigo-500 transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
