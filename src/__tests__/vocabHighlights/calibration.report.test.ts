import { runPipeline } from "@/lib/vocabHighlights/pipeline";
import fixtureData from "./__fixtures__/calibration-sentences.json";

/**
 * Calibration consumer for the deterministic vocab-highlight pipeline.
 *
 * Reuses the project's existing TypeScript test runner (ts-jest via Jest) —
 * no new tooling (e.g. tsx/ts-node) is added; see the plan for why.
 *
 * "pass" cases are required and gate the build like any other regression
 * test. "known_limitation" cases run for real (so a crash is still caught)
 * but are never asserted correct — they're aggregated into a report instead,
 * so a real measured precision gap (lexical coverage or sense
 * disambiguation) is visible without ever becoming a false-green test.
 *
 * Azure Key Phrase Extraction is naturally inert here: AZURE_KEY_PHRASE_ENABLED
 * defaults to false unless explicitly set to "true" (config.ts), so this
 * suite makes no network calls without needing any mocking.
 */

interface CalibrationCase {
  text: string;
  category: "canonicalization" | "boundary" | "coverage" | "sense" | "punctuation";
  expectedStatus: "pass" | "known_limitation";
  expectedSurface?: string;
  expectedCanonical?: string;
}

const cases = (fixtureData as { cases: CalibrationCase[] }).cases;

interface CaseOutcome {
  case: CalibrationCase;
  actualSurface: string | null;
  actualCanonical: string | null;
  surfaceMatches: boolean;
  canonicalMatches: boolean;
  offsetsExact: boolean;
  sources: string[];
  durationMs: number;
}

const outcomes: CaseOutcome[] = [];

describe("vocab-highlight calibration", () => {
  it.each(cases.filter((c) => c.expectedStatus === "pass"))(
    "[pass/$category] $text",
    async (testCase) => {
      const started = Date.now();
      const result = await runPipeline([{ segmentIndex: 0, textRaw: testCase.text }], "B1");
      const durationMs = Date.now() - started;
      const seg = result.bySegment.get(0);
      const phrases = seg?.phrases ?? [];

      const match = testCase.expectedSurface
        ? phrases.find((p) => p.phrase === testCase.expectedSurface)
        : undefined;

      outcomes.push({
        case: testCase,
        actualSurface: match?.phrase ?? null,
        actualCanonical: match?.canonicalForm ?? null,
        surfaceMatches: !!match,
        canonicalMatches: testCase.expectedCanonical ? match?.canonicalForm === testCase.expectedCanonical : true,
        offsetsExact: match ? testCase.text.slice(match.start, match.end) === match.phrase : true,
        sources: [],
        durationMs,
      });

      if (testCase.expectedSurface) {
        expect(match).toBeDefined();
        expect(testCase.text.slice(match!.start, match!.end)).toBe(match!.phrase);
        if (testCase.expectedCanonical) {
          expect(match!.canonicalForm).toBe(testCase.expectedCanonical);
        }
      }
    }
  );

  // known_limitation cases: run for real, never asserted correct. A crash
  // here still fails the suite (that's a real regression); a mismatch
  // against expectedSurface/expectedCanonical does not.
  it.each(cases.filter((c) => c.expectedStatus === "known_limitation"))(
    "[known_limitation/$category] $text (measured, not gated)",
    async (testCase) => {
      const started = Date.now();
      const result = await runPipeline([{ segmentIndex: 0, textRaw: testCase.text }], "B1");
      const durationMs = Date.now() - started;
      const seg = result.bySegment.get(0);
      const phrases = seg?.phrases ?? [];
      const match = testCase.expectedSurface
        ? phrases.find((p) => p.phrase === testCase.expectedSurface)
        : undefined;

      outcomes.push({
        case: testCase,
        actualSurface: match?.phrase ?? (phrases[0]?.phrase ?? null),
        actualCanonical: match?.canonicalForm ?? (phrases[0]?.canonicalForm ?? null),
        surfaceMatches: !!match,
        canonicalMatches: testCase.expectedCanonical ? match?.canonicalForm === testCase.expectedCanonical : true,
        offsetsExact: match ? testCase.text.slice(match.start, match.end) === match.phrase : true,
        sources: [],
        durationMs,
      });

      // No expect() tied to the ambiguous expectation — only proves the
      // pipeline ran without throwing.
      expect(result.bySegment.has(0)).toBe(true);
    }
  );

  afterAll(() => {
    const byCategory: Record<string, { total: number; passStatus: number; matched: number; canonicalCorrect: number; offsetExact: number }> = {};
    let totalDurationMs = 0;
    let falsePositiveOrMismatchCount = 0;

    for (const o of outcomes) {
      const cat = o.case.category;
      byCategory[cat] ??= { total: 0, passStatus: 0, matched: 0, canonicalCorrect: 0, offsetExact: 0 };
      byCategory[cat].total++;
      if (o.case.expectedStatus === "pass") byCategory[cat].passStatus++;
      if (o.surfaceMatches) byCategory[cat].matched++;
      if (o.canonicalMatches) byCategory[cat].canonicalCorrect++;
      if (o.offsetsExact) byCategory[cat].offsetExact++;
      if (o.case.expectedStatus === "pass" && (!o.surfaceMatches || !o.canonicalMatches)) {
        falsePositiveOrMismatchCount++;
      }
      totalDurationMs += o.durationMs;
    }

    const passCases = outcomes.filter((o) => o.case.expectedStatus === "pass");
    const knownLimitationCases = outcomes.filter((o) => o.case.expectedStatus === "known_limitation");

    const report = {
      totalCases: outcomes.length,
      byCategory,
      canonicalizationAccuracy:
        passCases.length > 0 ? passCases.filter((o) => o.canonicalMatches).length / passCases.length : null,
      exactOffsetAccuracy: passCases.length > 0 ? passCases.filter((o) => o.offsetsExact).length / passCases.length : null,
      requiredPassCaseFailures: falsePositiveOrMismatchCount,
      knownLimitations: knownLimitationCases.map((o) => ({
        text: o.case.text,
        category: o.case.category,
        expectedSurface: o.case.expectedSurface,
        expectedCanonical: o.case.expectedCanonical,
        actualSurface: o.actualSurface,
        actualCanonical: o.actualCanonical,
        matchesExpectation: o.surfaceMatches && o.canonicalMatches,
      })),
      totalDurationMs,
      averageDurationMs: outcomes.length > 0 ? totalDurationMs / outcomes.length : 0,
    };

    console.log("[vocab-highlights calibration report]\n" + JSON.stringify(report, null, 2));
  });
});
