I want to replace the Gemini-based vocabulary-highlight generation with a deterministic, mostly local pipeline using all five components below:

| Component                   | Responsibility                                                                |
| --------------------------- | ----------------------------------------------------------------------------- |
| winkNLP                     | Tokenization, lemma, POS tagging, named-entity filtering, original text spans |
| EFLLex                      | Relative learner difficulty across CEFR levels                                |
| SUBTLEX                     | Spoken-English word frequency fallback                                        |
| Open English WordNet        | Phrasal verbs and multi-word expressions                                      |
| Azure Key Phrase Extraction | Final optional enrichment for missed topic/noun phrases                       |

Please inspect the current repository and create a **detailed implementation plan only**. Do not modify code yet.

## Primary objectives

The new highlight system must be:

* Deterministic: the same transcript, user level, dataset versions, and algorithm version must produce the same highlights.
* Mostly local: winkNLP, EFLLex, SUBTLEX, and Open English WordNet must run without external API calls.
* Stable when Azure is unavailable.
* Independent from transcript translation.
* Suitable for a Next.js application deployed on Vercel.
* Efficient enough to process an entire transcript without affecting the practice-page loading experience.
* Versioned and cacheable.
* Safe for the existing Script panel highlighting implementation.
* Able to find both difficult individual words and useful multi-word expressions.
* Free within the selected libraries, dataset licences, and Azure Language F0 quota.

Gemini must no longer be the primary or fallback engine for vocabulary-highlight generation.

---

# 1. Inspect the current system first

Trace the complete current flow involving:

* `useVocabHighlights.ts`
* `/api/transcript/vocab-highlights`
* The database/server-side highlight cache
* The highlight response types
* Script panel rendering
* Text range or offset matching
* Existing Gemini prompt and response parsing
* Error handling
* React Query keys and `staleTime`
* How empty highlight results are currently stored
* Whether highlight generation happens during transcript creation, page loading, or the first practice session
* Any existing regenerate or cache-clearing behavior

Also inspect:

* How transcripts and segments are stored
* How segment text is normalized
* Whether transcript text may change after regeneration
* Existing user-level or learning-level settings
* Current Supabase migration, RLS, server-client, and service-role conventions
* Existing Vercel runtime and bundle constraints

Do not invent filenames, database tables, fields, or behaviors that do not exist. Reference the actual files and symbols discovered in the repository.

---

# 2. Preserve unrelated systems

Do not modify:

* Transcript generation
* Transcript translation
* `Regenerate Translation`
* The existing YouTube captions → unofficial translation library → Gemini transcript-translation fallback
* Azure Translator vocabulary lookup
* Azure Speech Pronunciation Assessment
* Shadowing, Listening, or Dictation behavior
* Saved vocabulary
* Word Match evaluation
* Manual word/phrase/sentence selection
* Vocabulary preview and save APIs
* Existing transcript translation cache

The unofficial Google translation dependency may still be required by transcript translation. Do not remove it as part of this task.

This task applies only to automatic difficult-word and phrase highlights.

`Regenerate Translation` and `Regenerate Vocabulary Highlights` must remain separate actions with separate APIs and cache invalidation.

---

# 3. Proposed deterministic pipeline

Plan the implementation around this processing order:

```text
Transcript segments
→ winkNLP analysis
→ EFLLex multi-word matching
→ Open English WordNet multi-word matching
→ EFLLex word difficulty
→ SUBTLEX frequency fallback
→ candidate scoring and filtering
→ Azure Key Phrase Extraction when enrichment is needed
→ validate Azure candidates
→ resolve overlaps
→ store versioned result
```

The plan must define clear responsibilities and data contracts between every stage.

---

# 4. winkNLP integration

Use:

```text
wink-nlp
wink-eng-lite-web-model
```

Use winkNLP for:

* Tokenization
* Sentence boundaries where necessary
* Lemmatization
* Universal POS tags
* Stop-word detection
* Named-entity filtering
* Distinguishing words from punctuation
* Maintaining or reconstructing exact offsets into the original segment text

Run winkNLP server-side. Do not add the language model to the main client bundle.

