// =====================================================
// Word-by-word dictation input: character classification helpers
// =====================================================
//
// Splits a target sentence into words, and each word into character
// "slots" that are either editable (a letter/digit the user must type)
// or auto (punctuation, apostrophes, hyphens — displayed automatically
// and never typed). This lets the answer box render a caret that only
// stops on editable slots while punctuation stays visible throughout.

const EDITABLE_CHAR_RE = /[A-Za-z0-9]/;

export interface WordCharSlot {
  char: string;
  editable: boolean;
}

export interface WordSlots {
  slots: WordCharSlot[];
  editableCount: number;
}

export function buildWordCharSlots(sentence: string): WordSlots[] {
  const words = sentence.trim().length ? sentence.trim().split(/\s+/) : [];
  return words.map((word) => {
    const slots: WordCharSlot[] = [];
    for (const char of word) {
      slots.push({ char, editable: EDITABLE_CHAR_RE.test(char) });
    }
    return { slots, editableCount: slots.filter((slot) => slot.editable).length };
  });
}

export function isWordTypable(word: WordSlots): boolean {
  return word.editableCount > 0;
}

/**
 * Finds the nearest typable word index starting at `from` and moving in
 * `direction`. Words made entirely of punctuation (editableCount === 0)
 * are skipped since there's nothing to type/navigate to within them.
 * Returns null if no typable word exists in that direction.
 */
export function findTypableWordIndex(
  words: WordSlots[],
  from: number,
  direction: 1 | -1
): number | null {
  let i = from;
  while (i >= 0 && i < words.length) {
    if (isWordTypable(words[i])) return i;
    i += direction;
  }
  return null;
}

/**
 * Reconstructs one word's fully-revealed text given the letters typed so
 * far for its editable slots (in order). Auto slots (punctuation) are
 * always included since they're never typed. Typed characters beyond the
 * word's editable slot count (the user overtyped) are appended verbatim.
 */
export function buildWordValue(word: WordSlots, typedChars: string): string {
  let result = "";
  let consumed = 0;
  for (const slot of word.slots) {
    if (slot.editable) {
      if (consumed < typedChars.length) {
        result += typedChars[consumed];
        consumed++;
      } else {
        break;
      }
    } else {
      result += slot.char;
    }
  }
  if (consumed < typedChars.length) result += typedChars.slice(consumed);
  return result;
}

/** Reconstructs the flattened answer string (for submission/auto-advance checks). */
export function buildFullValue(words: WordSlots[], typedByWord: string[]): string {
  return words
    .map((word, i) => buildWordValue(word, typedByWord[i] ?? ""))
    .filter((word) => word.length > 0)
    .join(" ");
}
