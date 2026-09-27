import { checkAnswer } from "@/lib/utils/text";

export interface WordMatchProblemWord {
  word: string;
  errorType: "missing" | "wrong";
}

export interface WordMatchScores {
  accuracy: number;
  completeness: number;
  problemWords: WordMatchProblemWord[];
}

/** Longest recognized text accepted for a Word Match (browser speech
 *  recognition of a ≤20s take is far shorter). */
export const MAX_RECOGNIZED_TEXT_LENGTH = 2000;

/**
 * Word Match: the browser's speech-recognition transcript of the take,
 * compared word by word with the sentence (relaxed matching). One algorithm
 * for both the instant on-page display and the server, which recomputes it
 * from the attempt's pinned sentence — a client never supplies the scores.
 */
export function computeWordMatch(referenceText: string, recognizedText: string): WordMatchScores {
  const { diff } = checkAnswer(referenceText, recognizedText, "relaxed");
  const tokens = diff ?? [];
  const expectedCount = tokens.filter((t) => t.status !== "extra").length;
  const correctCount = tokens.filter((t) => t.status === "correct").length;
  const missingCount = tokens.filter((t) => t.status === "missing").length;
  return {
    accuracy: expectedCount > 0 ? (correctCount / expectedCount) * 100 : 0,
    completeness: expectedCount > 0 ? ((expectedCount - missingCount) / expectedCount) * 100 : 0,
    problemWords: tokens
      .filter((t) => t.status === "missing" || t.status === "wrong")
      .map((t) => ({ word: t.word, errorType: t.status as "missing" | "wrong" })),
  };
}
