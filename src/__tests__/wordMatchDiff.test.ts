import { summarizeWordMatchDiff } from "@/app/dictation/[videoId]/helpers";
import type { DiffToken } from "@/lib/types";

describe("summarizeWordMatchDiff", () => {
  it("turns a wrong+missing pair into one substitution entry", () => {
    const diff: DiffToken[] = [
      { word: "the", status: "correct" },
      { word: "grub", status: "wrong" },
      { word: "crop", status: "missing" },
      { word: "grows", status: "correct" },
    ];
    expect(summarizeWordMatchDiff(diff)).toEqual([{ kind: "substitution", expected: "crop", got: "grub" }]);
  });

  it("treats a standalone missing token (no preceding wrong) as a pure omission", () => {
    const diff: DiffToken[] = [
      { word: "the", status: "correct" },
      { word: "crop", status: "missing" },
      { word: "grows", status: "correct" },
    ];
    expect(summarizeWordMatchDiff(diff)).toEqual([{ kind: "missing", expected: "crop" }]);
  });

  it("treats a standalone extra token (never paired into wrong) as a pure insertion", () => {
    const diff: DiffToken[] = [
      { word: "the", status: "correct" },
      { word: "big", status: "extra" },
      { word: "crop", status: "correct" },
    ];
    expect(summarizeWordMatchDiff(diff)).toEqual([{ kind: "extra", got: "big" }]);
  });

  it("preserves left-to-right order across mixed change types and skips correct tokens", () => {
    const diff: DiffToken[] = [
      { word: "extra1", status: "extra" },
      { word: "the", status: "correct" },
      { word: "grub", status: "wrong" },
      { word: "crop", status: "missing" },
      { word: "grows", status: "correct" },
      { word: "fast", status: "missing" },
    ];
    expect(summarizeWordMatchDiff(diff)).toEqual([
      { kind: "extra", got: "extra1" },
      { kind: "substitution", expected: "crop", got: "grub" },
      { kind: "missing", expected: "fast" },
    ]);
  });

  it("returns an empty array for an all-correct diff (the exact-match case)", () => {
    const diff: DiffToken[] = [
      { word: "the", status: "correct" },
      { word: "crop", status: "correct" },
    ];
    expect(summarizeWordMatchDiff(diff)).toEqual([]);
  });

  it("does not throw on a trailing wrong token with no following pair", () => {
    const diff: DiffToken[] = [{ word: "grub", status: "wrong" }];
    expect(summarizeWordMatchDiff(diff)).toEqual([{ kind: "substitution", expected: "", got: "grub" }]);
  });
});
