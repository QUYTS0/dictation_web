"use client";

import { clsx } from "clsx";
import { getHint } from "@/lib/utils/segment";
import type { HintLevel } from "@/lib/types";

interface HintDisplayProps {
  text: string;
  level: HintLevel;
  onLevelChange: (level: HintLevel) => void;
}

const HINT_LABELS: Record<HintLevel, string> = {
  0: "Hint",
  1: "First letters",
  2: "Word count",
  3: "Partial reveal",
  4: "Full answer",
};

export default function HintDisplay({
  text,
  level,
  onLevelChange,
}: HintDisplayProps) {
  const { hint } = getHint(text, level);

  const nextLevel = Math.min(level + 1, 4) as HintLevel;

  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-amber-700 font-semibold text-sm">
          💡 {level === 0 ? "Need a hint?" : HINT_LABELS[level]}
        </span>
        {level < 4 && (
          <button
            onClick={() => onLevelChange(nextLevel)}
            className="text-xs px-3 py-1 rounded-full bg-amber-200 text-amber-800 hover:bg-amber-300 font-medium transition-colors"
          >
            {level === 0 ? "Show hint" : "More help"}
          </button>
        )}
      </div>

      {level > 0 && hint && (
        <p
          className={clsx(
            "font-mono text-base tracking-wide",
            level === 4 ? "text-emerald-700 font-semibold" : "text-amber-900"
          )}
        >
          {hint}
        </p>
      )}
    </div>
  );
}
