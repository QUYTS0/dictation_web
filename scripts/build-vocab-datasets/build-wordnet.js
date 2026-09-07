#!/usr/bin/env node
// Builds src/lib/vocabHighlights/data/wordnetMultiwords.json from the
// official Open English WordNet JSON release.
//
// Open English WordNet is CC BY 4.0 — see THIRD_PARTY_NOTICES.md.
// Redistribution of the raw release with attribution is permitted by this
// licence; we still ship only a compact derived index (not the raw files)
// purely to keep the deployed bundle small, not because the licence
// requires it.
//
// Usage:
//   1. Download + unzip the official JSON release (not committed):
//        curl -L -o scripts/build-vocab-datasets/raw/wordnet.zip \
//          https://github.com/globalwordnet/english-wordnet/releases/download/2025-edition/english-wordnet-2025-json.zip
//        unzip -o scripts/build-vocab-datasets/raw/wordnet.zip -d scripts/build-vocab-datasets/raw/wordnet_json
//   2. node scripts/build-vocab-datasets/build-wordnet.js
//
// Structure of each raw entries-*.json file (confirmed against the real
// 2025-edition download): a flat object keyed by the lexical entry's written
// form (which may contain spaces for multi-word entries, e.g. "give up"),
// mapping to an object keyed by a short POS-category code (n/v/a/r/s, with
// "-1"/"-2" homograph suffixes for a handful of entries) whose value holds a
// `sense` array. We only need: the written form, which POS categories it
// belongs to, and how many words it has — not the full sense/synset graph.
//
// Classifying "phrasal_verb" vs. "multiword_expression": Open English
// WordNet does not tag phrasal verbs as a distinct category from ordinary
// verbs, and has no "idiom" tag at all. We approximate: a multi-word entry
// with a verb POS category whose last word is a common particle is treated
// as a phrasal verb; every other multi-word entry becomes a generic
// "multiword_expression". This is a deliberate, documented simplification,
// not a claim of linguistic precision.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const RAW_DIR = path.join(__dirname, "raw", "wordnet_json");
const OUT_PATH = path.join(__dirname, "..", "..", "src", "lib", "vocabHighlights", "data", "wordnetMultiwords.json");

const PARTICLES = new Set([
  "up", "down", "out", "off", "on", "in", "away", "back", "over", "through",
  "along", "across", "about", "around", "aside", "together", "apart",
  "forth", "forward", "by", "into", "onto", "upon",
]);

function posLetter(posKey) {
  // Strips a "-1"/"-2" homograph suffix, e.g. "v-1" -> "v".
  return posKey[0];
}

function classify(lemma, posKeys) {
  const words = lemma.split(" ");
  const hasVerb = posKeys.some((k) => posLetter(k) === "v");
  const lastWord = words[words.length - 1].toLowerCase();
  if (hasVerb && words.length <= 4 && PARTICLES.has(lastWord)) {
    return "phrasal_verb";
  }
  return "multiword_expression";
}

function main() {
  if (!fs.existsSync(RAW_DIR)) {
    console.error(`Raw WordNet JSON directory not found at ${RAW_DIR}. See the usage comment at the top of this file.`);
    process.exit(1);
  }

  const files = fs.readdirSync(RAW_DIR).filter((f) => f.startsWith("entries-") && f.endsWith(".json"));
  if (files.length === 0) {
    console.error(`No entries-*.json files found under ${RAW_DIR}.`);
    process.exit(1);
  }

  const hash = crypto.createHash("sha256");
  /** @type {Record<string, {kind: "phrasal_verb"|"multiword_expression", wordCount: number}>} */
  const multiwords = {};

  for (const file of files.sort()) {
    const raw = fs.readFileSync(path.join(RAW_DIR, file), "utf8");
    hash.update(raw);
    const data = JSON.parse(raw);

    for (const [lemma, posMap] of Object.entries(data)) {
      if (!lemma.includes(" ")) continue; // single-word entries aren't needed — EFLLex/SUBTLEX cover those
      const normalized = lemma.toLowerCase();
      const wordCount = normalized.split(" ").length;
      if (wordCount > 4) continue; // matches the pipeline's 4-word longest-match ceiling

      const kind = classify(normalized, Object.keys(posMap));
      // A lemma can appear in more than one entries-*.json shard only if it
      // legitimately differs by case, which we've already normalized away —
      // last one wins, which is fine since kind classification is stable
      // for a given normalized lemma.
      multiwords[normalized] = { kind, wordCount };
    }
  }

  const counts = { phrasal_verb: 0, multiword_expression: 0 };
  for (const v of Object.values(multiwords)) counts[v.kind]++;

  const output = {
    meta: {
      dataset: "open-english-wordnet",
      version: "oewn-2025-edition",
      licence: "CC BY 4.0",
      attribution: "Open English WordNet, https://en-word.net/ (globalwordnet/english-wordnet, 2025 edition)",
      sourceFiles: files.length,
      sourceSha256: hash.digest("hex"),
      generatedAt: new Date().toISOString(),
      entryCount: Object.keys(multiwords).length,
      counts,
    },
    multiwords,
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(output));

  const stat = fs.statSync(OUT_PATH);
  console.log(`Wrote ${OUT_PATH}`);
  console.log(`  entries: ${output.meta.entryCount} (phrasal_verb: ${counts.phrasal_verb}, multiword_expression: ${counts.multiword_expression})`);
  console.log(`  size: ${(stat.size / 1024).toFixed(1)} KB`);
  console.log(`  source sha256: ${output.meta.sourceSha256}`);
}

main();
