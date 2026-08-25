"use client";

import type { ReactElement } from "react";
import { clsx } from "clsx";
import { motion } from "motion/react";

interface ComboStreakProps {
  combo: number;
}

type Level = 0 | 1 | 2 | 3 | 4 | 5 | 6;
type ActiveLevel = 2 | 3 | 4 | 5 | 6;
type LevelColor = { bg: string; border: string; numberSize: string };

/** Combo maps to a level: 0 (idle), 1 (warming up, no loop yet), 2–6 active, 6+ capped. */
function getLevel(combo: number): Level {
  if (combo <= 0) return 0;
  if (combo === 1) return 1;
  if (combo >= 6) return 6;
  return combo as Level;
}

const LEVEL_COLOR: Record<ActiveLevel, LevelColor> = {
  2: { bg: "#f97316", border: "#fdba74", numberSize: "text-base" },
  3: { bg: "#ea580c", border: "#fb923c", numberSize: "text-base" },
  4: { bg: "#dc2626", border: "#f87171", numberSize: "text-lg" },
  5: { bg: "#e11d48", border: "#fb7185", numberSize: "text-lg" },
  6: { bg: "#c026d3", border: "#f0abfc", numberSize: "text-xl" },
};

/** Level 6's box color cycles through this palette instead of sitting on one flat color. */
const INFERNO_PALETTE = ["#c026d3", "#dc2626", "#f97316", "#f59e0b", "#c026d3"];

/**
 * Named designs, decoupled from level number, so re-ordering which design
 * plays at which level is a one-line change in LEVEL_DESIGN below rather
 * than moving code around.
 */
type Design = "sparkBurst" | "softPulseRing" | "diamondRing" | "electricRing" | "infernoHalo";

const LEVEL_DESIGN: Record<ActiveLevel, Design> = {
  2: "sparkBurst",
  3: "softPulseRing",
  4: "diamondRing",
  5: "electricRing",
  6: "infernoHalo",
};

/** Level 6 tile pulse cycle length (1.2s scale + 0.3s repeatDelay) — shared with InfernoPulseGlints so the front glints fire in sync with the box's own pulse. */
const INFERNO_TILE_CYCLE = 1.5;

/**
 * Each design's ring/particle cycle length (duration + repeatDelay) is
 * shared with that level's tile motion below, so the box's own pulse and
 * the effect around it breathe in lockstep instead of drifting apart.
 */
const CYCLE = {
  sparkBurst: { duration: 0.6, repeatDelay: 0.5 },
  softPulseRing: { duration: 0.6, repeatDelay: 0.5 },
  diamondRing: { duration: 1, repeatDelay: 0.2 },
} as const;

/** "Spark Burst": particles keep exploding outward and falling, like a repeating firework, with one pulse ring. */
function SparkBurstEffect({ color }: { color: LevelColor }) {
  return (
    <>
      <motion.span
        className="absolute inset-0 rounded-2xl"
        style={{ border: `2px solid ${color.border}` }}
        initial={{ scale: 1, opacity: 0.9 }}
        animate={{ scale: [1, 1.7], opacity: [0.9, 0] }}
        transition={{ ...CYCLE.sparkBurst, repeat: Infinity, ease: "easeOut" }}
      />
      {Array.from({ length: 8 }).map((_, i) => {
        const angle = (360 / 8) * i;
        const dx = Math.cos((angle * Math.PI) / 180) * 26;
        const dy = Math.sin((angle * Math.PI) / 180) * 26;
        return (
          <motion.span
            key={i}
            className="absolute h-1.5 w-1.5 rounded-full"
            style={{ top: "50%", left: "50%", background: color.bg }}
            initial={{ x: 0, y: 0, opacity: 1, scale: 1 }}
            animate={{ x: [0, dx], y: [0, dy + 10], opacity: [1, 0], scale: [1, 0.4] }}
            transition={{ ...CYCLE.sparkBurst, repeat: Infinity, ease: "easeOut" }}
          />
        );
      })}
    </>
  );
}

/** "Soft Pulse Ring": two rings breathing outward, staggered. No flash — a plain white flash was washing the number out. */
function SoftPulseRingEffect({ color }: { color: LevelColor }) {
  return (
    <>
      {[0, 1].map((i) => (
        <motion.span
          key={i}
          className="absolute inset-0 rounded-2xl"
          style={{ border: `2px solid ${color.border}` }}
          initial={{ scale: 1, opacity: 0.9 }}
          animate={{ scale: [1, 1.7], opacity: [0.9, 0] }}
          transition={{ ...CYCLE.softPulseRing, repeat: Infinity, delay: i * 0.3, ease: "easeOut" }}
        />
      ))}
    </>
  );
}

