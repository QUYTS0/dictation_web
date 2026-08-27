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
    return <p className="mt-0.5 text-sm text-[var(--text-muted)]">{emptyFallback ?? ""}</p>;
  }

  return (
    <p
      className={clsx(
        "mt-0.5 text-sm select-text cursor-text rounded px-1 -mx-1",
        tone === "expected"
          ? "text-[var(--text)] hover:bg-[var(--green)]/15 focus:bg-[var(--green)]/15"
          : "text-[var(--text-muted)] hover:bg-white/10 focus:bg-white/10"
      )}
    >
      {tokens.map((token, index) => (
        <span
          key={`${token.word}-${index}`}
          className={clsx(
            // In the expected/correct sentence, the word the user got wrong is
            // highlighted (not flagged red) — it IS the correct word, just the
            // point of difference worth drawing the eye to.
            token.status === "missing" && "rounded bg-[var(--green)]/20 px-0.5",
            token.status === "wrong" && "text-[var(--red)] line-through",
            token.status === "extra" && "rounded bg-[var(--purple)]/20 px-0.5 text-[var(--purple)]"
          )}
        >
          {token.word}
          {index < tokens.length - 1 ? " " : ""}
        </span>
      ))}
    </p>
  );
}
