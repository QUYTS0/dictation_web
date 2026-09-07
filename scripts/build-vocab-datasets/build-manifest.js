#!/usr/bin/env node
// Regenerates src/lib/vocabHighlights/data/manifest.json from the currently
// installed npm package versions plus the two derived dataset files' own
// embedded version strings. Observability only (see the plan's cache-
// versioning design) — does not itself gate the highlight cache; bump
// PIPELINE_VERSION in config.ts by hand when any of these actually change.

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "..", "src", "lib", "vocabHighlights", "data");

function main() {
  const efllex = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "efllex.json"), "utf8"));
  const wordnet = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "wordnetMultiwords.json"), "utf8"));
  const subtlexPkg = require("../../node_modules/subtlex-word-frequencies/package.json");
  const winkNlpPkg = require("../../node_modules/wink-nlp/package.json");
  const winkModelPkg = require("../../node_modules/wink-eng-lite-web-model/package.json");

  const manifest = {
    winkModel: winkModelPkg.version,
    winkNlp: winkNlpPkg.version,
    efllex: efllex.meta.version,
    subtlex: subtlexPkg.version,
    openEnglishWordNet: wordnet.meta.version,
    generatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(path.join(DATA_DIR, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(JSON.stringify(manifest, null, 2));
}

main();
