import { clsx } from "clsx";
import { MODE_ICONS } from "../constants";
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
  mode,
  onClick,
}: {
  active: boolean;
  title: string;
  description: string;
  mode: InputMode;
  onClick: () => void;
}) {
  const Icon = MODE_ICONS[mode];
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
      <ModeIcon active={active}>
        <Icon size={16} />
      </ModeIcon>
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
        mode="listening"
      />

      <ModeOption
        active={inputMode === "shadowing"}
        onClick={() => onSelectMode("shadowing")}
        title="Shadowing"
        description="Listen, repeat it back, and record yourself"
        mode="shadowing"
      />

      <ModeOption
        active={inputMode === "dictation"}
        onClick={() => onSelectMode("dictation")}
        title="Dictation"
        description="Listen and type what you hear"
        mode="dictation"
      />
    </div>
  );
}
