import { clsx } from "clsx";

export function ControlButton({
  icon,
  shortcut,
  label,
  primary,
  active,
  recording,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  shortcut: string;
  label: string;
  primary?: boolean;
  active?: boolean;
  /** Distinct "recording in progress" styling — a red ring plus a pulsing
   *  dot badge, visually different from the ordinary `active` (accent)
   *  toggle state so a learner never mistakes "recording" for a normal
   *  toggled-on control. */
  recording?: boolean;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="relative flex items-center justify-center group">
      <button
        onClick={onClick}
        disabled={disabled}
        title={shortcut}
        aria-label={label}
        aria-pressed={active || recording}
        className={clsx(
          "w-10 h-10 sm:w-12 sm:h-12 rounded-2xl flex items-center justify-center transition-all shadow-sm border disabled:opacity-40 disabled:cursor-not-allowed",
          recording
            ? "bg-[var(--red)]/15 border-[var(--red)] text-[var(--red)] hover:brightness-110"
            : primary
            ? "bg-[var(--accent)] border-[var(--accent)] text-[#1a1206] hover:brightness-110 hover:shadow-md hover:-translate-y-0.5"
            : active
            ? "bg-[var(--accent-soft)] border-[var(--accent-border)] text-[var(--accent)] hover:brightness-110"
            : "bg-[var(--surface-glass)] border-[var(--border)] text-[var(--text-muted)] hover:bg-white/10 hover:border-[var(--border-strong)]"
        )}
      >
        {icon}
        {recording && (
          <span
            className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 animate-pulse rounded-full bg-[var(--red)] ring-2 ring-[var(--surface)]"
            aria-hidden="true"
          />
        )}
      </button>
      <span className="pointer-events-none absolute top-full mt-1 hidden whitespace-nowrap text-[10px] font-semibold text-[var(--text-faint)] sm:group-hover:block">
        {label}
      </span>
    </div>
  );
}
