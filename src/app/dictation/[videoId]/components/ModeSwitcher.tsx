import { clsx } from "clsx";
import type { InputMode } from "../types";

function ModeIcon({ children, active }: { children: React.ReactNode; active?: boolean }) {
  return (
    <div
      className={clsx(
        "flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px]",
        active ? "bg-[var(--accent)] text-[#1a1206]" : "bg-[var(--surface-2)] text-[var(--text-muted)]"
      )}
    >
      {children}
    </div>
  );
}

function ModeOption({
  active,
  title,
  description,
  icon,
  onClick,
}: {
  active: boolean;
  title: string;
  description: string;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        "flex items-center gap-3 rounded-xl border p-3 text-left transition-colors",
        active
          ? "border-[var(--accent-border)] bg-[var(--accent-soft)]"
          : "border-transparent hover:bg-white/5"
      )}
    >
      <ModeIcon active={active}>{icon}</ModeIcon>
      <div>
        <div className={clsx("text-[13.5px] font-semibold", active ? "text-[var(--accent)]" : "text-[var(--text)]")}>
          {title}
        </div>
        <div className="mt-0.5 text-[11.5px] text-[var(--text-muted)]">{description}</div>
      </div>
    </button>
  );
}

export function ModeSwitcher({
  inputMode,
  onSelectMode,
}: {
  inputMode: InputMode;
  onSelectMode: (mode: InputMode) => void;
}) {
  return (
    <div className="flex w-[300px] flex-col gap-0.5 rounded-2xl border border-[var(--border-strong)] bg-[var(--surface)] p-2 shadow-2xl">
      <ModeOption
        active={inputMode === "listening"}
        onClick={() => onSelectMode("listening")}
        title="Listening Mode"
        description="Watch & listen — read the transcript instead of typing"
        icon={
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="6" height="6" rx="1.5" />
            <rect x="11" y="3" width="6" height="6" rx="1.5" />
            <rect x="3" y="11" width="6" height="6" rx="1.5" />
            <rect x="11" y="11" width="6" height="6" rx="1.5" />
          </svg>
        }
      />

      <ModeOption
        active={inputMode === "shadowing"}
        onClick={() => onSelectMode("shadowing")}
        title="Shadowing"
        description="Listen, repeat it back, and record yourself"
        icon={
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <rect x="7" y="2.5" width="6" height="9" rx="3" />
            <path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5M7.5 17.5h5" />
          </svg>
        }
      />

      <ModeOption
        active={inputMode === "dictation"}
        onClick={() => onSelectMode("dictation")}
        title="Dictation"
        description="Listen and type what you hear"
        icon={
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="5" width="16" height="10" rx="2" />
            <path d="M5 8h.01M8 8h.01M11 8h.01M14 8h.01M5 11h.01M14 11h.01M8 11h4" />
          </svg>
        }
      />
    </div>
  );
}