/** "Diamond Ring": two rotated-square rings continuously expand and twist apart. */
function DiamondRingEffect({ color }: { color: LevelColor }) {
  return (
    <>
      {[0, 1].map((i) => (
        <motion.span
          key={i}
          className="absolute inset-0"
          style={{ border: `2px solid ${color.border}`, borderRadius: 6 }}
          initial={{ scale: 0.6, opacity: 0.9, rotate: 45 }}
          animate={{ scale: [0.6, 1.9], opacity: [0.9, 0], rotate: [45, 45 + (i === 0 ? 25 : -25)] }}
          transition={{ ...CYCLE.diamondRing, repeat: Infinity, delay: i * 0.3, ease: "easeOut" }}
        />
      ))}
    </>
  );
}

/** "Electric Ring": a bright spinning gradient ring + a pulsing glow halo + glowing spark flickers — boosted for visibility. */
function ElectricRingEffect({ color }: { color: LevelColor }) {
  const ringMask = "radial-gradient(closest-side, transparent calc(100% - 5px), black calc(100% - 5px))";
  return (
    <>
      <motion.span
        className="absolute inset-0 rounded-2xl"
        style={{ background: color.border, filter: "blur(8px)" }}
        animate={{ opacity: [0.25, 0.65, 0.25], scale: [1, 1.3, 1] }}
        transition={{ duration: 0.8, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.div
        className="absolute inset-0 rounded-2xl"
        style={{
          background: `conic-gradient(from 0deg, transparent 0%, ${color.border} 20%, white 30%, ${color.border} 40%, transparent 55%, transparent 65%, ${color.border} 85%, transparent 100%)`,
          WebkitMask: ringMask,
          mask: ringMask,
        }}
        animate={{ rotate: 360 }}
        transition={{ duration: 0.8, repeat: Infinity, ease: "linear" }}
      />
      {[
        [-16, -13],
        [16, 13],
        [0, 18],
      ].map(([dx, dy], i) => (
        <motion.span
          key={i}
          className="absolute h-1.5 w-1.5 rounded-full bg-white"
          style={{ top: "50%", left: "50%", marginLeft: dx, marginTop: dy, boxShadow: `0 0 10px 3px ${color.border}` }}
          animate={{ opacity: [0, 1, 0], scale: [0.5, 1.5, 0.5] }}
          transition={{ duration: 0.35, repeat: Infinity, repeatDelay: 0.45, delay: i * 0.22, ease: "easeInOut" }}
        />
      ))}
    </>
  );
}

/** "Inferno Halo": a rotating blurred gradient glow plus rising ember particles — fire via glow/particles, not an icon. */
function InfernoHaloEffect({ color }: { color: LevelColor }) {
  return (
    <>
      <motion.div
        className="absolute -inset-1.5 rounded-full"
        style={{
          background: `conic-gradient(from 0deg, ${color.bg}, ${color.border}, #f59e0b, ${color.bg})`,
          filter: "blur(6px)",
        }}
        animate={{ rotate: 360, opacity: [0.55, 0.85, 0.55] }}
        transition={{
          rotate: { duration: 3, repeat: Infinity, ease: "linear" },
          opacity: { duration: 1.4, repeat: Infinity, ease: "easeInOut" },
        }}
      />
      {Array.from({ length: 5 }).map((_, i) => (
        <motion.span
          key={i}
          className="absolute h-1 w-1 rounded-full"
          style={{ bottom: 2, left: "50%", marginLeft: -12 + i * 6, background: "#fbbf24" }}
          initial={{ y: 0, opacity: 0 }}
          animate={{ y: -28, opacity: [0, 1, 0] }}
          transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.22, ease: "easeOut" }}
        />
      ))}
    </>
  );
}

/**
 * Small bright glints that flash right on top of the tile (z-20, above the
 * z-10 box) timed to the same 1.5s cycle as level 6's tile pulse (1.2s
 * scale + 0.3s repeatDelay, see INFERNO_TILE_CYCLE) — a quick "release"
 * blink at the start of every pulse rather than a constant flicker, and
 * placed close enough to the center to actually read as being on the box
 * instead of hidden behind it or lost further out.
 */
function InfernoPulseGlints() {
  const points: [number, number][] = [
    [-15, -13],
    [15, -13],
    [0, 15],
  ];
  return (
    <>
      {points.map(([dx, dy], i) => (
        <motion.span
          key={i}
          className="absolute z-20 h-1.5 w-1.5 rounded-full bg-white"
          style={{ top: "50%", left: "50%", marginLeft: dx, marginTop: dy, boxShadow: "0 0 8px 3px rgba(255,255,255,0.95)" }}
          animate={{ opacity: [0, 1, 0, 0], scale: [0, 1.6, 0.8, 0] }}
          transition={{
            duration: INFERNO_TILE_CYCLE,
            times: [0, 0.1, 0.22, 1],
            repeat: Infinity,
            delay: i * 0.15,
            ease: "easeOut",
          }}
        />
      ))}
    </>
  );
}

const DESIGN_EFFECT: Record<Design, (props: { color: LevelColor }) => ReactElement> = {
  sparkBurst: SparkBurstEffect,
  softPulseRing: SoftPulseRingEffect,
  diamondRing: DiamondRingEffect,
  electricRing: ElectricRingEffect,
  infernoHalo: InfernoHaloEffect,
};

