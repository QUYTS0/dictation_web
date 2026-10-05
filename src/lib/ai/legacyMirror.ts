import type { OverviewPayloadView } from "@/lib/ai/types";
import type { SessionAssessment } from "@/lib/types";

/**
 * The pre-P5 shape of a new-format overview. Same rule as the SQL
 * fn_assessment_legacy_mirror (migration 044), which writes the mirror that
 * old readers see in learning_sessions.ai_assessment.
 */
export function legacyMirror(p: OverviewPayloadView): SessionAssessment {
  return {
    verdict: p.overview,
    strengths: p.strengths.map((s) => s.text),
    weaknesses: p.priorities.map((x) => [x.title, x.explanation].filter(Boolean).join(": ")),
    recommendation: p.practicePlan[0] ?? p.priorities[0]?.practice ?? "",
  };
}
