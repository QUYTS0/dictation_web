# Vocab-highlight dataset build tooling

Regenerates the compact, server-only derived datasets under
`src/lib/vocabHighlights/data/` from the official raw releases of EFLLex and
Open English WordNet. Production code never downloads or parses raw
datasets at request time — only these committed derived `.json` files.

Raw source files are downloaded into `raw/` (gitignored — not committed,
see `.gitignore`) and are never shipped to the app.

## EFLLex (CC BY-NC-SA 4.0)

```
curl -L -o raw/EFLLex.tsv \
  https://cental.uclouvain.be/cefrlex/static/resources/en/EFLLex.tsv
node build-efllex.js
```

Attribution: Durlich, L. and Francois, T. (2018). *EFLLex: A Graded Lexical
Resource for Learners of English as a Foreign Language.* LREC 2018.
See `THIRD_PARTY_NOTICES.md` — the derived `efllex.json` is a ShareAlike
adaptation and must keep the CC BY-NC-SA 4.0 notice; it is also a
commercialisation blocker for this app while EFLLex is in use.

## Open English WordNet (CC BY 4.0)

```
curl -L -o raw/wordnet.zip \
  https://github.com/globalwordnet/english-wordnet/releases/download/2025-edition/english-wordnet-2025-json.zip
unzip -o raw/wordnet.zip -d raw/wordnet_json
node build-wordnet.js
```

Attribution: Open English WordNet, https://en-word.net/
(globalwordnet/english-wordnet, 2025 edition). Raw-file redistribution with
attribution is permitted by CC BY 4.0 — only a derived compact index is
committed here purely to keep the deployed bundle small, not because the
licence requires it.

## SUBTLEX

No build step — `subtlex-word-frequencies` (npm, ISC) is imported directly
at runtime by `src/lib/vocabHighlights/subtlex.ts`. The underlying SUBTLEX-US
dataset's own distribution terms are independent of the npm wrapper's ISC
code licence and were not conclusively verified — see
`THIRD_PARTY_NOTICES.md`.

## After regenerating either dataset

1. Re-run `node scripts/build-vocab-datasets/build-manifest.js` (or manually
   update `src/lib/vocabHighlights/data/manifest.json`) with the new
   `sourceSha256`/version values reported by the build script.
2. Bump `PIPELINE_VERSION` in `src/lib/vocabHighlights/config.ts` — dataset
   changes only invalidate the highlight cache through this single version
   string (see the plan's cache-versioning design), not automatically.