/**
 * The tile's own motion, per design. Its cycle length matches that design's
 * ring/particle CYCLE above (levels 2–4) so the two breathe in sync. None
 * of these touch opacity, so the number stays visible the whole time.
 */
function tileMotionProps(design: Design) {
  switch (design) {
    case "sparkBurst":
      return {
        initial: { scaleX: 0.7, scaleY: 1.3 },
        animate: { scaleX: [0.8, 1.15, 0.95, 1, 1], scaleY: [1.3, 0.85, 1.05, 1, 1] },
        transition: { ...CYCLE.sparkBurst, repeat: Infinity, ease: "easeInOut" as const },
      };
    case "softPulseRing":
      return {
        initial: { scale: 0.5 },
        animate: { scale: [1.25, 1, 1.06, 1] },
        transition: { ...CYCLE.softPulseRing, repeat: Infinity, ease: "easeInOut" as const },
      };
    case "diamondRing":
      return {
        initial: { scale: 0.6, rotate: -10 },
        animate: { scale: [1.15, 1, 1.05, 1], rotate: [0, -10, 10, -6, 6, 0, 0] },
        transition: { ...CYCLE.diamondRing, repeat: Infinity, ease: "easeInOut" as const },
      };
    case "electricRing":
      return {
        initial: { scale: 0.7 },
        animate: { scale: [1.2, 1, 1, 1], x: [0, -2, 2, -2, 2, 0, 0] },
        transition: { duration: 0.7, repeat: Infinity, repeatDelay: 0.5, ease: "easeInOut" as const },
      };
    case "infernoHalo":
      return {
        initial: { scale: 0.6 },
        animate: {
          scale: [1.3, 1, 1.05, 1],
          backgroundColor: INFERNO_PALETTE,
        },
        transition: {
          scale: { duration: 1.2, repeat: Infinity, repeatDelay: 0.3, ease: "easeInOut" as const },
          backgroundColor: { duration: 3, repeat: Infinity, ease: "linear" as const },
        },
      };
  }
}

/** Level 1 — a subtle, static "warming up" look. No loop; just enough to read as different from idle. */
const LEVEL_1_TILE = {
  initial: { scale: 0.8 },
  animate: { scale: 0.95 },
  transition: { duration: 0.3, ease: "easeOut" as const },
};

const IDLE_TILE = { initial: false as const, animate: { scale: 1 }, transition: { duration: 0.2 } };

/**
 * Always-on combo readout, matching ControlButton's h-12 w-12 + hover-label
 * shell so it sits flush with the other practice controls. Level 1 gets a
 * subtle static tint (no animation loop) to distinguish it from idle;
 * levels 2–6 each play a distinct design (see LEVEL_DESIGN) so climbing the
 * streak feels like unlocking something new, not the same animation turned
 * up. Level 6 is the cap — anything beyond keeps that look rather than
 * escalating further, and its box color cycles through the same palette as
 * the halo around it instead of sitting on one flat color.
 */
export function ComboStreak({ combo }: ComboStreakProps) {
  const level = getLevel(combo);
  const isActive = level >= 2;
  const color = isActive ? LEVEL_COLOR[level as ActiveLevel] : null;
  const design = isActive ? LEVEL_DESIGN[level as ActiveLevel] : null;
  const Effect = design ? DESIGN_EFFECT[design] : null;
  const tile = design ? tileMotionProps(design) : level === 1 ? LEVEL_1_TILE : IDLE_TILE;

  return (
    <div className="flex flex-col items-center gap-1 group shrink-0">
      <div className="relative h-11 w-11 sm:h-12 sm:w-12">
        {Effect && color && <Effect key={`fx-${combo}`} color={color} />}

        <motion.div
          key={`tile-${combo}`}
          initial={tile.initial}
          animate={tile.animate}
          transition={tile.transition}
          className={clsx(
            "absolute inset-0 z-10 flex items-center justify-center rounded-2xl border shadow-sm",
            level === 0 && "border-slate-200 bg-slate-100 dark:border-white/10 dark:bg-white/5",
            level === 1 && "border-orange-200 bg-orange-50 dark:border-orange-300/30 dark:bg-orange-400/10"
          )}
          style={
            color
              ? design === "infernoHalo"
                ? { borderColor: color.border }
                : { backgroundColor: color.bg, borderColor: color.border }
              : undefined
          }
        >
          <span
            className={clsx(
              "font-black tabular-nums leading-none",
              color ? color.numberSize : "text-sm",
              color ? "text-white" : level === 1 ? "text-orange-400 dark:text-orange-300" : "text-slate-400 dark:text-slate-500"
            )}
          >
            {combo}
          </span>
        </motion.div>

        {design === "infernoHalo" && <InfernoPulseGlints key={`glints-${combo}`} />}
      </div>
      <div className="opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity flex flex-col items-center">
        <span className="text-[10px] font-semibold text-slate-400 dark:text-slate-500">Streak</span>
      </div>
    </div>
  );
}
