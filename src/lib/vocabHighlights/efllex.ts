import { readFileSync } from "fs";
import { join } from "path";
import type { LearningLevel } from "./publicConfig";
import { EFLLEX_LEVEL_THRESHOLD_PMW } from "./config";

const LEVEL_ORDER: LearningLevel[] = ["A1", "A2", "B1", "B2", "C1"];
const RAW_LEVEL_KEYS = ["a1", "a2", "b1", "b2", "c1"] as const;

interface RawEfllexEntry {
  pos: string;
  levelFreq: Record<(typeof RAW_LEVEL_KEYS)[number], number>;
  isMultiword: boolean;
}

interface RawEfllexFile {
  meta: { version: string; lemmaCount: number; multiwordEntryCount: number };
  entries: Record<string, RawEfllexEntry[]>;
}

/**
 * EFLLex's NLP4J tagset (Penn-Treebank-derived) mapped to winkNLP's
 * universal POS tags, used to disambiguate a lemma with multiple EFLLex
 * entries at different POS (e.g. "object" as NN vs. VB). Not exhaustive —
 * an unmapped/mismatched POS falls back to the lemma's lowest (easiest)
 * available level across all its EFLLex entries rather than failing the
 * lookup outright, since being overly strict here would silently drop
 * legitimate matches for tags this table doesn't cover.
 */
const NLP4J_TO_UNIVERSAL: Record<string, string[]> = {
  NN: ["NOUN", "PROPN"],
  VB: ["VERB", "AUX"],
  JJ: ["ADJ"],
  RB: ["ADV"],
  PRP: ["PRON"],
  "PRP$": ["PRON", "DET"],
  IN: ["ADP", "SCONJ"],
  DT: ["DET"],
  CC: ["CCONJ"],
  CD: ["NUM"],
  MD: ["AUX", "VERB"],
  UH: ["INTJ"],
  WRB: ["ADV"],
  WDT: ["DET", "PRON"],
  WP: ["PRON"],
  "WP$": ["PRON"],
  TO: ["PART", "ADP"],
  RP: ["PART", "ADP"],
  EX: ["PRON"],
  FW: ["X"],
  PDT: ["DET"],
};

let cached: RawEfllexFile | null = null;
function loadRaw(): RawEfllexFile {
  cached ??= JSON.parse(readFileSync(join(__dirname, "data", "efllex.json"), "utf8")) as RawEfllexFile;
  return cached;
}

export function efllexVersion(): string {
  return loadRaw().meta.version;
}

/** First CEFR level whose *cumulative* normalized frequency crosses
 *  EFLLEX_LEVEL_THRESHOLD_PMW — see config.ts for the rationale (handles
 *  non-monotonic per-level data by construction). null means the lemma
 *  never crosses the threshold at any tracked level — treated as harder
 *  than C1, i.e. maximally difficult. */
function cumulativeEstimatedLevel(levelFreq: RawEfllexEntry["levelFreq"]): LearningLevel | null {
  let cumulative = 0;
  for (let i = 0; i < RAW_LEVEL_KEYS.length; i++) {
    cumulative += levelFreq[RAW_LEVEL_KEYS[i]];
    if (cumulative >= EFLLEX_LEVEL_THRESHOLD_PMW) return LEVEL_ORDER[i];
  }
  return null;
}

export interface EfllexLookupResult {
  pos: string;
  /** null = never crosses the threshold at any level (harder than C1). */
  estimatedLevel: LearningLevel | null;
}

/**
 * Looks up a single-word lemma. When EFLLex has multiple entries for the
 * same lemma at different POS, prefers the entry whose POS maps to the
 * caller's winkNLP universal POS tag; falls back to the easiest (lowest
 * cumulative-crossing) entry when no POS match is found, rather than
 * failing the lookup.
 */
export function lookupEfllexWord(lemma: string, universalPos?: string): EfllexLookupResult | null {
  const entries = loadRaw().entries[lemma.toLowerCase()];
  if (!entries || entries.length === 0) return null;

  const wordEntries = entries.filter((e) => !e.isMultiword);
  if (wordEntries.length === 0) return null;

  let candidates = wordEntries;
  if (universalPos) {
    const matching = wordEntries.filter((e) => (NLP4J_TO_UNIVERSAL[e.pos] ?? []).includes(universalPos));
    if (matching.length > 0) candidates = matching;
  }

  // Among remaining candidates, prefer the one with the easiest (earliest)
  // estimated level — deterministic tie-break by level order, then by the
  // NLP4J tag string itself for full stability.
  const scored = candidates
    .map((e) => ({ entry: e, level: cumulativeEstimatedLevel(e.levelFreq) }))
    .sort((a, b) => {
      const rank = (l: LearningLevel | null) => (l === null ? LEVEL_ORDER.length : LEVEL_ORDER.indexOf(l));
      const byLevel = rank(a.level) - rank(b.level);
      if (byLevel !== 0) return byLevel;
      return a.entry.pos.localeCompare(b.entry.pos);
    });

  const best = scored[0];
  return { pos: best.entry.pos, estimatedLevel: best.level };
}

export interface EfllexMultiwordEntry {
  lemma: string; // space-joined, lowercase
  wordCount: number;
  pos: string;
}

let cachedMultiwords: EfllexMultiwordEntry[] | null = null;

/** All EFLLex multi-word entries, for the candidates.ts MWE generation
 *  pass — generated independently of, and not blocked by, WordNet's own
 *  MWE pass over the same tokens. */
export function getEfllexMultiwordEntries(): EfllexMultiwordEntry[] {
  if (cachedMultiwords) return cachedMultiwords;
  const raw = loadRaw();
  const result: EfllexMultiwordEntry[] = [];
  for (const [lemma, entries] of Object.entries(raw.entries)) {
    for (const entry of entries) {
      if (entry.isMultiword) {
        result.push({ lemma, wordCount: lemma.split(" ").length, pos: entry.pos });
      }
    }
  }
  cachedMultiwords = result;
  return result;
}

/** Test-only: clears the module-level cache so a test can swap in fixture
 *  data via jest.mock before re-reading. Production code never calls this. */
export function __resetEfllexCacheForTests() {
  cached = null;
  cachedMultiwords = null;
}