The plan must address:

* Contractions such as `isn't`, `they're`, and `we've`
* Possessives
* Hyphenated terms
* Curly quotation marks
* Em dashes
* Apostrophes
* Capitalized words at the beginning of sentences
* British and American spelling differences
* Inflected forms:

  * `expands` → `expand`
  * `destined` → `destine`
  * `emissions` → `emission`
* Proper nouns and acronyms
* Transcript recognition mistakes
* Preserving original casing for rendering
* Excluding leading and trailing punctuation from highlight spans

Do not blindly exclude every capitalized token because sentence-initial words may be normal vocabulary.

The plan must explain whether winkNLP is instantiated once per server process, lazily loaded, or wrapped in a server-only singleton to reduce Vercel cold-start overhead.

Official project references:

* https://winkjs.org/wink-nlp/
* https://github.com/winkjs/wink-eng-lite-web-model

---

# 5. EFLLex integration

Use EFLLex as the primary learner-difficulty resource.

EFLLex contains:

* English lemmas
* POS information
* Frequency distributions across A1–C1 learner materials
* Multi-word expressions

Official resource:

* https://cental.uclouvain.be/cefrlex/efllex/download/

Important licence constraint:

```text
CC BY-NC-SA 4.0
```

This application is currently personal and non-commercial. The plan must:

* Document the licence and attribution requirements.
* Recommend where attribution should appear.
* Add or update a third-party notices file.
* Mark EFLLex as a commercialisation blocker.
* Explain what must be replaced or relicensed if the application later becomes commercial.
* Avoid claiming that EFLLex gives an authoritative CEFR level for every word.

EFLLex provides level-frequency distributions, not necessarily a single absolute CEFR label. Propose and document a deterministic method for deriving a relative difficulty estimate.

For example, the plan may consider:

* First level at which the lemma reaches a meaningful normalized frequency.
* Weighted CEFR distribution.
* Dominant level combined with earlier-level presence.
* A configurable threshold rather than a hard-coded unexplained mapping.

Do not silently choose a formula. The plan must recommend one, explain its trade-offs, and define tests for it.

Inspect whether a user learning level already exists. If none exists, propose a minimal configuration strategy, such as:

```ts
type LearningLevel = "A1" | "A2" | "B1" | "B2" | "C1";
```

Recommend a default, but identify it as a product decision instead of silently implementing it.

Difficulty should be relative to the learner. A word estimated at B2 may be highlighted for a B1 learner but not necessarily for a C1 learner.

---

# 6. SUBTLEX integration

Use:

```text
subtlex-word-frequencies
```

SUBTLEX is the fallback for individual words that:

* Are not present in EFLLex
* Have ambiguous EFLLex evidence
* Need an additional spoken-English frequency signal

Reference:

* https://github.com/words/subtlex-word-frequencies

The plan must verify:

* Package version
* ISC licence
* Required attribution for the package and underlying SUBTLEX data
* Dataset size
* Server bundle impact
* Lookup format and normalization rules

Propose configurable frequency bands, for example:

```text
Very common
Common
Uncommon
Rare
Unknown
```

Do not treat every unknown word as difficult. Unknown tokens may be:

* Proper nouns
* Acronyms
* Transcript mistakes
* Numbers
* Domain-specific names
* Hyphenation artifacts

An unknown token must pass validation before becoming a highlight.

Do not hard-code a frequency rank such as 5,000 or 10,000 without centralizing it in configuration and testing it against representative transcripts.

---

# 7. Open English WordNet integration

Use Open English WordNet for detecting and validating:

* Phrasal verbs
* Idiomatic lexical expressions
* Compound terms
* Multi-word expressions

Official resources:

* https://en-word.net/
* https://github.com/globalwordnet/english-wordnet

Licence:

```text
CC BY 4.0
```

The plan must document attribution requirements.

Do not load the complete WordNet graph into the browser.

Evaluate the best server-side deployment option:

1. Preprocess the official JSON release into a compact server-only multi-word index.
2. Store the required multi-word index in Supabase.
3. Use a generated compressed server asset.
4. Query the official JSON API only if local deployment is genuinely impractical.

