export function ControlButton({
  icon,
  shortcut,
  label,
  primary,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  shortcut: string;
  label: string;
  primary?: boolean;
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
        className={`w-12 h-12 rounded-2xl flex items-center justify-center transition-all shadow-sm border border-white/60 dark:border-white/10 disabled:opacity-40 disabled:cursor-not-allowed ${primary ? "bg-indigo-600 text-white hover:bg-indigo-700 hover:shadow-md hover:-translate-y-0.5" : "bg-white/60 dark:bg-white/5 text-slate-700 dark:text-slate-300 hover:bg-white dark:hover:bg-white/10 hover:border-slate-300 dark:hover:border-slate-600"}`}
      >
        {icon}
      </button>
      <div className="opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center">
        <span className="text-[10px] font-semibold text-slate-400 dark:text-slate-500">{label}</span>
      </div>
    </div>
  );
}
