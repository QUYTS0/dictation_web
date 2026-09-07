#!/usr/bin/env node
// Builds src/lib/vocabHighlights/data/efllex.json from the raw EFLLex TSV.
//
// EFLLex is CC BY-NC-SA 4.0 (Durlich & Francois, LREC 2018) — see
// THIRD_PARTY_NOTICES.md. The derived JSON produced here is itself a
// ShareAlike-covered adaptation and must keep the same licence notice.
//
// Usage:
//   1. Download the raw file (not committed to this repo):
//        curl -L -o scripts/build-vocab-datasets/raw/EFLLex.tsv \
//          https://cental.uclouvain.be/cefrlex/static/resources/en/EFLLex.tsv
//   2. node scripts/build-vocab-datasets/build-efllex.js
//
// Raw column layout (confirmed against the real download on 2026-09-08):
//   word  tag  level_freq@a1  level_freq@a2  level_freq@b1  level_freq@b2
//   level_freq@c1  total_freq@total  ...per-source-document columns (unused)
//
// `word` uses "_" to join multi-word entries (e.g. "access_road"). We keep
// only what's needed to reproduce the difficulty calculation: lemma, POS tag,
// and the five per-level frequencies. Per-document breakdown columns are
// dropped entirely — the app never needs them.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const RAW_PATH = path.join(__dirname, "raw", "EFLLex.tsv");
const OUT_PATH = path.join(__dirname, "..", "..", "src", "lib", "vocabHighlights", "data", "efllex.json");
const LEVELS = ["a1", "a2", "b1", "b2", "c1"];

function main() {
  if (!fs.existsSync(RAW_PATH)) {
    console.error(`Raw EFLLex TSV not found at ${RAW_PATH}. See the usage comment at the top of this file.`);
    process.exit(1);
  }

  const raw = fs.readFileSync(RAW_PATH, "utf8");
  const sourceHash = crypto.createHash("sha256").update(raw).digest("hex");
  const lines = raw.split("\n").filter((l) => l.length > 0);
  const header = lines[0].split("\t");

  const colIndex = (name) => {
    const idx = header.indexOf(name);
    if (idx === -1) throw new Error(`Expected column "${name}" not found in EFLLex.tsv header`);
    return idx;
  };

  const wordIdx = colIndex("word");
  const tagIdx = colIndex("tag");
  const levelIdx = Object.fromEntries(LEVELS.map((lvl) => [lvl, colIndex(`level_freq@${lvl}`)]));

  /** @type {Record<string, Array<{pos: string, levelFreq: Record<string, number>, isMultiword: boolean}>>} */
  const entries = {};
  let multiwordCount = 0;

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split("\t");
    if (cols.length < header.length) continue;

    const rawWord = cols[wordIdx];
    const tag = cols[tagIdx];
    if (!rawWord || !tag) continue;

    const isMultiword = rawWord.includes("_");
    const lemma = (isMultiword ? rawWord.replace(/_/g, " ") : rawWord).toLowerCase();
    if (isMultiword) multiwordCount++;

    const levelFreq = {};
    for (const lvl of LEVELS) {
      const v = Number.parseFloat(cols[levelIdx[lvl]]);
      levelFreq[lvl] = Number.isFinite(v) ? Math.round(v * 10000) / 10000 : 0;
    }

    if (!entries[lemma]) entries[lemma] = [];
    entries[lemma].push({ pos: tag, levelFreq, isMultiword });
  }

  const output = {
    meta: {
      dataset: "efllex",
      version: "efllex-2018-1",
      licence: "CC BY-NC-SA 4.0",
      attribution: "Durlich, L. and Francois, T. (2018). EFLLex: A Graded Lexical Resource for Learners of English as a Foreign Language. LREC 2018.",
      sourceFile: "EFLLex.tsv",
      sourceSha256: sourceHash,
      generatedAt: new Date().toISOString(),
      lemmaCount: Object.keys(entries).length,
      multiwordEntryCount: multiwordCount,
    },
    entries,
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(output));

  const stat = fs.statSync(OUT_PATH);
  console.log(`Wrote ${OUT_PATH}`);
  console.log(`  lemmas: ${output.meta.lemmaCount} (of which ${multiwordCount} multi-word)`);
  console.log(`  size: ${(stat.size / 1024).toFixed(1)} KB`);
  console.log(`  source sha256: ${sourceHash}`);
}

main();