Prefer a local and deterministic solution. Avoid introducing a public API dependency when the data can be safely packaged.

The plan must consider Vercel:

* Deployment bundle size
* Serverless cold starts
* Memory usage
* Parsing time
* Edge versus Node runtime compatibility
* Whether preprocessing should happen at development/build time rather than request time

Only retain the fields needed for highlight generation. Do not ship the full synonym graph, definitions, and relations if the application only needs normalized multi-word lemmas and basic POS/type metadata.

Use a longest-match strategy:

```text
4-word candidate
→ 3-word candidate
→ 2-word candidate
→ individual words
```

If `whisked away` is selected, do not also select `whisked` and `away` separately unless there is a strong and explicitly documented reason.

---

# 8. Candidate generation

Every candidate should have a normalized internal structure similar to:

```ts
type HighlightCandidate = {
  segmentIndex: number;
  originalText: string;
  normalizedText: string;
  lemma?: string;
  start: number;
  end: number;
  tokenStart?: number;
  tokenEnd?: number;
  kind:
    | "word"
    | "phrasal_verb"
    | "idiom"
    | "multiword_expression"
    | "topic_phrase";
  source:
    | "efllex"
    | "subtlex"
    | "wordnet"
    | "azure_key_phrase";
  pos?: string;
  estimatedLevel?: LearningLevel;
  frequencyRank?: number;
  score: number;
  reasons: string[];
};
```

This is an illustrative contract. Adapt it to existing project types instead of duplicating types unnecessarily.

The scoring system must be deterministic and centrally configured.

Consider signals such as:

* Difficulty relative to user level
* EFLLex distribution
* SUBTLEX rarity
* Multi-word-expression bonus
* Phrasal-verb bonus
* Topic-phrase bonus
* Previously saved vocabulary, if existing data can be accessed efficiently
* Previously known/dismissed vocabulary, if such a concept exists
* Proper-noun penalty
* Transcript-error penalty

The plan must clearly separate:

* Candidate generation
* Candidate scoring
* Candidate validation
* Final selection

Do not bury all logic inside one API route.

---

# 9. Azure Key Phrase Extraction as final enrichment

Azure Key Phrase Extraction must be used as:

```text
Optional topic-phrase enrichment
```

It must not be treated as:

* A CEFR engine
* A difficulty score
* A phrasal-verb detector
* A replacement for EFLLex
* A reason to force at least one highlight into every sentence

Azure should run only after the four local components.

Use server-only environment variables following existing Azure conventions. Inspect the project before deciding exact names, but an expected structure may be:

```env
AZURE_LANGUAGE_ENDPOINT=
AZURE_LANGUAGE_KEY=
AZURE_LANGUAGE_API_VERSION=
AZURE_LANGUAGE_KEY_PHRASE_MODEL_VERSION=
```

Requirements:

* Never expose Azure credentials to client code.
* Never log keys or authorization headers.
* Use a pinned stable API/model version where possible.
* Do not rely on `"latest"` without documenting the reproducibility trade-off.
* Use a request timeout.
* Retry only transient failures with limited backoff.
* Respect rate limits.
* Do not retry an exhausted monthly quota repeatedly.
* Azure failure must never make the entire highlight endpoint fail if local results exist.

Azure Language F0 currently shares 5,000 free text records per month across several Language features. One text record is measured per 1,000 characters.

Do not call Azure once per sentence by default.

Propose a batching strategy such as:

```text
Collect unresolved or low-phrase-coverage segments
→ group them into documents below the synchronous character limit
→ send multiple documents in one request where supported
→ map returned phrases back to exact transcript spans
```

Current service constraints must be verified from official documentation during planning, including:

* Character limit per synchronous document
* Maximum documents per request
* Text-record billing behavior
* Rate limits

Official references:

* https://learn.microsoft.com/en-us/azure/ai-services/language-service/key-phrase-extraction/how-to/call-api
* https://learn.microsoft.com/en-us/azure/ai-services/language-service/concepts/data-limits
* https://azure.microsoft.com/en-us/pricing/details/language/

