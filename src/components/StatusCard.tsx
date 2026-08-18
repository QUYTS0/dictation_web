import { clsx } from "clsx";

export function StatusCard({
  icon,
  title,
  description,
  pulse,
  error,
  onRetry,
  retryLabel = "Try again",
}: {
  icon: string;
  title: string;
  description: string;
  pulse?: boolean;
  error?: boolean;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div
      role={error ? "alert" : pulse ? "status" : undefined}
      className={clsx(
        "flex flex-col gap-2 rounded-xl border p-5 shadow-sm backdrop-blur-md",
        error
          ? "border-red-300/60 bg-red-50/50"
          : "border-white/60 bg-white/50",
        pulse && "animate-pulse"
      )}
    >
      <p className="text-2xl" aria-hidden="true">{icon}</p>
      <p className="font-semibold text-slate-800">{title}</p>
      <p className="text-sm text-slate-500">{description}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="self-start rounded-lg border border-red-300 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50 transition-colors"
        >
          {retryLabel}
        </button>
      )}
    </div>
  );
}
