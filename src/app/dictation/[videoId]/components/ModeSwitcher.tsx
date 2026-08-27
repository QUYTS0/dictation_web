import Link from "next/link";
import { clsx } from "clsx";

function ModeIcon({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-[var(--surface-2)] text-[var(--text-muted)]">
      {children}
    </div>
  );
}

export function ModeSwitcher({ videoId }: { videoId: string }) {
  return (
    <div className="flex w-[300px] flex-col gap-0.5 rounded-2xl border border-[var(--border-strong)] bg-[var(--surface)] p-2 shadow-2xl">
      <Link
        href={`/listening/${videoId}`}
        className="flex items-center gap-3 rounded-xl p-3 hover:bg-white/5"
      >
        <ModeIcon>
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="6" height="6" rx="1.5" />
            <rect x="11" y="3" width="6" height="6" rx="1.5" />
            <rect x="3" y="11" width="6" height="6" rx="1.5" />
            <rect x="11" y="11" width="6" height="6" rx="1.5" />
          </svg>
        </ModeIcon>
        <div>
          <div className="text-[13.5px] font-semibold text-[var(--text)]">Watch &amp; Listen</div>
          <div className="mt-0.5 text-[11.5px] text-[var(--text-muted)]">Watch videos &amp; listen to podcasts</div>
        </div>
      </Link>

      <div
        className="flex cursor-not-allowed items-center gap-3 rounded-xl p-3 opacity-50"
        title="Coming soon"
      >
        <ModeIcon>
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <rect x="7" y="2.5" width="6" height="9" rx="3" />
            <path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5M7.5 17.5h5" />
          </svg>
        </ModeIcon>
        <div>
          <div className="text-[13.5px] font-semibold text-[var(--text)]">Shadowing</div>
          <div className="mt-0.5 text-[11.5px] text-[var(--text-muted)]">Coming soon</div>
        </div>
      </div>

      <div className={clsx("flex items-center gap-3 rounded-xl border p-3", "border-[var(--accent-border)] bg-[var(--accent-soft)]")}>
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-[var(--accent)] text-[#1a1206]">
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="5" width="16" height="10" rx="2" />
            <path d="M5 8h.01M8 8h.01M11 8h.01M14 8h.01M5 11h.01M14 11h.01M8 11h4" />
          </svg>
        </div>
        <div>
          <div className="text-[13.5px] font-semibold text-[var(--accent)]">Dictation</div>
          <div className="mt-0.5 text-[11.5px] text-[var(--text-muted)]">Listen and type what you hear</div>
        </div>
      </div>
    </div>
  );
}
