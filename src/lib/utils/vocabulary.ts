import { normalizeText } from "@/lib/utils/text";

export function normalizeVocabularyTerm(term: string): string {
  return normalizeText(term, "relaxed").trim();
}

