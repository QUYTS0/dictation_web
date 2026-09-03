"use client";

import { PracticeRecorderPanel } from "./PracticeRecorderPanel";

interface PronunciationPanelProps {
  currentSegment: { text: string } | undefined;
  onPlayOriginal: () => void;
}

export function PronunciationPanel({ currentSegment, onPlayOriginal }: PronunciationPanelProps) {
  return <PracticeRecorderPanel mode="pronunciation" currentSegment={currentSegment} onPlayOriginal={onPlayOriginal} />;
}
