"use client";

export function ListeningTranscript({ text }: { text: string }) {
  return (
    <div className="w-full select-text whitespace-normal break-words px-4 py-4 text-center text-xl font-medium leading-loose text-[var(--text)] md:px-14">
      {text || <span className="text-[var(--text-faint)]">…</span>}
    </div>
  );
}
