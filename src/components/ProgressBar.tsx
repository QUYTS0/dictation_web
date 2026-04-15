"use client";

import { clsx } from "clsx";

interface ProgressBarProps {
  currentIndex: number;
  totalSegments: number;
  accuracy: number;
}

export default function ProgressBar({
  currentIndex,
  totalSegments,
  accuracy,
}: ProgressBarProps) {
  const pct = totalSegments > 0 ? Math.round((currentIndex / totalSegments) * 100) : 0;

  return (
    <div className="flex flex-col gap-1">
      {/* Labels row */}
      <div className="flex justify-between text-xs text-slate-500 font-medium">
        <span>
          Sentence {currentIndex + 1} / {totalSegments}
        </span>
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