Define a configurable trigger for Azure. For example, Azure might run only when:

* A transcript chunk has no useful multi-word candidates.
* Local phrase coverage is below a configured threshold.
* The local system finds individual difficult words but no meaningful phrases.

Do not call Azure merely because one simple sentence has zero highlights.

Every Azure result must pass validation:

* It appears in the original transcript.
* It maps to exact start/end offsets.
* Leading and trailing punctuation are removed.
* It does not cross segment boundaries.
* It is not only a named entity.
* It does not duplicate a local candidate.
* It does not create an invalid overlap.
* It has educational value under a documented rule.
* Long phrases are capped to a sensible length.

Azure returns important noun/topic phrases, not learner difficulty. Store its source as `azure_key_phrase` and kind as `topic_phrase`; do not give it a fake CEFR level.

---

# 10. Overlap resolution

Define one deterministic overlap-resolution function.

Recommended priority:

```text
Validated phrasal verb or idiom
→ meaningful longer multi-word expression
→ Azure topic phrase
→ difficult individual word
```

However, candidate score and educational relevance may refine this order.

Requirements:

* Prefer the longest useful phrase.
* Do not highlight both a phrase and contained words.
* Do not merge unrelated adjacent candidates.
* Do not include punctuation.
* Preserve exact original transcript text.
* Handle repeated occurrences of the same phrase.
* Never create ranges outside the segment.
* Use half-open ranges consistently, such as `[start, end)`.

Example:

```text
Farm animals destined for food vanish—whisked away to another planet.
```

Expected:

```text
destined
whisked away
```

Not:

```text
destined,
whisked
away
whisked away
```

---

# 11. Final selection density

Do not overwhelm the Script panel.

Propose configurable selection limits, such as:

* Maximum highlights per sentence
* Maximum highlighted-token percentage
* Minimum score
* Minimum distance between unrelated highlights
* Preference for one phrase over several weak single words

A sentence with no genuinely useful candidate may have zero highlights.

Do not force artificial highlights just to achieve visual consistency.

The plan should include a calibration method using representative TED-Ed or YouTube transcripts and learners at different levels.

---

# 12. Server-side caching and persistence

Inspect and reuse the existing server-side highlight cache if possible.

The cache identity must include enough information to prevent stale results:

```text
transcriptId
transcriptTextHash
algorithmVersion
datasetVersions
userLevel or difficultyProfile
```

Suggested metadata:

```ts
type HighlightGenerationMetadata = {
  status: "complete" | "empty" | "failed";
  algorithmVersion: string;
  transcriptTextHash: string;
  learningLevel: LearningLevel;
  datasetVersions: {
    winkModel: string;
    efllex: string;
    subtlex: string;
    openEnglishWordNet: string;
    azureModel?: string;
  };
  generatedAt: string;
  azureUsed: boolean;
  candidateCounts: Record<string, number>;
};
```

Adapt this to the current schema and avoid unnecessary duplication.

Important behavior:

* `complete`: valid highlights exist and can be cached indefinitely until inputs or versions change.
* `empty`: pipeline completed successfully but found no useful highlights.
* `failed`: generation failed and must not be cached as a permanent empty result.
* A timeout, Gemini error from legacy code, Azure error, parsing error, or database failure must not silently become `[]`.
* Azure failure may still produce `complete` if local processing completed successfully.
* Reprocessing must be triggered when transcript text, user level, algorithm version, or dataset version changes.

Follow existing Supabase:

* Migration conventions
* RLS conventions
* Server client conventions
* Service-role restrictions
* Naming conventions

Do not expose service-role credentials to the browser.

---

# 13. Client query behavior

Inspect the current React Query behavior.

`staleTime: Infinity` may remain only when the response is a valid, version-matched `complete` or `empty` result.

For `failed`:

* Show a concise error.
* Allow retry.
* Do not keep the result indefinitely.
* Do not render failure as “no difficult words found.”

Avoid duplicate requests caused by rerenders, tab switches, or sentence changes.

The practice page should remain usable while highlights are being generated. Define whether it should:

