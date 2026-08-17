import type { DiffToken, VocabularyItem } from "@/lib/types";
import type { ComparedToken, LessonItemType, SavedFilter } from "./types";

export function getSelectedType(wordCount: number): LessonItemType | null {
  if (wordCount <= 0) return null;
  if (wordCount === 1) return "word";
  return "phrase";
}

export function getSavedFilterLabel(filter: SavedFilter) {
  if (filter === "all") return "All";
  if (filter === "word") return "Words";
  if (filter === "phrase") return "Phrases";
  return "Sentences";
}

export function splitSentenceIntoWords(sentence: string) {
  return sentence.trim().split(/\s+/).filter(Boolean);
}

export function normalizeComparableText(text: string) {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

export function inferSavedItemType(item: VocabularyItem): LessonItemType {
  const normalizedTerm = normalizeComparableText(item.term);
  const normalizedSentence = normalizeComparableText(item.sentence_context);
  if (normalizedTerm && normalizedTerm === normalizedSentence) return "sentence";
  return splitSentenceIntoWords(item.term).length <= 1 ? "word" : "phrase";
}

export function buildComparedTokens({
  diff,
  expectedText,
  userText,
}: {
  diff: DiffToken[];
  expectedText: string;
  userText: string;
}) {
  const expectedTokens: ComparedToken[] = [];
  const userTokens: ComparedToken[] = [];

  for (const token of diff) {
    if (token.status === "correct") {
      expectedTokens.push({ word: token.word, status: "correct" });
      userTokens.push({ word: token.word, status: "correct" });
      continue;
    }
    if (token.status === "missing") {
      expectedTokens.push({ word: token.word, status: "missing" });
      continue;
    }
    if (token.status === "wrong") {
      userTokens.push({ word: token.word, status: "wrong" });
      continue;
    }
    userTokens.push({ word: token.word, status: "extra" });
  }

  if (expectedTokens.length === 0) {
    expectedTokens.push(
      ...splitSentenceIntoWords(expectedText).map((word) => ({
        word,
        status: "neutral" as const,
      }))
    );
  }
  if (userTokens.length === 0) {
    userTokens.push(
      ...splitSentenceIntoWords(userText).map((word) => ({
        word,
        status: "neutral" as const,
      }))
    );
  }

  return { expectedTokens, userTokens };
}

export function buildAiExplainPayload({
  selectedType,
  selectedText,
  sentenceText,
  userText,
}: {
  selectedType: LessonItemType | null;
  selectedText: string;
  sentenceText: string;
  userText: string;
}) {
  if (selectedType && selectedText) {
    return {
      buttonLabel: `Explain selected ${selectedType}`,
      expectedText: `Explain this ${selectedType} from a dictation lesson: "${selectedText}". Source sentence: "${sentenceText}"`,
      userText: selectedText,
    };
  }

  return {
    buttonLabel: "Explain this sentence",
    expectedText: sentenceText,
    userText,
  };
}
