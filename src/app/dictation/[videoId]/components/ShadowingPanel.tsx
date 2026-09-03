"use client";

import { PracticeRecorderPanel } from "./PracticeRecorderPanel";

interface ShadowingPanelProps {
  currentSegment: { text: string } | undefined;
  onPlayOriginal: () => void;
}

export function ShadowingPanel({ currentSegment, onPlayOriginal }: ShadowingPanelProps) {
  return <PracticeRecorderPanel mode="shadowing" currentSegment={currentSegment} onPlayOriginal={onPlayOriginal} />;
}
