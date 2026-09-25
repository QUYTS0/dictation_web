export type PageWidthMode = "narrow" | "standard" | "wide";

/**
 * Single source of truth for the app's per-page content width. Applied to
 * every main-tab page's <main> (and to AppHeader, always at "wide" —
 * unconditionally, since the header must stay visually stable regardless
 * of which tab is active).
 */
export const PAGE_WIDTH_CLASS: Record<PageWidthMode, string> = {
  narrow: "max-w-4xl",
  // Provisional — mirrors Dashboard's current value unchanged. Not yet
  // consumed by any page; revisit once Dashboard's own redesign defines
  // what it actually needs. Do not bump this speculatively.
  standard: "max-w-6xl",
  // Near-fluid safety cap, reusing the figure already proven in this
  // codebase's own Dictation player redesign (see
  // .claude/dictation-player-redesign-plan.md) rather than inventing a
  // new number.
  wide: "max-w-[1800px]",
};

/**
 * Per-mode, not universal: narrow's reading column has no "extra breathing
 * room at extreme widths" need the way wide/near-fluid pages (and the
 * header, which always uses "wide") do, so its padding stays flat instead
 * of escalating.
 */
export const PAGE_PADDING_CLASS: Record<PageWidthMode, string> = {
  narrow: "px-4",
  standard: "px-4 sm:px-6 lg:px-8",
  wide: "px-4 sm:px-6 lg:px-8 xl:px-10",
};
