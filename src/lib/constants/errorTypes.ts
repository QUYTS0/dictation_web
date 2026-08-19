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