* Show the transcript without highlights temporarily.
* Use previously cached valid highlights while refreshing.
* Display a subtle loading state.

Do not block video playback on Azure Key Phrase Extraction.

---

# 14. Independent regeneration

Add or plan a separate action:

```text
Regenerate vocabulary highlights
```

It must not call or reuse `Regenerate Translation`.

Expected flow:

```text
User requests highlight regeneration
→ POST to vocab-highlight endpoint with force: true
→ server recomputes using current algorithm and datasets
→ valid result replaces old cache atomically
→ client invalidates ["dictation-vocab-highlights", transcriptId]
→ Script panel updates without reloading the whole page
```

Requirements:

* Regeneration should preserve the previous valid result until the new result succeeds.
* A failed regeneration must not erase the previous valid highlights.
* Prevent accidental repeated clicks and concurrent duplicate work.
* The UI action may live in Settings or an existing appropriate menu.
* Do not add unnecessary controls to the one-row playback control bar.
* Regenerate Translation must not invalidate vocabulary highlights unless transcript text actually changes.

---

# 15. Legacy Gemini removal scope

Remove Gemini usage only from:

```text
/api/transcript/vocab-highlights
and directly related highlight-generation utilities
```

Do not remove Gemini from transcript translation.

After migration, verify:

* No Gemini call can occur in the vocabulary-highlight path.
* No legacy Gemini prompt remains active for highlights.
* Transcript translation behavior remains unchanged.
* Existing Gemini environment variables are not removed if another system still uses them.
* Legacy cached highlight rows remain readable or are safely invalidated through versioning.

---

# 16. Dataset acquisition and build tooling

The plan must specify how each dataset is acquired and updated.

Do not make production request handlers download datasets from public websites.

Evaluate and recommend:

* A build-time preprocessing script
* Checked-in compact generated server assets
* A versioned Supabase seed/import process
* Dataset integrity checks and hashes
* Reproducible generation commands
* Third-party notices and attribution
* How dataset updates change `algorithmVersion` or `datasetVersions`

Do not commit unnecessarily large raw datasets if a smaller derived server-only index is sufficient and licence-compliant.

For Open English WordNet, strongly consider extracting only multi-word lemmas and minimal POS metadata.

For EFLLex, preserve the information required to reproduce the difficulty calculation and comply with ShareAlike requirements.

For SUBTLEX, confirm whether the installed package is sufficiently small and efficient before introducing another preprocessing step.

The plan must estimate:

* Raw dataset size
* Derived index size
* Vercel bundle impact
* Cold-start impact
* Expected per-transcript processing time
* Supabase storage impact, if applicable

If exact measurements require implementation, specify a measurement task rather than inventing numbers.

---

# 17. Observability and debugging

Add enough metadata to understand why a highlight was selected without exposing this complexity in the normal UI.

For development/debugging, it should be possible to inspect:

```ts
{
  text: "greenhouse gas emissions",
  source: "azure_key_phrase",
  kind: "topic_phrase",
  score: 68,
  reasons: [
    "azure-topic-phrase",
    "multiword-bonus",
    "not-covered-by-local-phrase-index"
  ]
}
```

Production logs should include aggregated information only:

* Transcript ID
* Algorithm version
* Processing duration
* Candidate count per source
* Final highlight count
* Azure called or skipped
* Cache hit or miss
* Failure code

Do not log:

* Azure keys
* Authorization headers
* Full user recordings
* Sensitive user information
* Entire transcripts unless existing privacy policy explicitly permits it

---

# 18. Testing requirements

The plan must include automated tests for at least:

## winkNLP

1. Tokenization preserves usable original offsets.
2. Lemmatization handles common inflections.
3. Punctuation is excluded from highlight ranges.
4. Sentence-initial capitalization is not automatically treated as a proper noun.
5. Named entities are filtered correctly.
6. Contractions, apostrophes, hyphens, quotes, and em dashes are safe.

## EFLLex

7. Known lemmas resolve correctly.
8. POS is used when the same lemma has different entries.
9. Relative difficulty changes according to learner level.
10. CEFR-distribution-to-difficulty mapping is deterministic.
11. Multi-word entries can be matched.

