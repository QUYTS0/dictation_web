# Third-party notices

This file documents the datasets and packages the deterministic
vocabulary-highlight pipeline (`src/lib/vocabHighlights/`) depends on,
beyond what's already covered by their own npm package licences.

## EFLLex

- Source: https://cental.uclouvain.be/cefrlex/efllex/download/
- Licence: **CC BY-NC-SA 4.0** (Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International)
- Attribution: Durlich, L. and Francois, T. (2018). *EFLLex: A Graded
  Lexical Resource for Learners of English as a Foreign Language.*
  Proceedings of LREC 2018.
- Version acquired: `efllex-2018-1` (see `src/lib/vocabHighlights/data/manifest.json`
  and the `sourceSha256` recorded in `src/lib/vocabHighlights/data/efllex.json`'s
  own `meta` block for the exact raw file hash).
- **Commercialisation blocker**: the CC BY-NC-SA 4.0 licence's
  non-commercial and ShareAlike terms apply to the derived
  `data/efllex.json` file (it is an adaptation of the raw dataset, not a
  fresh work). While this application remains personal/non-commercial this
  is acceptable; if the application ever becomes commercial, EFLLex-derived
  difficulty data must be replaced or separately relicensed before that
  happens.
- Raw TSV is not committed to this repository (see
  `scripts/build-vocab-datasets/README.md` for the reproducible download
  procedure) — this is a repository-size choice, not a licence requirement;
  the derived JSON alone is what needs the CC BY-NC-SA 4.0 notice.

## Open English WordNet

- Source: https://github.com/globalwordnet/english-wordnet (2025 edition,
  official JSON release)
- Licence: **CC BY 4.0** (Creative Commons Attribution 4.0 International)
- Attribution: Open English WordNet, https://en-word.net/
- Redistribution of the raw release files **with attribution is explicitly
  permitted** by this licence (no ShareAlike, no non-commercial
  restriction). This repository still commits only a derived compact
  multi-word index (`src/lib/vocabHighlights/data/wordnetMultiwords.json`)
  rather than the full raw release — that is purely a deployed-bundle-size
  choice, not something the licence requires.
- Version acquired: `oewn-2025-edition` (see `manifest.json` and the
  `sourceSha256` recorded in `wordnetMultiwords.json`'s own `meta` block).

## SUBTLEX (via `subtlex-word-frequencies` npm package)

- Package: https://github.com/words/subtlex-word-frequencies
- Package code licence: **ISC** (confirmed from the package's own `license` file).
- **Underlying SUBTLEX-US dataset licence status: UNVERIFIED.** The npm
  package's own documentation does not state the original SUBTLEX-US
  academic dataset's distribution terms separately from its ISC-licensed
  wrapper code. This has not been resolved by this project and is flagged
  here for human/legal review before relying on it beyond this
  application's current personal, non-commercial use. Do not treat this
  note as legal clearance.
- No raw data is downloaded separately — the npm package (`index.json`,
  74,286 entries, ~49.7M total word occurrences as measured against the
  installed package) is imported directly at runtime by
  `src/lib/vocabHighlights/subtlex.ts`.

## winkNLP / wink-eng-lite-web-model

- Packages: https://winkjs.org/wink-nlp/, https://github.com/winkjs/wink-eng-lite-web-model
- Licence: standard npm package licence — confirm the exact licence text
  from each package's own `LICENSE` file in `node_modules/` at
  implementation/deploy time; not independently re-verified beyond the
  package registry metadata when this pipeline was built.

## Notes on winkNLP's named-entity recognition

`wink-eng-lite-web-model`'s built-in entity recognition is **pattern-based
only** (EMAIL, URL, DATE, TIME, MONEY, PERCENT, CARDINAL, ORDINAL, HASHTAG,
EMOTICON, EMOJI) — confirmed by direct testing during implementation. It
does **not** detect PERSON/ORG/GPE names. Proper-noun suspicion in this
pipeline instead comes from the POS tagger's `PROPN` tag, which is
soft-penalized (not hard-excluded) because the tagger itself can mistag a
sentence-initial common noun as `PROPN` (observed directly: "Farm animals
destined for food..." tags "Farm" as `PROPN`) — see
`src/lib/vocabHighlights/winkPipeline.ts`'s corroboration check.
