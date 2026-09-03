"use client";

import { SpeakingPracticeStage, type SpeakingPracticeStageProps } from "./SpeakingPracticeStage";

type PronunciationPanelProps = Omit<SpeakingPracticeStageProps, "mode">;

export function PronunciationPanel(props: PronunciationPanelProps) {
  return <SpeakingPracticeStage mode="pronunciation" {...props} />;
}
