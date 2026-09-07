import fs from "fs";
import path from "path";

// Static guard: the deterministic vocabulary-highlight pipeline must never
// call Gemini — winkNLP/EFLLex/SUBTLEX/Open English WordNet (+ optional
// Azure Key Phrase Extraction) only. Transcript translation
// (app/api/transcript/translate/route.ts) is a separate, untouched pipeline
// and intentionally still uses Gemini as its final fallback tier.
describe("vocab-highlight pipeline never imports Gemini", () => {
  const root = path.join(__dirname, "..", "..");
  const vocabHighlightsDir = path.join(root, "lib", "vocabHighlights");
  const routeFile = path.join(root, "app", "api", "transcript", "vocab-highlights", "route.ts");

  function listTsFiles(dir: string): string[] {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return listTsFiles(full);
        return entry.name.endsWith(".ts") ? [full] : [];
      });
  }

  const filesToAudit = [...listTsFiles(vocabHighlightsDir), routeFile];

  it.each(filesToAudit)("%s does not import @google/generative-ai", (filePath) => {
    const content = fs.readFileSync(filePath, "utf8");
    expect(content).not.toMatch(/@google\/generative-ai/);
    expect(content).not.toMatch(/GoogleGenerativeAI/);
    expect(content).not.toMatch(/GEMINI_API_KEY|GEMINI_MODEL_NAME/);
  });
});
