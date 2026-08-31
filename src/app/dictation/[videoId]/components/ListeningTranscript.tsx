"use client";

export function ListeningTranscript({
  text,
  fontSizePx,
}: {
  text: string;
  /** Overrides the default text-xl size — set by the mobile transcript stage's
   *  auto-fit hook when a long sentence needs a smaller size to fit without
   *  resizing the stage itself. Omitted (desktop) keeps the default size. */
  fontSizePx?: number;
}) {
  return (
    <div
      data-transcript-english
      style={fontSizePx ? { fontSize: `${fontSizePx}px` } : undefined}
      className="w-full select-text whitespace-normal break-words px-2 py-4 text-center text-xl font-medium leading-loose text-[var(--text)] md:px-14"
    >
      {text || <span className="text-[var(--text-faint)]">…</span>}
    </div>
  );
}
