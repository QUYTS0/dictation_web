import { runPipeline } from "@/lib/vocabHighlights/pipeline";

/**
 * Table-driven regression tests: each of these sentences previously
 * produced a linguistically incomplete, truncated, or otherwise unhelpful
 * highlight (isolated fragments, unrelated adjacent prepositions, bare
 * named entities, possessive clitics). See the plan/report for root-cause
 * analysis of each — this file locks in the fixed behavior generally
 * (via the construction-expansion + boundary-validation stages), not via
 * any sentence-specific special-casing.
 */
const cases: Array<{
  name: string;
  text: string;
  mustInclude: string[];
  mustNotInclude: string[];
  /** phrase text -> expected learningPattern, for phrases that must carry one. */
  mustHavePattern?: Record<string, string>;
}> = [
  {
    name: "idiom + complement marker (go a long way toward)",
    text: "Reducing beef, cheese, and milk consumption could go a long way toward achieving many of the benefits of a meatless world.",
    mustInclude: ["go a long way toward"],
    mustNotInclude: ["go a long way", "long way", "toward"],
    mustHavePattern: { "go a long way toward": "go a long way toward(s) + noun/V-ing" },
  },
  {
    name: "verb-complement construction + supplementary idiom (paired with / business as usual)",
    text:
      "Even if we suddenly stopped burning fossil fuels, business as usual food systems paired with a growing population would push global temperatures over 1.5°C.",
    mustInclude: ["business as usual", "paired with"],
    mustNotInclude: ["paired", "as usual"],
    mustHavePattern: { "paired with": "pair A with B / be paired with something" },
  },
  {
    name: "hyphen-compound merging + phrasal-verb false-positive guard (meat-eating, not eating in)",
    text: "Ultimately, vegetarianism becomes less expensive than meat-eating in most countries.",
    mustInclude: ["meat-eating"],
    mustNotInclude: ["meat-eating in", "eating in"],
  },
  {
    name: "optional-internal-modifier construction (thanks in part to)",
    text: "Millions of deaths are avoided every year, thanks in part to lower rates of heart disease.",
    mustInclude: ["thanks in part to"],
    mustNotInclude: ["in part", "thanks"],
    mustHavePattern: { "thanks in part to": "thanks to + noun" },
  },
  {
    name: "quantifier construction (tens of millions, not bare Tens)",
    text: "Tens of millions of anglers lose work.",
    mustInclude: [],
    mustNotInclude: ["Tens", "tens"],
  },
  {
    name: "named-entity MWE rejection (United States)",
    text: "Members of salmon-eating tribes in the Pacific Northwest of the United States rely on fish.",
    mustInclude: ["rely on"],
    mustNotInclude: ["United States"],
  },
  {
    name: "comparative frame (ten times as much as, not much as)",
    text: "Farmed cattle alone weigh nearly ten times as much as all wild mammals combined.",
    mustInclude: [],
    mustNotInclude: ["much as"],
    mustHavePattern: { "ten times as much as": "N times as much as + uncountable noun" },
  },
  {
    name: "comparative frame (ten times as many as, not many as)",
    text: "The new factory hires ten times as many as its smaller predecessor.",
    mustInclude: [],
    mustNotInclude: ["many as"],
    mustHavePattern: { "ten times as many as": "N times as many as + plural countable noun" },
  },
  {
    name: "possessive clitic exclusion (world's)",
    text: "The industry produces only around 18% of the world's calories.",
    mustInclude: [],
    mustNotInclude: ["'s", "world's"],
  },
];

describe("regression examples", () => {
  it.each(cases)("$name", async ({ text, mustInclude, mustNotInclude, mustHavePattern }) => {
    const result = await runPipeline([{ segmentIndex: 0, textRaw: text }], "B1");
    const seg = result.bySegment.get(0);
    expect(seg).toBeDefined();
    const phraseTexts = (seg?.phrases ?? []).map((p) => p.phrase);

    for (const expected of mustInclude) {
      expect(phraseTexts).toContain(expected);
    }
    for (const forbidden of mustNotInclude) {
      expect(phraseTexts.map((p) => p.toLowerCase())).not.toContain(forbidden.toLowerCase());
    }
    for (const [phrase, pattern] of Object.entries(mustHavePattern ?? {})) {
      const match = (seg?.phrases ?? []).find((p) => p.phrase === phrase);
      expect(match).toBeDefined();
      expect(match!.learningPattern).toBe(pattern);
    }

    // Every phrase: exact offsets, no leading/trailing punctuation, no overlaps.
    const sorted = [...(seg?.phrases ?? [])].sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
    for (let i = 0; i < sorted.length; i++) {
      const p = sorted[i];
      expect(text.slice(p.start!, p.end!)).toBe(p.phrase);
      expect(p.phrase).not.toMatch(/^[.,!?;:"'()—-]|[.,!?;:"'()—-]$/);
      if (i > 0) expect(p.start!).toBeGreaterThanOrEqual(sorted[i - 1].end!);
    }
  });

  it("produces byte-identical output across repeated local-only runs for every example", async () => {
    for (const { text } of cases) {
      const a = await runPipeline([{ segmentIndex: 0, textRaw: text }], "B1");
      const b = await runPipeline([{ segmentIndex: 0, textRaw: text }], "B1");
      expect(JSON.stringify(Array.from(a.bySegment.entries()))).toEqual(JSON.stringify(Array.from(b.bySegment.entries())));
    }
  });
});
