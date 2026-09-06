import fs from "fs";
import path from "path";

// Static guard: the vocabulary word/phrase/sentence translation path
// (lib/translate.ts + its Azure client/cache, and the two vocabulary
// routes that call it) must never import the unofficial Google Translate
// scraper or Gemini — Azure Translator only. Transcript translation
// (app/api/transcript/translate/route.ts) is a separate, untouched
// pipeline and is intentionally excluded from this guard.
describe("vocabulary translation path uses Azure only", () => {
  const root = path.join(__dirname, "..");
  const filesToAudit = [
    "lib/translate.ts",
    "lib/azureTranslator.ts",
    "lib/translationCache.ts",
    "app/api/vocabulary/route.ts",
    "app/api/vocabulary/preview/route.ts",
  ];

  it.each(filesToAudit)("%s does not import @vitalets/google-translate-api", (relPath) => {
    const content = fs.readFileSync(path.join(root, relPath), "utf8");
    expect(content).not.toMatch(/@vitalets\/google-translate-api/);
  });

  it.each(filesToAudit)("%s does not import Gemini/@google/generative-ai", (relPath) => {
    const content = fs.readFileSync(path.join(root, relPath), "utf8");
    expect(content).not.toMatch(/@google\/generative-ai/);
    expect(content).not.toMatch(/GoogleGenerativeAI/);
  });

  it.each(filesToAudit)("%s does not hit another unofficial translate endpoint (MyMemory, DeepL, translate.googleapis.com)", (relPath) => {
    const content = fs.readFileSync(path.join(root, relPath), "utf8");
    expect(content).not.toMatch(/mymemory\.translated\.net/i);
    expect(content).not.toMatch(/api-free\.deepl\.com|api\.deepl\.com/i);
    expect(content).not.toMatch(/translate\.googleapis\.com/i);
  });

  it("lib/azureTranslator.ts only requests the dictionary/lookup and translate REST paths", () => {
    const translateSrc = fs.readFileSync(path.join(root, "lib/azureTranslator.ts"), "utf8");
    const azureFetchCalls = [...translateSrc.matchAll(/azureFetch\(`([^`]*)`/g)].map((m) => m[1]);
    expect(azureFetchCalls.length).toBeGreaterThan(0);
    for (const call of azureFetchCalls) {
      expect(call).toMatch(/^\/(dictionary\/lookup|translate)\?api-version=3\.0/);
    }
  });
});
