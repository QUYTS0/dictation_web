// A small, hand-curated, maintainable list of common fixed multi-word
// expressions missing from the EFLLex/Open English WordNet derived indexes
// (verified absent from both — see build scripts' raw data) but frequent
// enough in educational/TED-Ed-style transcripts to be worth recognizing.
// Checked by the same greedy longest-match scan as WordNet/EFLLex (see
// candidates.ts's generateMultiwordCandidates), keyed by lowercased,
// space-joined LEMMA form so inflected/passive variants still match.
//
// This is not a per-sentence hack: any transcript containing one of these
// exact lemma sequences benefits, not just the sentences used to discover
// the gap.
export interface SupplementaryPhraseEntry {
  kind: "multiword_expression" | "idiom";
}

export const SUPPLEMENTARY_PHRASES: Record<string, SupplementaryPhraseEntry> = {
  "business as usual": { kind: "idiom" },
  "on the other hand": { kind: "idiom" },
  "in the long run": { kind: "idiom" },
  "at the end of the day": { kind: "idiom" },
  "for the most part": { kind: "idiom" },
  "when it come to": { kind: "idiom" }, // lemma of "comes"/"came" is "come"
  "as opposed to": { kind: "multiword_expression" },
  "as well as": { kind: "multiword_expression" },
  "in spite of": { kind: "multiword_expression" },
  "on top of": { kind: "multiword_expression" },
};

export function lookupSupplementaryMultiword(lemmaPhrase: string): SupplementaryPhraseEntry | null {
  return SUPPLEMENTARY_PHRASES[lemmaPhrase] ?? null;
}
