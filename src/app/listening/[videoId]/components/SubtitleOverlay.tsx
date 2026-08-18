"use client";

import clsx from "clsx";
import type { ListeningSegment } from "../types";

interface SubtitleOverlayProps {
  segment: ListeningSegment | null;
  showScript: boolean;
  showTranslation: boolean;
}

export function SubtitleOverlay({ segment, showScript, showTranslation }: SubtitleOverlayProps) {
  if (!segment || (!showScript && !showTranslation)) return null;

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center p-4">
      <div className="max-w-[90%] rounded-2xl bg-black/70 px-5 py-3 text-center shadow-lg backdrop-blur-sm">
        {showScript && <p className="text-base font-medium leading-snug text-white">{segment.textEn}</p>}
        {showTranslation && (
          <p className={clsx("text-sm leading-snug text-indigo-200", showScript && "mt-1")}>
            {segment.textVi ?? "Translating…"}
          </p>
        )}
      </div>
    </div>
  );
}
