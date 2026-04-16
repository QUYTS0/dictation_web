import { create } from "zustand";
import type { TranscriptSegment } from "@/lib/types";

export type PlayerStatus =
  | "unloaded"
  | "loading"
  | "ready"
  | "playing"
  | "paused"
  | "ended";

interface PlayerState {
  videoId: string | null;
  status: PlayerStatus;
  currentTimeSec: number;
  durationSec: number;
  currentSegmentIndex: number;
  segments: TranscriptSegment[];
  // Actions
  setVideoId: (id: string) => void;
  setStatus: (status: PlayerStatus) => void;
  setCurrentTime: (time: number) => void;
  setDuration: (duration: number) => void;
  setSegments: (segments: TranscriptSegment[]) => void;
  setCurrentSegmentIndex: (index: number) => void;
  reset: () => void;
}

export const usePlayerStore = create<PlayerState>((set) => ({
  videoId: null,
  status: "unloaded",
  currentTimeSec: 0,
  durationSec: 0,
  currentSegmentIndex: 0,
  segments: [],

  setVideoId: (id) => set({ videoId: id }),
  setStatus: (status) => set({ status }),
  setCurrentTime: (time) => set({ currentTimeSec: time }),
  setDuration: (duration) => set({ durationSec: duration }),
  setSegments: (segments) => set({ segments }),
  setCurrentSegmentIndex: (index) => set({ currentSegmentIndex: index }),
  reset: () =>
    set({
      videoId: null,
      status: "unloaded",
      currentTimeSec: 0,
      durationSec: 0,
      currentSegmentIndex: 0,
      segments: [],
    }),
}));
