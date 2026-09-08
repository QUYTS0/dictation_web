import { analyzeTranscript } from "@/lib/vocabHighlights/winkPipeline";
import { generateSegmentCandidates } from "@/lib/vocabHighlights/candidates";

test("debug", () => {
  const text = "He decided to give up. Later, she also decided to give up.";
  const { bySegment, corroboratedPropnLemmas } = analyzeTranscript([{ segmentIndex: 0, text }]);
  const analysis = bySegment.get(0)!;
  console.log(JSON.stringify(analysis.tokens.map(t=>({text:t.text,lemma:t.lemma,pos:t.pos,punct:t.isPunctuation})), null, 1));
  const candidates = generateSegmentCandidates(analysis, corroboratedPropnLemmas);
  console.log(JSON.stringify(candidates.filter(c=>c.originalText.toLowerCase().includes('give') || c.originalText.toLowerCase()==='up'), null, 1));
});
