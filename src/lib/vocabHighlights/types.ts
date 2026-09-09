// Internal-only types for the vocab-highlight pipeline. Never persisted in
// full to the DB (transcript_vocab_highlights has public-read RLS — see the
// plan's cache/schema section) and never sent to the client in production;
// only aggregated candidateCounts and the final {phrase, translation,
// start, end} projection cross that boundary.
import type { LearningLevel } from "./publicConfig";
import type { SubtlexFrequencyBand } from "./config";

export type CandidateKind = "word" | "phrasal_verb" | "idiom" | "multiword_expression" | "topic_phrase";
export type CandidateSource = "efllex" | "subtlex" | "wordnet" | "azure_key_phrase" | "supplementary" | "construction";

export type WordEvidence = {
  /** estimatedLevel: null means the lemma's cumulative EFLLex frequency
   *  never crosses the configured threshold at any tracked level — treated
   *  as harder than C1, not "no evidence" (that's evidence.efllex itself
   *  being absent). */
  efllex?: { estimatedLevel: LearningLevel | null; pos: string };
  subtlex?: { frequencyBand: SubtlexFrequencyBand; frequencyPerMillion: number };
};

export type HighlightCandidate = {
  segmentIndex: number;
  /** UTF-16 half-open [start, end) into this segment's text_raw. Invariant,
   *  no exceptions: text.slice(start, end) === originalText always. */
  start: number;
  end: number;
  originalText: string;
  lemma?: string;
  pos?: string;
  kind: CandidateKind;
  /** Plural: a word-level candidate can carry both efllex and subtlex
   *  evidence simultaneously — neither source blocks the other. */
  sources: CandidateSource[];
  evidence?: WordEvidence;
  /** An ESTIMATE derived from learner-corpus frequency evidence, never an
   *  authoritative CEFR label. Never set for azure_key_phrase candidates. */
  estimatedLevel?: LearningLevel;
  /** The dictionary/normalized form this surface span is an instance of,
   *  e.g. "pair with" for the surface "paired with", or "give up" for
   *  "given up". Set by the MWE lemma-match scan (candidates.ts) for any
   *  WordNet/EFLLex/supplementary match — the matched lemma phrase IS the
   *  canonical form — and by the construction-expansion stage
   *  (constructions.ts) for its own curated matches. Distinguishes a
   *  reusable lexical construction from the exact wording that happened to
   *  appear in this sentence (`originalText`, the surfaceText). */
  canonicalForm?: string;
  /** Optional reusable explanation of the construction's usage pattern,
   *  e.g. "go a long way toward(s) + noun/V-ing". Construction-expansion
   *  only — plain lexicon matches don't have reliable pattern data, so this
   *  stays unset rather than guessing one from the surface text. */
  learningPattern?: string;
  /** Set for a candidate produced by hyphen-compound merging (e.g.
   *  "meat-eating") — used by scoring.ts to apply a dedicated bonus since
   *  compound forms are rarely themselves present in EFLLex/SUBTLEX. */
  isHyphenCompound?: boolean;
  score: number;
  reasons: string[];
};

export type HighlightGenerationStatus = "complete" | "empty" | "failed";

export type HighlightGenerationMetadata = {
  /** "failed" is never persisted to the DB — see cache.ts — it only ever
   *  appears in a single request's in-memory/response metadata. */
  status: HighlightGenerationStatus;
  pipelineVersion: string;
  transcriptTextHash: string;
  learningLevel: LearningLevel;
  generatedAt: string;
  azureUsed: boolean;
  candidateCounts: Record<string, number>;
};

/** The public projection stored in transcript_vocab_highlights.phrases and
 *  returned to the client — see src/lib/types/index.ts's VocabHighlightPhrase,
 *  which this must stay structurally compatible with. */
export type PublicHighlightPhrase = {
  phrase: string;
  translation: string | null;
  start: number;
  end: number;
  canonicalForm?: string;
  learningPattern?: string;
};
