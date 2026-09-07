import { LEARNING_LEVELS, type LearningLevel } from "./publicConfig";
import { SCORING } from "./config";
import type { HighlightCandidate } from "./types";

function levelIndex(level: LearningLevel): number {
  return LEARNING_LEVELS.indexOf(level);
}

/** Deterministic score + reasons for one candidate, given the request's
 *  learningLevel. Word-level candidates use EFLLex as the primary signal
 *  when present, with SUBTLEX contributing a secondary nudge even when
 *  EFLLex also has data (not an else-branch fallback — see candidates.ts).
 *  MWE/phrasal-verb/topic-phrase candidates use a flat configured bonus;
 *  Azure candidates never receive a CEFR-based score component. */
export function scoreCandidate(candidate: HighlightCandidate, learningLevel: LearningLevel): HighlightCandidate {
  const reasons = [...candidate.reasons];
  let score = 0;

  if (candidate.kind === "word") {
    const learnerIdx = levelIndex(learningLevel);
    if (candidate.evidence?.efllex) {
      const est = candidate.evidence.efllex.estimatedLevel;
      const estIdx = est === null ? LEARNING_LEVELS.length : levelIndex(est);
      const gap = Math.max(0, estIdx - learnerIdx);
      score += gap * SCORING.LEVEL_GAP_WEIGHT;
      reasons.push(est === null ? "efllex-beyond-c1" : `efllex-level-${est}`);

      if (candidate.evidence.subtlex) {
        const band = candidate.evidence.subtlex.frequencyBand;
        if (band === "rare" || band === "unknown") score += 5;
        reasons.push(`subtlex-secondary-${band}`);
      }
    } else if (candidate.evidence?.subtlex) {
      score += SCORING.SUBTLEX_BAND_SCORE[candidate.evidence.subtlex.frequencyBand];
      reasons.push(`subtlex-${candidate.evidence.subtlex.frequencyBand}`);
    }
  } else if (candidate.kind === "phrasal_verb" || candidate.kind === "idiom") {
    score += SCORING.PHRASAL_VERB_BONUS;
    reasons.push("phrasal-verb-bonus");
  } else if (candidate.kind === "multiword_expression") {
    score += SCORING.MULTIWORD_BONUS;
    reasons.push("multiword-bonus");
  } else if (candidate.kind === "topic_phrase") {
    score += SCORING.AZURE_TOPIC_PHRASE_BONUS;
    reasons.push("azure-topic-phrase");
  }

  if (reasons.includes("named-entity-suspected")) {
    score += SCORING.NAMED_ENTITY_PENALTY;
  }

  return { ...candidate, score, reasons };
}

export function scoreCandidates(candidates: HighlightCandidate[], learningLevel: LearningLevel): HighlightCandidate[] {
  return candidates.map((c) => scoreCandidate(c, learningLevel));
}
