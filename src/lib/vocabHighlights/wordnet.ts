import { readFileSync } from "fs";
import { join } from "path";

interface WordnetMultiwordEntry {
  kind: "phrasal_verb" | "multiword_expression";
  wordCount: number;
}

interface RawWordnetFile {
  meta: { version: string; entryCount: number };
  multiwords: Record<string, WordnetMultiwordEntry>;
}

let cached: RawWordnetFile | null = null;
function loadRaw(): RawWordnetFile {
  cached ??= JSON.parse(readFileSync(join(__dirname, "data", "wordnetMultiwords.json"), "utf8")) as RawWordnetFile;
  return cached;
}

export function wordnetVersion(): string {
  return loadRaw().meta.version;
}

/** Looks up a lowercased, whitespace-joined candidate phrase (e.g.
 *  "give up", "make sense of"). Candidate window generation (4-word down to
 *  2-word) lives in candidates.ts, which owns the token stream. */
export function lookupWordnetMultiword(phraseLowercase: string): WordnetMultiwordEntry | null {
  return loadRaw().multiwords[phraseLowercase] ?? null;
}

/** Test-only cache reset. */
export function __resetWordnetCacheForTests() {
  cached = null;
}
