"use client";

import { clsx } from "clsx";

interface ProgressBarProps {
  currentIndex: number;
  totalSegments: number;
  accuracy: number;
  tone?: "default" | "zen";
}

export default function ProgressBar({
  currentIndex,
  totalSegments,
  accuracy,
  tone = "default",
}: ProgressBarProps) {
  const pct = totalSegments > 0 ? Math.round((currentIndex / totalSegments) * 100) : 0;
  const isZen = tone === "zen";

  return (
    <div className="flex flex-col gap-1">
      {/* Labels row */}
      <div className={clsx("flex justify-between text-xs font-medium", isZen ? "text-white/50" : "text-slate-500")}>
        <span>
          Sentence {currentIndex + 1} / {totalSegments}
        </span>
        <span>
          Accuracy{" "}
          <span
            className={clsx(
              "font-bold",
              accuracy >= 80 ? "text-emerald-500" : accuracy >= 50 ? "text-amber-500" : "text-red-500"
            )}
          >
            {accuracy}%
          </span>
        </span>
      </div>

      {/* Progress track */}
      <div className={clsx("h-2 w-full rounded-full overflow-hidden", isZen ? "bg-white/10" : "bg-slate-200")}>
        <div
          className="h-full rounded-full bg-indigo-500 transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
