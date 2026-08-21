"use client";

import { useEffect, useState } from "react";
import { motion } from "motion/react";

const CONFETTI_COLORS = ["#f97316", "#6366f1", "#10b981", "#ec4899", "#eab308"];
const PIECE_COUNT = 24;

interface Piece {
  id: number;
  color: string;
  left: number;
  rotate: number;
  delay: number;
  duration: number;
  drift: number;
}

/** A one-shot confetti burst celebrating a great session. Purely decorative, non-interactive. */
export function ConfettiBurst() {
  const [pieces, setPieces] = useState<Piece[]>([]);

  // Randomized in an effect rather than during render, since generating it inline
  // (even memoized) calls the impure Math.random while React is rendering.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPieces(
      Array.from({ length: PIECE_COUNT }, (_, id) => ({
        id,
        color: CONFETTI_COLORS[id % CONFETTI_COLORS.length],
        left: Math.random() * 100,
        rotate: Math.random() * 360,
        delay: Math.random() * 0.3,
        duration: 1.4 + Math.random() * 0.8,
        drift: (Math.random() - 0.5) * 80,
      }))
    );
  }, []);

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      {pieces.map((piece) => (
        <motion.span
          key={piece.id}
          className="absolute top-0 h-2.5 w-1.5 rounded-sm"
          style={{ left: `${piece.left}%`, backgroundColor: piece.color }}
          initial={{ y: -20, x: 0, opacity: 1, rotate: 0 }}
          animate={{ y: 260, x: piece.drift, opacity: 0, rotate: piece.rotate }}
          transition={{ duration: piece.duration, delay: piece.delay, ease: "easeIn" }}
        />
      ))}
    </div>
  );
}
