"use client";

import { useVocabularyStatsQuery } from "@/lib/queries/vocabulary";
import type { VocabularyStatsResponse } from "@/lib/types";
import type { DashboardSummary, LibraryItem } from "@/lib/types/learning";
import { selectFocus, toFocusSource, type FocusResult, type FocusSource } from "./selectFocus";

/**
 * Dashboard Focus. The Dashboard owns the summary and Continue Learning
 * queries and passes their state in — no duplicate observers here. Focus
 * owns only the vocabulary stats query, and hands its state back so Recent
 * Vocabulary reuses it instead of mounting another one. The sentence count
 * comes from the Continue card's own progress, so no round report is fetched.
 */
export function useDashboardFocus(
  userId: string | undefined,
  sources: { continueItems: FocusSource<LibraryItem[]>; summary: FocusSource<DashboardSummary> }
): { result: FocusResult; vocab: FocusSource<VocabularyStatsResponse> } {
  const vocab = toFocusSource(useVocabularyStatsQuery(userId));
  return { result: selectFocus({ ...sources, vocab }), vocab };
}
