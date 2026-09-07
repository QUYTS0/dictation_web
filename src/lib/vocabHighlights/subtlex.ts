import subtlexData from "subtlex-word-frequencies";
import { SUBTLEX_FREQUENCY_BANDS, type SubtlexFrequencyBand } from "./config";

interface SubtlexEntry {
  word: string;
  count: number;
}

const entries = subtlexData as SubtlexEntry[];

// Real corpus total (sum of every entry's count), computed once — verified
// against the installed package on 2026-09-08: 74,286 entries, total
// 49,719,560 word occurrences. Recomputed from the actual installed data
// rather than hardcoding the approximate "~51 million" figure quoted in the
// package's own description, so a future package update self-corrects.
let totalWordCount: number | null = null;
function getTotalWordCount(): number {
  totalWordCount ??= entries.reduce((sum, e) => sum + e.count, 0);
  return totalWordCount;
}

let index: Map<string, number> | null = null;
function getIndex(): Map<string, number> {
  if (!index) {
    index = new Map();
    for (const e of entries) {
      // SUBTLEX-US is case-sensitive for a handful of entries (e.g. "I" vs
      // "i"); we only need a lowercase lookup here since candidates are
      // always matched via their lemma, which winkNLP already lowercases.
      const key = e.word.toLowerCase();
      const existing = index.get(key);
      index.set(key, existing === undefined ? e.count : existing + e.count);
    }
  }
  return index;
}

export function subtlexPackageVersion(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- package.json has no ESM export
  return (require("subtlex-word-frequencies/package.json") as { version: string }).version;
}

export interface SubtlexLookupResult {
  frequencyBand: SubtlexFrequencyBand;
  frequencyPerMillion: number;
}

/** Frequency-per-million evidence for a lemma — contributes even when
 *  EFLLex also has evidence for the same word (see candidates.ts's merge
 *  step); this is not an `else` branch gated on an EFLLex miss. */
export function lookupSubtlex(lemma: string): SubtlexLookupResult | null {
  const count = getIndex().get(lemma.toLowerCase());
  if (count === undefined) return null;

  const frequencyPerMillion = (count / getTotalWordCount()) * 1_000_000;
  const band = SUBTLEX_FREQUENCY_BANDS.find((b) => frequencyPerMillion >= b.minPerMillion)?.band ?? "rare";
  return { frequencyBand: band, frequencyPerMillion };
}

export function subtlexUnknownBand(): SubtlexLookupResult {
  return { frequencyBand: "unknown", frequencyPerMillion: 0 };
}
