import type { DiffToken, VocabHighlightPhrase, VocabularyItem } from "@/lib/types";
import type { ComparedToken, LessonItemType } from "./types";

/** Formats a segment's start time (seconds) as a YouTube-style "m:ss" timestamp. */
export function formatSegmentTimestamp(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const remainderSeconds = total % 60;
  return `${minutes}:${remainderSeconds.toString().padStart(2, "0")}`;
}

export function getSelectedType(wordCount: number): LessonItemType | null {
  if (wordCount <= 0) return null;
  if (wordCount === 1) return "word";
  return "phrase";
}

export function splitSentenceIntoWords(sentence: string) {
  return sentence.trim().split(/\s+/).filter(Boolean);
}

/**
 * Splits a sentence into alternating word/whitespace tokens (unlike
 * splitSentenceIntoWords, whitespace is preserved) so each word can be
 * rendered as its own clickable span while reproducing the original text.
 */
export function splitSentenceIntoTokens(sentence: string) {
  return sentence.split(/(\s+)/).filter((token) => token.length > 0);
}

interface HighlightedPhraseRun {
  /** Inclusive start/end indexes into splitSentenceIntoTokens(text). */
  startTokenIndex: number;
  endTokenIndex: number;
  /** The exact phrase text as it appears in the sentence. */
  text: string;
}

/**
 * Given a sentence and a list of AI-picked difficult phrases, returns each
 * phrase's contiguous run of token indexes into splitSentenceIntoTokens(text)
 * — including the whitespace tokens *between* its words, so a phrase like
 * "make sense of" can be rendered as a single seamless span rather than
 * three separately underlined words with gaps at the spaces.
 */
function getHighlightedPhraseRuns(text: string, phrases: VocabHighlightPhrase[]): HighlightedPhraseRun[] {
  const lowerText = text.toLowerCase();
  const ranges: Array<[number, number]> = [];
  for (const { phrase } of phrases) {
    const needle = phrase.toLowerCase().trim();
    if (!needle) continue;
    const start = lowerText.indexOf(needle);
    if (start === -1) continue;
    ranges.push([start, start + needle.length]);
  }
  if (ranges.length === 0) return [];

  const tokens = splitSentenceIntoTokens(text);
  const inRange: boolean[] = [];
  let offset = 0;
  for (const token of tokens) {
    const tokenStart = offset;
    const tokenEnd = offset + token.length;
    offset = tokenEnd;
    inRange.push(ranges.some(([rangeStart, rangeEnd]) => tokenStart < rangeEnd && tokenEnd > rangeStart));
  }

  const runs: HighlightedPhraseRun[] = [];
  let runStart: number | null = null;
  tokens.forEach((_, idx) => {
    if (inRange[idx]) {
      if (runStart === null) runStart = idx;
      return;
    }
    if (runStart !== null) {
      runs.push({ startTokenIndex: runStart, endTokenIndex: idx - 1, text: tokens.slice(runStart, idx).join("") });
      runStart = null;
    }
  });
  if (runStart !== null) {
    runs.push({ startTokenIndex: runStart, endTokenIndex: tokens.length - 1, text: tokens.slice(runStart).join("") });
  }
  return runs;
}

export type ScriptRenderItem =
  | { kind: "space"; key: string; text: string }
  | { kind: "word"; key: string; text: string }
  | { kind: "phrase"; key: string; text: string };

/**
 * Turns a sentence + its AI-picked difficult phrases into a flat render
 * plan: each word/space token is its own item (as before, for single-word
 * tap-to-save), except tokens inside a highlighted phrase are collapsed
 * into one "phrase" item spanning the whole phrase — so it highlights,
 * selects, and previews as one seamless unit instead of word-by-word.
 */
export function buildScriptRenderItems(text: string, phrases: VocabHighlightPhrase[]): ScriptRenderItem[] {
  const tokens = splitSentenceIntoTokens(text);
  const runs = getHighlightedPhraseRuns(text, phrases);
  const runByStart = new Map(runs.map((run) => [run.startTokenIndex, run]));
  const consumed = new Set<number>();
  runs.forEach((run) => {
    for (let i = run.startTokenIndex + 1; i <= run.endTokenIndex; i++) consumed.add(i);
  });

  const items: ScriptRenderItem[] = [];
  tokens.forEach((token, idx) => {
    if (consumed.has(idx)) return;
    const run = runByStart.get(idx);
    if (run) {
      items.push({ kind: "phrase", key: `phrase-${idx}`, text: run.text });
      return;
    }
    items.push(token.trim() ? { kind: "word", key: `word-${idx}`, text: token } : { kind: "space", key: `space-${idx}`, text: token });
  });
  return items;
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
