"use client";

import { SpeakingPracticeStage, type SpeakingPracticeStageProps } from "./SpeakingPracticeStage";

type ShadowingPanelProps = Omit<SpeakingPracticeStageProps, "mode">;

export function ShadowingPanel(props: ShadowingPanelProps) {
  return <SpeakingPracticeStage mode="shadowing" {...props} />;
}
