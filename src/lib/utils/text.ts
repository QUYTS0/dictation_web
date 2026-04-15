// =====================================================
// Text normalisation utilities for answer checking
// =====================================================

import type { MatchMode, ErrorType, DiffToken, CheckResult } from "@/lib/types";

// ---- Normalisation ----

/**
 * Trims whitespace, normalises Unicode (NFC) and collapses internal spaces.
 */
export function normalizeWhitespace(text: string): string {
  return text.trim().normalize("NFC").replace(/\s+/g, " ");
}

/**
 * Replaces smart quotes, curly apostrophes, and other common special characters
 * with their plain ASCII equivalents.
 */
export function normalizeSpecialChars(text: string): string {
  return text
    .replace(/[\u2018\u2019\u0060\u00b4]/g, "'") // smart/curly apostrophes → '
    .replace(/[\u201c\u201d]/g, '"') // curly double quotes → "
    .replace(/\u2013|\u2014/g, "-") // en-dash / em-dash → hyphen
    .replace(/\u2026/g, "..."); // ellipsis → ...
}

/**
 * Removes all punctuation characters.
 */
export function removePunctuation(text: string): string {
  return text.replace(/[^\w\s']|_/g, "").replace(/'\s/g, " ");
}

/**
 * Full normalisation pipeline for a given match mode.
 *
 * - exact:    only whitespace + special-char normalisation
 * - relaxed:  also lowercase + punctuation removal
 * - learning: same as relaxed (most forgiving for learners)
 */
export function normalizeText(text: string, mode: MatchMode): string {
  let result = normalizeWhitespace(normalizeSpecialChars(text));

  if (mode === "relaxed" || mode === "learning") {
    result = removePunctuation(result).toLowerCase();
    result = normalizeWhitespace(result);
  }

  return result;
}

// ---- Word-level diff ----

/**
 * Produces a word-level diff between expected and user tokens.
 * Uses a simple LCS-based approach.
 */
export function wordDiff(
  expectedTokens: string[],
  userTokens: string[]
): DiffToken[] {
  const m = expectedTokens.length;
  const n = userTokens.length;

  // Build LCS table
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0)
  );

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (expectedTokens[i - 1] === userTokens[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Trace back
  const diff: DiffToken[] = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && expectedTokens[i - 1] === userTokens[j - 1]) {
      diff.unshift({ word: expectedTokens[i - 1], status: "correct" });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      diff.unshift({ word: userTokens[j - 1], status: "extra" });
      j--;
    } else {
      diff.unshift({ word: expectedTokens[i - 1], status: "missing" });
      i--;
    }
  }

  // Replace "missing" entries with "wrong" when a nearby extra exists
  // (best-effort heuristic: pair adjacent extra+missing as "wrong")
  for (let k = 0; k < diff.length - 1; k++) {
    if (diff[k].status === "extra" && diff[k + 1].status === "missing") {
      diff[k] = { word: diff[k].word, status: "wrong" };
      diff[k + 1] = { word: diff[k + 1].word, status: "missing" };
    }
  }

  return diff;
}

// ---- Error type classification ----

/**
 * Classify the primary error type given expected vs user text.
 * Both inputs should already be normalised (relaxed mode).
 */
export function classifyError(
  expected: string,
  user: string
): ErrorType {
  const expWords = expected.split(" ").filter(Boolean);
  const userWords = user.split(" ").filter(Boolean);

  const expLower = expected.toLowerCase();
  const userLower = user.toLowerCase();

  // Case difference only
  if (expLower === userLower) return "capitalization";

  // Punctuation difference (strip, then compare)
  const expNoPunct = removePunctuation(expLower).replace(/\s+/g, " ").trim();
  const userNoPunct = removePunctuation(userLower).replace(/\s+/g, " ").trim();
  if (expNoPunct === userNoPunct) return "punctuation";

  // Missing words
  if (userWords.length < expWords.length) return "missing_word";

  // Extra words
  if (userWords.length > expWords.length) return "extra_word";

  // Same number of words — check if it's a wrong form / grammar issue
  // (simplistic: any remaining difference is "wrong_form")
  return "wrong_form";
}

// ---- Main check function ----

/**
 * Compares userText against expectedText in the given match mode.
 * Returns a CheckResult with isCorrect flag, error type, and diff.
 */
export function checkAnswer(
  expectedText: string,
  userText: string,
  mode: MatchMode = "relaxed"
): CheckResult {
  const normalizedExpected = normalizeText(expectedText, mode);
  const normalizedUser = normalizeText(userText, mode);

  const isCorrect = normalizedExpected === normalizedUser;

  const errorType: ErrorType = isCorrect
    ? "none"
    : classifyError(normalizedExpected, normalizedUser);

  const diff = wordDiff(
    normalizedExpected.split(" ").filter(Boolean),
    normalizedUser.split(" ").filter(Boolean)
  );

  return {
    isCorrect,
    matchMode: mode,
    errorType,
    diff,
    normalizedExpected,
    normalizedUser,
  };
}

// ---- Spelling check helper ----

/**
 * Returns true when the user text has any words that differ from expected
 * (used in relaxed mode after stripping punctuation/case).
 */
export function hasSpellingError(
  normalizedExpected: string,
  normalizedUser: string
): boolean {
  const exp = normalizedExpected.split(" ").filter(Boolean);
  const usr = normalizedUser.split(" ").filter(Boolean);
  if (exp.length !== usr.length) return false;
  return exp.some((w, i) => w !== usr[i]);
}
