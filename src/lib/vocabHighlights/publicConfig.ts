// Client-safe: no dataset loaders, no fs/Azure/scoring-weight imports. This
// is the only vocabHighlights module a client component/hook may import —
// see useVocabHighlights.ts.

export type LearningLevel = "A1" | "A2" | "B1" | "B2" | "C1";

export const LEARNING_LEVELS: LearningLevel[] = ["A1", "A2", "B1", "B2", "C1"];

/**
 * No per-user learning-level setting exists in this app yet (no such
 * concept in the schema/settings UI). This matches the current hardcoded
 * Gemini prompt's "intermediate (B1-B2)" framing until a real per-user
 * setting is designed as a separate, explicit product decision.
 */
export const DEFAULT_LEARNING_LEVEL: LearningLevel = "B1";
