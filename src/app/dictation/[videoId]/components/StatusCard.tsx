import { clsx } from "clsx";

export function StatusCard({
  icon,
  title,
  description,
  pulse,
  error,
}: {
  icon: string;
  title: string;
  description: string;
  pulse?: boolean;
  error?: boolean;
}) {
  return (
    <div
      className={clsx(
        "rounded-xl border p-5 flex flex-col gap-2",
        error
          ? "border-red-300 bg-red-50"
          : "border-slate-200 bg-white"
      )}
    >
      <p className={clsx("text-2xl", pulse && "animate-pulse")}>{icon}</p>
      <p className="font-semibold text-slate-800">{title}</p>
      <p className="text-sm text-slate-500">{description}</p>
    </div>
  );
}
