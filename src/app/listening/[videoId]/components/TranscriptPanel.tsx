"use client";

import { useEffect, useRef } from "react";
import clsx from "clsx";
import type { ListeningSegment } from "../types";

interface TranscriptPanelProps {
  segments: ListeningSegment[];
  activeSegmentIndex: number;
  showScript: boolean;
  showTranslation: boolean;
  onSeek: (segment: ListeningSegment) => void;
}

export function TranscriptPanel({
  segments,
  activeSegmentIndex,
  showScript,
  showTranslation,
  onSeek,
}: TranscriptPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const activeCard = container.querySelector<HTMLElement>(
      `[data-listening-segment-index="${activeSegmentIndex}"]`
    );
    activeCard?.scrollIntoView({ block: "nearest" });
  }, [activeSegmentIndex]);

  if (segments.length === 0) {
    return <p className="text-sm text-slate-500">Script is not available yet.</p>;
  }

  return (
    <div ref={containerRef} className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1">
      {segments.map((segment) => {
        const isActive = segment.segmentIndex === activeSegmentIndex;
        return (
          <button
            key={segment.segmentIndex}
            type="button"
            data-listening-segment-index={segment.segmentIndex}
            onClick={() => onSeek(segment)}
            className={clsx(
              "w-full rounded-xl border p-3 text-left shadow-sm transition-colors",
              isActive
                ? "border-primary-200 bg-white/80 ring-2 ring-primary-500/20"
                : "border-white/60 bg-white/40 opacity-80 hover:opacity-100"
            )}
          >
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[9px] font-bold uppercase tracking-widest text-slate-500">
                Sentence #{segment.segmentIndex + 1}
              </span>
              {isActive && <div className="h-2 w-2 animate-pulse rounded-full bg-primary-500" />}
            </div>
            {showScript && (
              <p
                className={clsx(
                  "text-sm leading-relaxed",
                  isActive ? "font-medium text-slate-900" : "text-slate-600"
                )}
              >
                {segment.textEn}
              </p>
            )}
            {showTranslation && (
              <p className="mt-1 text-sm leading-relaxed text-primary-700">{segment.textVi ?? "…"}</p>
            )}
          </button>
        );
      })}
    </div>
  );
}
