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
  // __dirname is unreliable here: Turbopack's bundled server output replaces
  // it with a build-cache placeholder rather than the real source directory,
  // so a __dirname-relative readFileSync 404s at runtime (ENOENT on
  // 'C:\ROOT\...'). process.cwd() is the Next.js project root in both dev
  // and prod and resolves correctly.
  cached ??= JSON.parse(
    readFileSync(join(process.cwd(), "src", "lib", "vocabHighlights", "data", "wordnetMultiwords.json"), "utf8"),
  ) as RawWordnetFile;
  return cached;
}

export function wordnetVersion(): string {
  return loadRaw().meta.version;
}

/** Looks up a lowercased, whitespace-joined candidate phrase (e.g.
 *  "give up", "make sense of"). Candidate window generation (sized by
 *  wordnetMaxPhraseLength() down to 2-word) lives in candidates.ts, which
 *  owns the token stream. */
export function lookupWordnetMultiword(phraseLowercase: string): WordnetMultiwordEntry | null {
  return loadRaw().multiwords[phraseLowercase] ?? null;
}

let cachedMaxPhraseLength: number | null = null;

/** Longest entry (in tokens) present in the derived WordNet multiword index —
 *  used by candidates.ts to size the MWE scan window instead of a fixed
 *  literal. Computed once from data already loaded by loadRaw(), no extra I/O. */
export function wordnetMaxPhraseLength(): number {
  if (cachedMaxPhraseLength === null) {
    cachedMaxPhraseLength = Math.max(0, ...Object.values(loadRaw().multiwords).map((v) => v.wordCount));
  }
  return cachedMaxPhraseLength;
}

/** Test-only cache reset. */
export function __resetWordnetCacheForTests() {
  cached = null;
  cachedMaxPhraseLength = null;
}
