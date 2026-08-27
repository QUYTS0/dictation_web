export function ControlButton({
  icon,
  shortcut,
  label,
  primary,
  active,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  shortcut: string;
  label: string;
  primary?: boolean;
  active?: boolean;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col items-center gap-1 group">
      <button
        onClick={onClick}
        disabled={disabled}
        title={shortcut}
        aria-label={label}
        aria-pressed={active}
        className={`w-11 h-11 sm:w-12 sm:h-12 rounded-2xl flex items-center justify-center transition-all shadow-sm border disabled:opacity-40 disabled:cursor-not-allowed ${primary ? "bg-[var(--accent)] border-[var(--accent)] text-[#1a1206] hover:brightness-110 hover:shadow-md hover:-translate-y-0.5" : active ? "bg-[var(--accent-soft)] border-[var(--accent-border)] text-[var(--accent)] hover:brightness-110" : "bg-[var(--surface-glass)] border-[var(--border)] text-[var(--text-muted)] hover:bg-white/10 hover:border-[var(--border-strong)]"}`}
      >
        {icon}
      </button>
      <div className="opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity flex flex-col items-center">
        <span className="text-[10px] font-semibold text-[var(--text-faint)]">{label}</span>
      </div>
    </div>
  );
}
