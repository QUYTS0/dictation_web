// =====================================================
// "Fill the gap" flashcards (dashboard redesign §4.5.4)
// =====================================================
//
// A saved word is blanked out of the learner's OWN sentence — the one it was
// saved from (`sentence_context`). Matching is case-insensitive and on word
// boundaries (letters, digits and apostrophes count as word characters, so
// "on" never matches inside "station" and "it" never inside "it's"). Runs of
// whitespace in the term match any whitespace. The FIRST match is blanked.
// No match (e.g. the term was edited after saving) → null, and the card
// shows the "Meaning" side instead of a broken blank.

export interface ClozeParts {
  before: string;
  answer: string;
  after: string;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function clozeParts(sentence: string, term: string): ClozeParts | null {
  const words = term.trim().split(/\s+/).filter(Boolean);
  if (!sentence || words.length === 0) return null;
  const pattern = words.map(escapeRegExp).join("\\s+");
  const re = new RegExp(`(?<![\\p{L}\\p{N}'’])${pattern}(?![\\p{L}\\p{N}'’])`, "iu");
  const match = re.exec(sentence);
  if (!match) return null;
  return {
    before: sentence.slice(0, match.index),
    answer: match[0],
    after: sentence.slice(match.index + match[0].length),
  };
}
