import { clsx } from "clsx";
import type { ComparedToken } from "../types";

export function ComparedSentenceText({
  tokens,
  tone,
  emptyFallback,
}: {
  tokens: ComparedToken[];
  tone: "expected" | "user";
  emptyFallback?: string;
}) {
  if (tokens.length === 0) {
    return <p className="mt-0.5 text-sm text-slate-500">{emptyFallback ?? ""}</p>;
  }

  return (
    <p
      className={clsx(
        "mt-0.5 text-sm select-text cursor-text rounded px-1 -mx-1",
        tone === "expected"
          ? "text-slate-900 hover:bg-emerald-100/60 focus:bg-emerald-100/60"
          : "text-slate-800 hover:bg-slate-200/70 focus:bg-slate-200/70"
      )}
    >
      {tokens.map((token, index) => (
        <span
          key={`${token.word}-${index}`}
          className={clsx(
            token.status === "missing" && "rounded bg-rose-100 px-0.5 text-rose-700",
            token.status === "wrong" && "rounded bg-amber-100 px-0.5 text-amber-700",
            token.status === "extra" && "rounded bg-violet-100 px-0.5 text-violet-700"
          )}
        >
          {token.word}
          {index < tokens.length - 1 ? " " : ""}
        </span>
      ))}
    </p>
  );
}
