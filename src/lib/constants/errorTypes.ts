import type { ErrorType } from "@/lib/types";

export const ERROR_TYPE_OPTIONS: { value: ErrorType; label: string }[] = [
  { value: "spelling", label: "Spelling" },
  { value: "missing_word", label: "Missing word" },
  { value: "extra_word", label: "Extra word" },
  { value: "wrong_form", label: "Wrong form" },
  { value: "punctuation", label: "Punctuation" },
  { value: "capitalization", label: "Capitalization" },
];

export const ERROR_TYPE_LABELS: Record<ErrorType, string> = ERROR_TYPE_OPTIONS.reduce(
  (acc, opt) => ({ ...acc, [opt.value]: opt.label }),
  { none: "None" } as Record<ErrorType, string>
);

export function errorTypeLabel(errorType: ErrorType | null) {
  return (errorType && ERROR_TYPE_LABELS[errorType]) || "Other";
}

/**
 * What each recorded type MEANS, worded to match how answers are actually
 * classified (classifyError in src/lib/utils/text.ts and its SQL port):
 * case-only → capitalization; punctuation-only → punctuation; fewer words →
 * missing; more words → extra; same word count with any other difference →
 * wrong form (which includes misspellings). Descriptive, never advice.
 */
const ERROR_TYPE_DESCRIPTIONS: Record<ErrorType, string> = {
  spelling: "A word is spelled differently from the sentence.",
  missing_word: "Your answer has fewer words than the sentence — something was left out.",
  extra_word: "Your answer has more words than the sentence — something was added.",
  wrong_form: "Same number of words as the sentence, but at least one word is different — often a different ending, tense or spelling.",
  punctuation: "The words match; only the punctuation is different.",
  capitalization: "The words match; only capital letters are different.",
  none: "",
};

export function errorTypeDescription(errorType: ErrorType | null): string {
  return (errorType && ERROR_TYPE_DESCRIPTIONS[errorType]) || "";
}

export function isRecordedErrorType(value: unknown): value is ErrorType {
  return ERROR_TYPE_OPTIONS.some((o) => o.value === value);
}
