"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { clsx } from "clsx";
import { ChevronDown, FileText, RotateCcw, ArrowRight } from "lucide-react";
import type { RoundMenuItem, RoundMenuItemKind, RoundMenuModel } from "@/lib/practice/roundMenu";

const ICON: Record<RoundMenuItemKind, typeof FileText> = {
  view_report: FileText,
  practice_again_new_round: RotateCcw,
  go_to_current_round: ArrowRight,
};

export interface RoundMenuProps {
  model: RoundMenuModel;
  onViewReport: () => void;
  onNewRound: () => void;
  /** Where "Go to current round" leads (a full page load of the video). */
  currentRoundHref: string;
  /** "bar": the top bar (compact "Round" below sm); "zen": the Zen controls. */
  variant?: "bar" | "zen";
}

/**
 * The Round menu (Learning Reports P2 follow-up): the current round's report
 * and the explicit "new round" action, reachable throughout practice. The
 * same model and handlers serve every layout; only the trigger's look
 * differs. Selecting an item only calls the page's handler — the menu
 * itself never writes, and "new round" always goes through the page's one
 * confirmation flow.
 *
 * Keyboard: Enter/Space/↓ open and focus the first item, ↑/↓/Home/End move,
 * Escape closes and returns focus to the trigger. Key events inside the
 * menu are kept from the practice page's own shortcuts (Space/Replay/Zen).
 */
export function RoundMenu({ model, onViewReport, onNewRound, currentRoundHref, variant = "bar" }: RoundMenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLElement | null>>([]);
  const menuId = useId();

  const closeMenu = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    itemRefs.current.find((el) => el)?.focus();
    const handlePointerDown = (event: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) closeMenu(false);
    };
    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [open, closeMenu]);

  const handleMenuKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      // The page's global shortcuts listen on window: nothing typed in the
      // menu reaches them (no Zen exit on Escape, no play/pause on Space).
      event.stopPropagation();
      const items = itemRefs.current.filter((el): el is HTMLElement => el !== null);
      const index = items.indexOf(document.activeElement as HTMLElement);
      if (event.key === "Escape") {
        event.preventDefault();
        closeMenu(true);
      } else if (event.key === "Tab") {
        closeMenu(false);
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        items[(index + 1) % items.length]?.focus();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        items[(index - 1 + items.length) % items.length]?.focus();
      } else if (event.key === "Home") {
        event.preventDefault();
        items[0]?.focus();
      } else if (event.key === "End") {
        event.preventDefault();
        items[items.length - 1]?.focus();
      }
    },
    [closeMenu]
  );

  const select = (item: RoundMenuItem) => {
    if (item.disabled) return;
    closeMenu(true);
    if (item.kind === "view_report") onViewReport();
    else if (item.kind === "practice_again_new_round") onNewRound();
  };

  const itemClass =
    "flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm text-[var(--text)] transition-colors hover:bg-white/10 focus:bg-white/10 focus:outline-none aria-disabled:cursor-not-allowed aria-disabled:opacity-60 aria-disabled:hover:bg-transparent";

  return (
    <div ref={containerRef} className="relative" data-testid={`round-menu-${variant}`}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          // Space/Enter activate this button — never the page's play/pause.
          if (e.key === " " || e.key === "Enter") e.stopPropagation();
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            e.stopPropagation();
            setOpen(true);
          } else if (e.key === "Escape" && open) {
            e.preventDefault();
            e.stopPropagation();
            closeMenu(true);
          }
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={model.accessibleName}
        title={model.accessibleName}
        className={clsx(
          "inline-flex items-center gap-1 rounded-lg border text-xs font-semibold transition-colors",
          variant === "bar"
            ? "h-8 shrink-0 border-[var(--border)] bg-[var(--surface-glass)] px-2 text-[var(--text-muted)] hover:bg-white/10"
            : "h-10 border-white/20 bg-white/10 px-3 text-white/70 backdrop-blur-md hover:bg-white/20 hover:text-white"
        )}
      >
        {variant === "bar" ? (
          <>
            <span className="hidden sm:inline" data-testid="round-menu-label">
              {model.label}
            </span>
            <span className="sm:hidden">Round</span>
          </>
        ) : (
          <span data-testid="round-menu-label">{model.label}</span>
        )}
        <ChevronDown size={14} aria-hidden="true" />
      </button>

      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="Round"
          onKeyDown={handleMenuKeyDown}
          className={clsx(
            "absolute z-[70] mt-2 w-[260px] max-w-[calc(100vw-2rem)] rounded-2xl border border-[var(--border-strong)] bg-[var(--surface)] p-1.5 text-left shadow-2xl",
            variant === "bar" ? "right-0 top-full" : "bottom-full left-1/2 mb-2 -translate-x-1/2"
          )}
        >
          {model.note && <p className="px-2.5 pb-1.5 pt-1 text-[11px] leading-snug text-[var(--text-muted)]">{model.note}</p>}
          {model.items.map((item, i) => {
            const Icon = ICON[item.kind];
            const reasonId = item.reason ? `${menuId}-${item.kind}-reason` : undefined;
            const content = (
              <>
                <Icon size={16} className="mt-0.5 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
                <span className="flex min-w-0 flex-col">
                  <span>{item.label}</span>
                  {item.reason && (
                    <span id={reasonId} className="text-[11px] text-[var(--text-muted)]">
                      {item.reason}
                    </span>
                  )}
                </span>
              </>
            );
            const setRef = (el: HTMLElement | null) => {
              itemRefs.current[i] = el;
            };
            return item.kind === "go_to_current_round" ? (
              <a
                key={item.kind}
                ref={setRef}
                role="menuitem"
                href={currentRoundHref}
                data-testid={`round-menu-item-${item.kind}`}
                className={itemClass}
                onClick={() => closeMenu(false)}
              >
                {content}
              </a>
            ) : (
              <button
                key={item.kind}
                ref={setRef}
                type="button"
                role="menuitem"
                aria-disabled={item.disabled || undefined}
                aria-describedby={reasonId}
                data-testid={`round-menu-item-${item.kind}`}
                className={itemClass}
                onClick={() => select(item)}
              >
                {content}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
