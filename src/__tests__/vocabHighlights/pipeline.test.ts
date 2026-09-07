import { runPipeline } from "@/lib/vocabHighlights/pipeline";

describe("runPipeline (local-only)", () => {
  const text = "Farm animals destined for food vanish—whisked away to another planet.";

  it("produces exactly 'destined' and 'whisked away' for the canonical example sentence", async () => {
    const result = await runPipeline([{ segmentIndex: 0, textRaw: text }], "B1");
    const seg = result.bySegment.get(0);
    expect(seg).toBeDefined();
    const phraseTexts = seg!.phrases.map((p) => p.phrase).sort();
    expect(phraseTexts).toEqual(["destined", "whisked away"]);
  });

  it("never includes surrounding punctuation in a highlight", async () => {
    const result = await runPipeline([{ segmentIndex: 0, textRaw: text }], "B1");
    const seg = result.bySegment.get(0)!;
    for (const p of seg.phrases) {
      expect(p.phrase).not.toMatch(/[.,!?;:"'—]/);
    }
  });

  it("never produces overlapping highlights", async () => {
    const result = await runPipeline([{ segmentIndex: 0, textRaw: text }], "B1");
    const seg = result.bySegment.get(0)!;
    const sorted = [...seg.phrases].sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].start!).toBeGreaterThanOrEqual(sorted[i - 1].end!);
    }
  });

  it("every phrase's stored text is exactly text.slice(start, end)", async () => {
    const result = await runPipeline([{ segmentIndex: 0, textRaw: text }], "B1");
    const seg = result.bySegment.get(0)!;
    for (const p of seg.phrases) {
      expect(text.slice(p.start!, p.end!)).toBe(p.phrase);
    }
  });

  it("is byte-identical (deterministic) across repeated local-only runs", async () => {
    const a = await runPipeline([{ segmentIndex: 0, textRaw: text }], "B1");
    const b = await runPipeline([{ segmentIndex: 0, textRaw: text }], "B1");
    expect(JSON.stringify(Array.from(a.bySegment.entries()))).toEqual(
      JSON.stringify(Array.from(b.bySegment.entries()))
    );
  });

  it("highlights every occurrence of a repeated phrase, not just the first", async () => {
    // Long enough that the density selection's MAX_HIGHLIGHT_TOKEN_PERCENTAGE
    // cap doesn't itself suppress the second occurrence — this test is about
    // the offset-based renderer/candidate fix, not density limiting.
    const repeatedText =
      "After a very long and difficult struggle that lasted for many months, " +
      "he finally decided to give up on the project entirely, and later, " +
      "after even more consideration, she also decided to give up.";
    const result = await runPipeline([{ segmentIndex: 0, textRaw: repeatedText }], "B1");
    const seg = result.bySegment.get(0)!;
    const giveUps = seg.phrases.filter((p) => p.phrase.toLowerCase() === "give up");
    expect(giveUps).toHaveLength(2);
  });

  it("marks a genuinely uninteresting sentence as empty (zero highlights), not force-adding one", async () => {
    const boring = "I am here.";
    const result = await runPipeline([{ segmentIndex: 0, textRaw: boring }], "C1");
    const seg = result.bySegment.get(0)!;
    expect(seg.status).toBe("empty");
    expect(seg.phrases).toHaveLength(0);
  });

  it("relative difficulty changes with learner level", async () => {
    const text2 = "The proliferation of ubiquitous computing devices continues.";
    const forA1 = await runPipeline([{ segmentIndex: 0, textRaw: text2 }], "A1");
    const forC1 = await runPipeline([{ segmentIndex: 0, textRaw: text2 }], "C1");
    const countA1 = forA1.bySegment.get(0)!.phrases.length;
    const countC1 = forC1.bySegment.get(0)!.phrases.length;
    expect(countA1).toBeGreaterThanOrEqual(countC1);
  });
});
