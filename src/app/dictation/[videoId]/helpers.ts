import type { DiffToken, VocabHighlightPhrase, VocabularyItem } from "@/lib/types";
import type { ComparedToken, LessonItemType, LessonSavedItem } from "./types";

/** Formats a segment's start time (seconds) as a YouTube-style "m:ss" timestamp. */
export function formatSegmentTimestamp(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const remainderSeconds = total % 60;
  return `${minutes}:${remainderSeconds.toString().padStart(2, "0")}`;
}

/** Formats seconds as a zero-padded "mm:ss" clock, e.g. 25 -> "00:25", 272 -> "04:32". */
export function formatClockTime(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const remainderSeconds = total % 60;
  return `${minutes.toString().padStart(2, "0")}:${remainderSeconds.toString().padStart(2, "0")}`;
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
 * Given a sentence and a list of difficult phrases, returns each phrase's
 * contiguous run of token indexes into splitSentenceIntoTokens(text) —
 * including the whitespace tokens *between* its words, so a phrase like
 * "make sense of" can be rendered as a single seamless span rather than
 * three separately underlined words with gaps at the spaces.
 *
 * Phrases carrying explicit start/end offsets (the deterministic pipeline
 * always provides these) are located directly by offset, so every
 * occurrence of a repeated phrase highlights independently. Phrases without
 * offsets (only possible for a pre-migration legacy cached row) fall back
 * to a first-occurrence substring search, matching the old behavior.
 */
function getHighlightedPhraseRuns(text: string, phrases: VocabHighlightPhrase[]): HighlightedPhraseRun[] {
  const lowerText = text.toLowerCase();
  const ranges: Array<[number, number]> = [];
  for (const { phrase, start: explicitStart, end: explicitEnd } of phrases) {
    if (typeof explicitStart === "number" && typeof explicitEnd === "number") {
      if (explicitStart >= 0 && explicitEnd <= text.length && explicitStart < explicitEnd) {
        ranges.push([explicitStart, explicitEnd]);
      }
      continue;
    }
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

/**
 * Looks up the highlight metadata (translation, canonicalForm,
 * learningPattern) for an exact phrase-text match within one segment's
 * highlights — the single source of truth both the click-to-save popover and
 * the hover/tap preview tooltip read from, so neither ever has to
 * reconstruct this from plain selected text alone. Case/whitespace-
 * insensitive, matching how the highlight was originally rendered.
 */
export function findHighlightPhrase(
  phrases: VocabHighlightPhrase[] | undefined,
  phraseText: string
): VocabHighlightPhrase | undefined {
  const key = phraseText.trim().toLowerCase();
  if (!key) return undefined;
  return phrases?.find((p) => p.phrase.trim().toLowerCase() === key);
}

export type ScriptRenderItem =
  | { kind: "space"; key: string; text: string }
  | { kind: "punct"; key: string; text: string }
  | { kind: "word"; key: string; text: string }
  | { kind: "phrase"; key: string; text: string };

const LEADING_PUNCTUATION = /^[^\p{L}\p{N}]+/u;
const TRAILING_PUNCTUATION = /[^\p{L}\p{N}]+$/u;

/**
 * Trims leading/trailing punctuation (quotes, commas, periods, parens, a
 * lone dash, etc.) while preserving apostrophes/hyphens that sit *inside*
 * a word (e.g. "don't", "self-talk") — those never reach the string edges.
 */
export function stripEdgePunctuation(text: string): string {
  return text.replace(LEADING_PUNCTUATION, "").replace(TRAILING_PUNCTUATION, "");
}

/** Human-readable labels for Azure's word ErrorType values plus this app's
 *  own break/intonation error-type strings (see ProsodyFeedback in
 *  types.ts) — shared by the Focus card, Word details, and the Detailed
 *  Report so "Mispronunciation · 41/100" always reads identically wherever
 *  it appears. Falls back to the raw value for anything not in the map
 *  rather than hiding an error type we don't have copy for yet. */
const ERROR_TYPE_LABELS: Record<string, string> = {
  Mispronunciation: "Mispronunciation",
  Omission: "Omission",
  Insertion: "Insertion",
  UnexpectedBreak: "Unexpected break",
  MissingBreak: "Missing break",
  Monotone: "Monotone",
};

export function formatErrorTypeLabel(errorType: string): string {
  return ERROR_TYPE_LABELS[errorType] ?? errorType;
}

/** Azure reports Offset/Duration in 100-nanosecond ticks — converts to a
 *  compact human-readable duration ("240ms" / "1.24s") for the Detailed
 *  Report rather than showing the raw tick count. */
export function formatAzureDuration(ticks: number): string {
  const ms = ticks / 10_000;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function splitEdgePunctuation(text: string): { leading: string; core: string; trailing: string } {
  const leading = text.match(LEADING_PUNCTUATION)?.[0] ?? "";
  const rest = leading ? text.slice(leading.length) : text;
  const trailing = rest.match(TRAILING_PUNCTUATION)?.[0] ?? "";
  const core = trailing ? rest.slice(0, rest.length - trailing.length) : rest;
  return { leading, core, trailing };
}

/**
 * Turns a sentence + its AI-picked difficult phrases into a flat render
 * plan: each word/space token is its own item (as before, for single-word
 * tap-to-save), except tokens inside a highlighted phrase are collapsed
 * into one "phrase" item spanning the whole phrase — so it highlights,
 * selects, and previews as one seamless unit instead of word-by-word.
 * Punctuation at the very edges of a phrase (e.g. the comma in "if not
 * all,") is split back out into a plain "punct" item so it stays visible
 * but outside the underline/click area.
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
      const { leading, core, trailing } = splitEdgePunctuation(run.text);
      if (leading) items.push({ kind: "punct", key: `phrase-lead-${idx}`, text: leading });
      if (core) items.push({ kind: "phrase", key: `phrase-${idx}`, text: core });
      if (trailing) items.push({ kind: "punct", key: `phrase-trail-${idx}`, text: trailing });
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

// ---- Vocabulary tab search/filter/detail helpers ----

/**
 * Lowercases, strips combining diacritics (NFD decomposition covers Latin
 * accents like ế/ề/ộ), and folds Vietnamese đ/Đ to d — so a search for
 * "duong" also matches "đường" without a diacritics library. Applied to
 * both the query and each candidate field, symmetrically.
 */
const COMBINING_DIACRITIC_RANGE_START = 0x0300;
const COMBINING_DIACRITIC_RANGE_END = 0x036f;

/** Strips Unicode combining diacritical marks (the block NFD decomposes
 *  Latin accents like ế/ề/ộ into) — built from code points rather than a
 *  \u{...}-range regex literal so the source stays plain ASCII. */
function stripCombiningDiacritics(text: string): string {
  return Array.from(text)
    .filter((char) => {
      const codePoint = char.codePointAt(0) ?? 0;
      return codePoint < COMBINING_DIACRITIC_RANGE_START || codePoint > COMBINING_DIACRITIC_RANGE_END;
    })
    .join("");
}

export function normalizeForSearch(text: string): string {
  return stripCombiningDiacritics(text.toLowerCase().normalize("NFD"))
    .replace(/đ/g, "d")
    .trim()
    .replace(/\s+/g, " ");
}

export type VocabularyTypeFilter = "all" | "word" | "phrase";

export interface VocabularyHighlightMeta {
  canonicalForm?: string;
  learningPattern?: string;
}

/**
 * Client-side search+filter over the already-loaded saved vocabulary list —
 * never triggers a request. Matches the English term, Vietnamese
 * translation, source sentence, and (when resolveMeta is given) the
 * highlight-derived canonical form, all accent/case-insensitively.
 */
export function filterVocabularyItems(
  items: LessonSavedItem[],
  query: string,
  typeFilter: VocabularyTypeFilter,
  resolveMeta?: (item: LessonSavedItem) => VocabularyHighlightMeta
): LessonSavedItem[] {
  const typeFiltered = typeFilter === "all" ? items : items.filter((item) => item.type === typeFilter);

  const normalizedQuery = normalizeForSearch(query);
  if (!normalizedQuery) return typeFiltered;

  return typeFiltered.filter((item) => {
    const candidates = [item.term, item.translation ?? "", item.sentence_context];
    const meta = resolveMeta?.(item);
    if (meta?.canonicalForm) candidates.push(meta.canonicalForm);
    return candidates.some((candidate) => normalizeForSearch(candidate).includes(normalizedQuery));
  });
}

/**
 * Merges a saved vocabulary item with the *current* transcript-highlight
 * metadata for its segment (canonicalForm/learningPattern) — these fields
 * are never persisted on the saved row itself (see VocabularyItem), only on
 * the shared per-transcript highlight cache. Matched by exact phrase text
 * within the item's own segment, via the same findHighlightPhrase lookup
 * the click-to-save popover uses. Returns {} (nothing to show) when the
 * segment's highlights aren't loaded or don't include this term — legacy
 * saved rows and freeform (non-highlighted) selections both fall here.
 */
export function resolveVocabularyHighlightMeta(
  item: Pick<LessonSavedItem, "segment_index" | "term">,
  phrasesBySegmentIndex: Map<number, VocabHighlightPhrase[]>
): VocabularyHighlightMeta {
  const match = findHighlightPhrase(phrasesBySegmentIndex.get(item.segment_index), item.term);
  if (!match) return {};
  return { canonicalForm: match.canonicalForm, learningPattern: match.learningPattern };
}

export interface SentenceHighlightSegment {
  text: string;
  matched: boolean;
}

/**
 * Splits a source sentence into plain/matched segments around the first
 * case-insensitive occurrence of `term`, so the detail view can render the
 * saved term highlighted in context without a full diff/markup pipeline.
 */
export function splitSentenceForHighlight(sentence: string, term: string): SentenceHighlightSegment[] {
  const trimmedTerm = term.trim();
  if (!trimmedTerm) return [{ text: sentence, matched: false }];

  const index = sentence.toLowerCase().indexOf(trimmedTerm.toLowerCase());
  if (index === -1) return [{ text: sentence, matched: false }];

  const segments: SentenceHighlightSegment[] = [];
  if (index > 0) segments.push({ text: sentence.slice(0, index), matched: false });
  segments.push({ text: sentence.slice(index, index + trimmedTerm.length), matched: true });
  const rest = sentence.slice(index + trimmedTerm.length);
  if (rest) segments.push({ text: rest, matched: false });
  return segments;
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

export type WordMatchChange =
  | { kind: "substitution"; expected: string; got: string }
  | { kind: "missing"; expected: string }
  | { kind: "extra"; got: string };

/**
 * Reduces a word-level diff down to just its differences, for a compact
 * "crop → grub" style summary instead of rendering the full Script/What We
 * Heard comparison. Relies on wordDiff()'s own pairing guarantee
 * (src/lib/utils/text.ts) that a "wrong" token is always immediately
 * followed by the "missing" token it substitutes for — so a wrong+missing
 * pair becomes one substitution entry, a standalone "missing" is a pure
 * omission, and a standalone "extra" (never paired into "wrong") is a pure
 * insertion. "correct" tokens produce no entries.
 */
export function summarizeWordMatchDiff(diff: DiffToken[]): WordMatchChange[] {
  const changes: WordMatchChange[] = [];
  for (let i = 0; i < diff.length; i++) {
    const token = diff[i];
    if (token.status === "correct") continue;
    if (token.status === "wrong") {
      const next = diff[i + 1];
      changes.push({ kind: "substitution", expected: next?.word ?? "", got: token.word });
      if (next?.status === "missing") i++;
      continue;
    }
    if (token.status === "missing") {
      changes.push({ kind: "missing", expected: token.word });
      continue;
    }
    changes.push({ kind: "extra", got: token.word });
  }
  return changes;
}
