import {
  normalizeText,
  checkAnswer,
  wordDiff,
  classifyError,
} from "@/lib/utils/text";

describe("normalizeText", () => {
  it("trims whitespace", () => {
    expect(normalizeText("  hello world  ", "exact")).toBe("hello world");
  });

  it("collapses internal spaces", () => {
    expect(normalizeText("hello   world", "exact")).toBe("hello world");
  });

  it("normalises smart quotes (exact mode)", () => {
    expect(normalizeText("it\u2019s", "exact")).toBe("it's");
  });

  it("lowercases in relaxed mode", () => {
    expect(normalizeText("Hello World", "relaxed")).toBe("hello world");
  });

  it("strips punctuation in relaxed mode", () => {
    expect(normalizeText("Hello, world!", "relaxed")).toBe("hello world");
  });

  it("preserves case in exact mode", () => {
    expect(normalizeText("Hello World.", "exact")).toBe("Hello World.");
  });
});

describe("checkAnswer", () => {
  it("returns isCorrect=true for exact match (relaxed mode)", () => {
    const result = checkAnswer("He goes to school.", "He goes to school.", "relaxed");
    expect(result.isCorrect).toBe(true);
  });

  it("ignores case in relaxed mode", () => {
    const result = checkAnswer("Hello World", "hello world", "relaxed");
    expect(result.isCorrect).toBe(true);
  });

  it("ignores trailing punctuation in relaxed mode", () => {
    const result = checkAnswer("Hello world.", "Hello world", "relaxed");
    expect(result.isCorrect).toBe(true);
  });

  it("returns isCorrect=false for wrong answer", () => {
    const result = checkAnswer("He goes to school.", "He go to school.", "relaxed");
    expect(result.isCorrect).toBe(false);
  });

  it("is case-sensitive in exact mode", () => {
    const result = checkAnswer("Hello World", "hello world", "exact");
    expect(result.isCorrect).toBe(false);
  });

  it("returns errorType=none when correct", () => {
    const result = checkAnswer("fine", "fine", "relaxed");
    expect(result.errorType).toBe("none");
  });

  it("populates diff tokens", () => {
    const result = checkAnswer("the cat sat", "the dog sat", "relaxed");
    expect(result.diff.length).toBeGreaterThan(0);
    const catToken = result.diff.find((d) => d.word === "cat");
    expect(catToken?.status).toBe("missing");
  });
});

describe("wordDiff", () => {
  it("returns all correct tokens for identical sentences", () => {
    const diff = wordDiff(["a", "b", "c"], ["a", "b", "c"]);
    expect(diff.every((t) => t.status === "correct")).toBe(true);
  });

  it("detects a missing word", () => {
    const diff = wordDiff(["hello", "world"], ["hello"]);
    expect(diff.some((t) => t.word === "world" && t.status === "missing")).toBe(true);
  });

  it("detects an extra word", () => {
    const diff = wordDiff(["hello"], ["hello", "world"]);
    expect(diff.some((t) => t.word === "world" && t.status === "extra")).toBe(true);
  });
});

describe("classifyError", () => {
  it("classifies capitalization error", () => {
    expect(classifyError("hello world", "Hello World")).toBe("capitalization");
  });

  it("classifies missing word", () => {
    expect(classifyError("he goes to school", "he goes school")).toBe("missing_word");
  });

  it("classifies extra word", () => {
    expect(classifyError("he goes to school", "he always goes to school")).toBe("extra_word");
  });
});
