/**
 * The weekly track's "today" marker (the reference's live ember). Purely
 * decorative — the day's state is named by its own label. Its animations
 * (globals.css) only run without prefers-reduced-motion.
 */
export function ActiveEmber({ size = 24 }: { size?: number }) {
  return (
    <span aria-hidden="true" className="relative flex select-none items-center justify-center" style={{ width: size, height: size }}>
      <span
        className="pointer-events-none absolute animate-ember-heat-drift"
        style={{
          width: 38,
          height: 34,
          borderRadius: "48% 52% 54% 46% / 46% 48% 52% 54%",
          background: "radial-gradient(ellipse at 52% 48%, rgba(239, 176, 68, 0.16) 0%, rgba(217, 119, 6, 0.08) 55%, rgba(180, 83, 9, 0) 80%)",
          filter: "blur(3.5px)",
        }}
      />
      <span
        className="pointer-events-none absolute animate-ember-thermal-breathe"
        style={{
          width: 28,
          height: 27,
          borderRadius: "52% 48% 50% 50% / 48% 54% 46% 52%",
          background: "radial-gradient(circle at 48% 50%, rgba(245, 158, 11, 0.22) 0%, rgba(194, 65, 12, 0.12) 60%, transparent 85%)",
          filter: "blur(2px)",
        }}
      />
      <span
        className="relative flex items-center justify-center shadow-sm animate-ember-living-pulse"
        style={{
          width: 19,
          height: 19,
          borderRadius: "51% 49% 53% 47% / 48% 52% 48% 52%",
          background: "radial-gradient(circle at 45% 42%, #F59E0B 0%, #D97706 48%, #9A3412 88%, #7C2D12 100%)",
          boxShadow: "inset 0 1px 1px rgba(254, 215, 170, 0.4), inset 0 -1px 2px rgba(67, 20, 7, 0.5), 0 2px 6px rgba(180, 83, 9, 0.35)",
        }}
      >
        <span
          className="pointer-events-none absolute inset-0.5 animate-ember-shimmer"
          style={{
            borderRadius: "48% 52% 49% 51% / 51% 47% 53% 49%",
            background: "radial-gradient(circle at 44% 40%, rgba(253, 230, 138, 0.5) 0%, rgba(245, 158, 11, 0.25) 45%, transparent 75%)",
          }}
        />
        <span
          className="pointer-events-none relative animate-ember-heart-glow"
          style={{
            width: 7.5,
            height: 7.5,
            borderRadius: "52% 48% 54% 46% / 46% 54% 48% 52%",
            background: "radial-gradient(circle at 46% 44%, #FEF3C7 0%, #FBBF24 55%, #D97706 95%)",
            boxShadow: "0 0 4px rgba(251, 191, 36, 0.65)",
          }}
        />
      </span>
    </span>
  );
}
