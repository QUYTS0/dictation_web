import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { MatchMode, HintLevel, UXState } from "@/lib/types";

interface SessionState {
  sessionId: string | null;
  uxState: UXState;
  matchMode: MatchMode;
  hintLevel: HintLevel;
  attemptCount: number;
  correctCount: number;
  totalAttempts: number;
  lastError: string | null;
  aiExplanation: string | null;
  // Actions
  setSessionId: (id: string | null) => void;
  setUxState: (state: UXState) => void;
  setMatchMode: (mode: MatchMode) => void;
  setHintLevel: (level: HintLevel) => void;
  incrementAttempt: (isCorrect: boolean) => void;
  resetAttempts: () => void;
  setLastError: (error: string | null) => void;
  setAiExplanation: (explanation: string | null) => void;
  reset: () => void;
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set) => ({
      sessionId: null,
      uxState: "idle",
      matchMode: "relaxed",
      hintLevel: 0,
      attemptCount: 0,
      correctCount: 0,
      totalAttempts: 0,
      lastError: null,
      aiExplanation: null,

      setSessionId: (id) => set({ sessionId: id }),
      setUxState: (state) => set({ uxState: state }),
      setMatchMode: (mode) => set({ matchMode: mode }),
      setHintLevel: (level) => set({ hintLevel: level }),
      incrementAttempt: (isCorrect) =>
        set((s) => ({
          attemptCount: s.attemptCount + 1,
          totalAttempts: s.totalAttempts + 1,
          correctCount: isCorrect ? s.correctCount + 1 : s.correctCount,
        })),
      resetAttempts: () => set({ attemptCount: 0 }),
      setLastError: (error) => set({ lastError: error }),
      setAiExplanation: (explanation) => set({ aiExplanation: explanation }),
      reset: () =>
        set({
          sessionId: null,
          uxState: "idle",
          hintLevel: 0,
          attemptCount: 0,
          correctCount: 0,
          totalAttempts: 0,
          lastError: null,
          aiExplanation: null,
        }),
    }),
    {
      name: "dictation-session",
      partialize: (s) => ({
        sessionId: s.sessionId,
        matchMode: s.matchMode,
        totalAttempts: s.totalAttempts,
        correctCount: s.correctCount,
      }),
    }
  )
);

/** Accuracy as a percentage (0–100). */
export function selectAccuracy(state: SessionState): number {
  if (state.totalAttempts === 0) return 0;
  return Math.round((state.correctCount / state.totalAttempts) * 100);
}