## SUBTLEX

12. Common words are deprioritized.
13. Rare words receive an appropriate fallback score.
14. Unknown tokens are not automatically highlighted.
15. Proper nouns and transcript errors are rejected.

## Open English WordNet

16. Phrasal verbs and multi-word expressions are detected.
17. Longest-match behavior works.
18. Contained word highlights are removed.
19. The derived index loads efficiently.

## Azure Key Phrase Extraction

20. Azure is skipped when local phrase coverage is sufficient.
21. Azure is called only when the configured enrichment trigger is met.
22. Documents are chunked within Azure limits.
23. Returned phrases map back to exact transcript spans.
24. Invalid and hallucinated/nonexistent phrases are discarded.
25. Azure timeout, 401/403, 429, quota exhaustion, and 5xx do not destroy local results.
26. Azure results never receive fake CEFR data.

## Cache and API

27. Valid cache hits skip all recomputation.
28. Transcript text changes invalidate old results.
29. Learning-level changes invalidate or select the correct cache entry.
30. Algorithm or dataset-version changes invalidate old results.
31. Failed generation is not cached as an empty success.
32. Concurrent identical requests avoid duplicate work where reasonably possible.
33. Force regeneration preserves the old result until success.
34. A failed regeneration preserves previous highlights.
35. No Gemini code is called by the highlight path.
36. Transcript translation remains unchanged.

## Rendering

37. No highlight includes `.`, `,`, `!`, `?`, quotation marks, or other surrounding punctuation.
38. Highlights do not overlap.
39. Repeated phrases map correctly.
40. Script selection and text highlighting remain possible.
41. Highlight rendering does not trigger video jumps when the user is selecting text.
42. Desktop and mobile Script panels render safely.

Use mocks for Azure tests. Automated tests must never consume the real Azure F0 quota.

---

# 19. Rollout strategy

Propose a safe rollout in stages:

1. Add dataset acquisition and licence documentation.
2. Add winkNLP analysis and normalized token spans.
3. Add EFLLex word and multi-word difficulty.
4. Add SUBTLEX fallback scoring.
5. Add Open English WordNet phrase index.
6. Add deterministic scoring and overlap resolution.
7. Add versioned cache and status handling.
8. Add Azure enrichment behind a feature flag.
9. Compare new output against representative existing Gemini results.
10. Enable Azure enrichment only after measuring whether it materially improves phrase coverage.
11. Remove Gemini from the highlight path.
12. Add independent regeneration.
13. Complete responsive and regression verification.

The plan should consider temporarily storing both old and new outputs for comparison without showing duplicate highlights to users.

Define measurable rollout criteria such as:

* Percentage of segments receiving at least one useful highlight
* Average highlights per sentence
* Phrase-versus-word ratio
* Invalid range count
* Overlap count
* Azure call rate
* Azure incremental accepted-phrase rate
* Cache hit rate
* Generation latency
* Manual rejection rate, if feedback exists

Do not optimize for highlighting every sentence.

---

# 20. Required output

Return a detailed implementation plan containing:

1. Current-state findings from the repository
2. Existing problems and root causes
3. Proposed architecture
4. Data flow
5. Actual files and symbols that need changes
6. New files or modules required
7. Dataset acquisition and preprocessing strategy
8. Licence and attribution plan
9. Types and data contracts
10. Candidate-scoring design
11. Overlap-resolution design
12. Azure enrichment trigger and batching design
13. Cache/schema changes and migrations
14. Regeneration behavior
15. Error and partial-success behavior
16. Client integration
17. Performance and Vercel considerations
18. Privacy and security considerations
19. Test plan
20. Rollout and rollback strategy
21. Acceptance criteria
22. Manual setup required in Azure Portal
23. Environment variables required
24. Open product decisions

For each plan phase, include:

* Goal
* Files/components affected
* Exact implementation tasks
* Dependencies
* Risks
* Verification steps
* Completion criteria

Do not implement code yet.

Do not ask questions that can be answered by inspecting the repository. Only list genuine product decisions or licence decisions that require my approval.
