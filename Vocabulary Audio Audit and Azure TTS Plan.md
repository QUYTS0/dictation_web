# Vocabulary Canonical-Form / Pronunciation Audit and Azure TTS Integration Plan

Status: **implemented, then post-implementation-audited and corrected (2026-09-11).** The original plan below (§1-§15) was fully implemented in an earlier pass: prerequisite fixes, migration 018, `azureTts.ts`, `vocabularyAudioCache.ts`, `POST /api/vocabulary/pronounce`, the extended `PronunciationButton`, and the accompanying test suite. A second, focused audit pass then reviewed the *implemented code* (not this document) against the original design intent, found and fixed several confirmed defects, and added regression coverage for each. See "Post-implementation audit addendum" at the end of this document for what changed, why, and what remains unverified/deferred. Treat the numbered sections below as the original design record — where the addendum says a section's behavior was corrected, the addendum is authoritative, not the prose below it.

Repo state originally audited: working tree on `main`, including the uncommitted changes to `VocabularyDetailDialog.tsx`, `useLessonCapture.ts`, `src/lib/types/index.ts`, `src/app/api/vocabulary/route.ts`, and the new `supabase/migrations/017_vocabulary_audio.sql`.

---

## 1. Executive recommendation

The vocabulary-highlight pipeline's `canonical_form` mechanism is **more conservative than the audit brief assumed**: `canonicalForm` is only ever set for multi-word matches (phrasal verbs / idioms / MWEs, from a curated construction list or lemma-matched WordNet/EFLLex/supplementary lexicon entries) — never for a single inflected word. Single-word dictionary lookup (`lookupWordDetails`) always runs on the literal saved `term`, never on a lemma. **The "heading=jump, source=jumped" failure mode described in the brief does not currently occur through the automated pipeline.**

What *is* a confirmed, evidence-backed defect, and directly relevant to TTS:

1. **`src/lib/dictionary.ts` picks a word's `phonetic` text and its `audioUrl` independently** from the same `phonetics[]` array (two separate `.find()` calls). dictionaryapi.dev commonly returns several `phonetics[]` entries (different regional variants, some with only `text`, some with only `audio`). Nothing guarantees the chosen text and the chosen audio come from the *same* entry — a real, silent dialect-mismatch risk between what's displayed and what plays. **Fix before shipping TTS**, since TTS's job is to fill gaps left by this exact lookup and must not inherit its bug.
2. **Editing a saved item's `term` never invalidates `canonical_form`, `learning_pattern`, `audio_url`, or dictionary metadata** (`PATCH /api/vocabulary`, and both callers of it). A user can rename "run" to something unrelated and keep the old audio/canonical form permanently attached. **Fix before shipping TTS**, or generated/cached audio will silently attach to the wrong text after an edit.
3. **The standalone Vocabulary Bank page (`src/app/vocabulary/page.tsx`) has a pronunciation button with no `onClick` handler at all** — a pre-existing, unrelated dead control. Worth fixing in the same pass since TTS work touches this exact surface.

Recommendation: land the three prerequisite fixes in §4 first (small, isolated), then implement Azure TTS as an **on-demand, server-resolved, content-addressed cache** layered behind the existing single pronunciation button — reusing the already-provisioned `AZURE_SPEECH_KEY`/`AZURE_SPEECH_REGION` resource (pending a tier check), a new `vocabulary_audio_assets` table modeled directly on the existing `vocabulary_translation_cache` table, and Supabase Storage for the generated MP3s. Smallest complete first release: one new API route, one new table, one modified column-nulling rule in `PATCH`, one dictionary.ts fix, and a `PronunciationButton` that also handles phrases.

---

## 2. Repository findings (exact paths)

| Area | File | What it does |
|---|---|---|
| Highlight candidate generation (word-level, **no `canonicalForm`**) | `src/lib/vocabHighlights/candidates.ts:246-290` (`generateWordCandidates`) | Every single-word candidate — the only path that feeds `lookupWordDetails` later — never sets `canonicalForm`. |
| Highlight candidate generation (MWE, **sets `canonicalForm` = matched lemma phrase**) | `src/lib/vocabHighlights/candidates.ts:108-169` (`generateMultiwordCandidates`) | Sets `canonicalForm` to the joined-lemma phrase for any WordNet/EFLLex/supplementary multiword match. |
| Construction expansion (curated, **verified** list) | `src/lib/vocabHighlights/constructions.ts:44-75, 154-190` | A small, hand-curated table of verb/adjective-complement and idiom patterns; `canonicalForm` is a literal from this table, not inferred. |
| Public projection to client/DB | `src/lib/vocabHighlights/pipeline.ts:225-232`, `src/lib/vocabHighlights/types.ts:74-84` | `canonicalForm`/`learningPattern` only survive into `PublicHighlightPhrase` when the candidate set one. |
| Persisted canonical metadata columns | `supabase/migrations/016_vocabulary_canonical_metadata.sql` | Additive, nullable, write-time only (never backfilled, never read-path-generated). |
| Save-time mapping (preview → save) | `src/app/dictation/[videoId]/useLessonCapture.ts:894-930` (`handleScriptPopoverAction`) | Attaches `canonicalForm`/`learningPattern` to the save request **only when** the saved text exactly equals the matched selection (`previewMatchesSave`) — correctly excludes "Save sentence". |
| Save route persistence | `src/app/api/vocabulary/route.ts:108-110, 154-223` | Insert: omitted `canonicalForm`/`learningPattern` → `null`. Update (existing row): **preserve-on-omit** — only overwrites when the field is present in the request body. |
| Dictionary lookup | `src/lib/dictionary.ts:42-82` (`lookupWordDetails`) | Runs on the literal saved `term.trim().toLowerCase()`; refuses any input containing whitespace (phrases never reach it). **Bug**: `phoneticEntry` and `audioEntry` (lines 64-65) are chosen by two independent `.find()` calls over the same `phonetics[]` array. |
| Save-time dictionary/audio persistence | `src/app/api/vocabulary/route.ts:134-142, 180-184` | Reuses the popover's precomputed `wordDetails`/`audioUrl` when present (gated on `precomputedDefinition`), else calls `lookupWordDetails` fresh — never blocks the save on failure. |
| Audio column | `supabase/migrations/017_vocabulary_audio.sql` | Additive, nullable, write-time only; documented as "single words only... never generated by this migration or by any read path." |
| Detail-dialog heading resolution | `src/app/dictation/[videoId]/components/VocabularyDetailDialog.tsx:339-345` | `dialogTitle = canonicalFormDiffersFromSurface(highlightMeta.canonicalForm, term) ? highlightMeta.canonicalForm : term`. |
| Heading source of truth (persisted-wins) | `src/app/dictation/[videoId]/helpers.ts:345-359` (`resolveVocabularyHighlightMeta`) | Prefers `item.canonical_form`/`item.learning_pattern` (DB columns); falls back **per field independently** to the *currently loaded* highlight cache only when the DB column is null (legacy rows). |
| Pronunciation button (working) | `VocabularyDetailDialog.tsx:136-213` (`PronunciationButton`) | Only rendered when `displayItem.audio_url` exists; keyed by item id so switching items always tears down the previous `<audio>`; never autoplays; `play()` only inside the click handler. |
| Pronunciation button (**dead**) | `src/app/vocabulary/page.tsx:264-271` | `<button aria-label="Play pronunciation...">` with **no `onClick`**, rendered unconditionally regardless of `audio_url`, and never checks `item.audio_url` at all. |
| Term-edit does not invalidate metadata | `src/app/api/vocabulary/route.ts:276-373` (`PATCH`) | `payload` explicitly lists `term, normalized_term, sentence_context, note, translation, phonetic, part_of_speech, definition` — `canonical_form`, `learning_pattern`, `audio_url`, `definition_source` are simply never touched, at any edit, from either caller. |
| PATCH callers | `useLessonCapture.ts:469-537` (`updateLessonCapture`), `src/app/vocabulary/page.tsx:94-126` (`handleUpdate`) | Both send the same fixed field set; neither ever sends `canonicalForm`/`audioUrl`, so the route's `preserve-on-omit` update path always keeps the old values regardless of what else changed. |
| Existing Azure resource for pronunciation assessment | `src/lib/azureSpeech.ts`, `.env.local.example:29-42` | `AZURE_SPEECH_KEY`/`AZURE_SPEECH_REGION`, documented (not verified) as F0 tier, used today for `/recognition/conversation` (STT + pronunciation assessment). Same resource type as TTS. |
| Existing Azure quota-tracking precedent | `src/lib/practiceQuota.ts`, `src/lib/rateLimit.ts:128-171` (`checkAzureKeyPhraseQuota`) | Upstash-Redis fixed-window monthly counters, fail-open when Redis isn't configured — the pattern to reuse for a TTS character budget. |
| Existing shared content-addressed cache precedent | `supabase/migrations/014_vocabulary_translation_cache.sql`, `src/lib/translationCache.ts` | Public-read / service-role-write RLS, unique constraint on the normalized identity, `upsert(..., { onConflict })` for cache writes — the exact pattern to reuse for audio assets. |
| No Supabase Storage usage anywhere yet | (repo-wide grep) | Images (`src/lib/image.ts`) are Openverse external URLs, never mirrored into storage. TTS audio caching is a genuinely new storage integration point. |
| Conservative legacy-repair precedent | `scripts/repair-info-icon-vocab.mjs` | Dry-run-by-default, evidence-gated (exact glyph match), never auto-merges, reports collisions instead of guessing — the house style for any legacy-data cleanup. |

---

## 3. Canonical / audio audit table

| Finding | Evidence | User impact | Recommended correction | Priority |
|---|---|---|---|---|
| Single-word candidates never carry `canonicalForm` — the pipeline cannot lemmatize a plain inflected word (e.g. "jumped" → "jump") | `candidates.ts:246-290` vs. `:108-169` | None today — the "jump/jumped" mismatch scenario in the brief cannot occur via the automated highlight path. Confirmed correct, not a gap to close. | No action needed; document as an explicit design boundary so it isn't "fixed" into existence later without a plan for word-level lemma verification. | Informational |
| `phoneticEntry`/`audioEntry` selected independently from `entry.phonetics[]` | `dictionary.ts:64-65` | A saved word can display IPA from one regional variant while its audio plays a different one, with no visible indication. No existing test catches this (`src/__tests__` has no `dictionary.test.ts`). | Prefer a single `phonetics[]` element that has **both** `text` and `audio`; only fall back to independent selection (and only then) when no single element has both, and mark such rows so the UI can note the pairing is best-effort. | **High — prerequisite** |
| `PATCH` never invalidates `canonical_form`/`learning_pattern`/`audio_url` when `term` changes | `route.ts:320-350` (payload never includes those keys); both PATCH callers (`useLessonCapture.ts:488-500`, `vocabulary/page.tsx:99-111`) never send them | Editing the saved text can leave a stale canonical form and/or stale audio permanently attached to unrelated text — looks authoritative, is wrong. | On `PATCH`, if the (normalized) `term` actually changes, null out `canonical_form`, `learning_pattern`, `audio_url`, `phonetic`, `part_of_speech`, `definition`, `definition_source` (and the new `pronunciation_audio_asset_id`, once it exists) server-side, forcing a fresh lookup next time. Leave them untouched when only note/translation/etc. change (current behavior). | **High — prerequisite** |
| Vocabulary Bank page's pronunciation button is inert | `vocabulary/page.tsx:264-271` | Users on `/vocabulary` see a speaker icon that does nothing; a pre-existing, unrelated bug this audit surfaced while tracing every pronunciation-button call site. | Wire it to the same audio-resolution logic as the dictation-page dialog (§7); gate rendering on there being a playable source. | Medium — bundle with TTS work since it touches the same code path |
| `resolveVocabularyHighlightMeta` correctly prefers persisted DB columns over the live highlight cache, per field | `helpers.ts:345-359`, covered by `vocabularyHelpers.test.ts:107-159` | Heading stays stable across sessions/highlight-pipeline versions once persisted; legacy rows still get a best-effort fallback. Confirmed correct. | None. | — |
| `canonicalFormDiffersFromSurface` is the single, consistently-reused "verified enough to show" gate | `src/lib/utils/vocabulary.ts:14-20`; call sites in `VocabularyDetailDialog.tsx:339`, `vocabulary/page.tsx:351`, `LessonSavedItemsList.tsx:175` | Consistent heading behavior across all three vocabulary surfaces. Confirmed correct. | None. | — |
| `canonicalForm`/`learningPattern` only attach to a save when the saved text exactly matches the popover selection | `useLessonCapture.ts:911-927` | "Save sentence" never inherits a word/phrase's canonical metadata. Confirmed correct. | None. | — |
| `PronunciationButton` correctly tears down audio on item switch/dialog close and never autoplays | `VocabularyDetailDialog.tsx:136-213` | No stale playback across items; satisfies iOS's synchronous-gesture requirement already. Confirmed correct — the pattern to extend, not replace, for TTS. | None. | — |
| Phrases never get dictionary audio (by construction) | `dictionary.ts:44` (`/\s/.test` rejects any phrase) | No phonetic/audio mismatch risk for phrases today, but also *no* pronunciation control for phrases at all — the actual gap TTS should close. | TTS should target exactly this population (§6). | Feeds directly into TTS scope |
| Heteronym sense ambiguity (e.g. "record", "read") is unresolved by current dictionary data | `dictionary.ts:56-57` (`entries[0]` only, never sense-disambiguated by sentence context) | A word whose pronunciation depends on meaning/POS may show the wrong sense's IPA/audio; dictionaryapi.dev sometimes exposes multiple `entries[]` for this but nothing in the pipeline consults sentence context to pick between them. | **Cannot be resolved from existing data.** Do not have TTS silently "fix" this by speaking the term without regard to sense — document as a known, unresolved limitation; at most, TTS gives the user *a* correct reading of the string, not necessarily *the* contextually correct one. | Uncertain / deferred |
| Legacy rows with `audio_url` set but no `canonical_form`/no save-time provenance | (schema: both columns nullable, no backfill, per `016`/`017` comments) | Cannot distinguish "verified at save time" from "whatever the dictionary happened to return" purely from present data — there was never a confidence field. | Treat presence of `audio_url` alone as "usable, not verified" — good enough to keep serving (never delete), but not a signal to skip a future fix pass. No blanket regeneration. | Legacy policy, §14 |

---

## 4. Required prerequisite corrections (before Azure TTS ships)

These are small, independent of Azure, and should land first so TTS doesn't inherit or compound them:

1. **`src/lib/dictionary.ts`** — pair `phonetic`/`audioUrl` from the same `phonetics[]` element when possible (prefer an element with both; only fall back to independent selection when no single element has both).
2. **`PATCH /api/vocabulary`** — null out term-derived metadata (`canonical_form`, `learning_pattern`, `audio_url`, `phonetic`, `part_of_speech`, `definition`, `definition_source`, and the new `pronunciation_audio_asset_id`) whenever the normalized `term` actually changes; leave untouched otherwise (current behavior for non-term edits is correct and should be preserved).
3. **`src/app/vocabulary/page.tsx`** — give the pronunciation button a real handler and gate its rendering on a resolvable audio source, matching the dictation-page dialog's behavior.

None of these require a migration; (1) and (3) are pure logic/UI fixes, (2) is a route-payload change.

---

## 5. Audio selection decision table

| Situation | Source used | Azure called? |
|---|---|---|
| Word, `audio_url` present (dictionary) | Existing `audio_url` (after prerequisite fix #1) | No |
| Word, `audio_url` null (dictionary had no audio) | Azure TTS, on demand | Yes, on first tap only |
| Phrase (any) | Azure TTS, on demand (dictionary never applies) | Yes, on first tap only |
| Any item, `pronunciation_audio_asset_id` already resolved | Cached Azure asset (Supabase Storage public URL) | No |
| Confirmed stale/mismatched audio (post-edit, per fix #2) | Nulled by the edit → falls into "no audio" case above | Yes, on next tap |
| Unknown legacy provenance (`audio_url` set, no way to verify) | Served as-is; never auto-regenerated | No, unless the user hits a real playback error |
| Permanent playback error (e.g. 404 on a dead dictionary URL) | Button shows a "Couldn't play" state (already implemented) with a manual retry | Retry re-attempts the *same* source first; only synthesizes if the item is otherwise Azure-eligible (word had no audio to begin with is not this case — this is "had audio, it broke") — see §10 |
| Temporary network failure / offline | Same "Couldn't play"/retry UI; **no automatic fallback to synthesis** | No — never silently spend Azure quota because playback failed once |
| Browser autoplay restriction | Never triggers synthesis by itself — synthesis is already gated on a user tap, so this case is really "tap succeeded, `play()` was blocked" | No |

One pronunciation button throughout, no separate "regenerate" control in this release — the retry affordance already built into `PronunciationButton`'s error state (§ VocabularyDetailDialog.tsx:206-210) is reused as-is.

---

## 6. Proposed data model and migrations

Smallest additive change: **one new table**, modeled directly on `vocabulary_translation_cache` (§2), plus **one new nullable FK column** on `vocabulary_items`. The existing `audio_url` column is left exactly as-is (dictionary pass-through, unchanged meaning).

```sql
-- 018_vocabulary_audio_assets.sql (illustrative — not applied)

create table if not exists vocabulary_audio_assets (
  id                uuid primary key default gen_random_uuid(),
  provider          text not null default 'azure_tts' check (provider in ('azure_tts')),
  -- The exact text actually sent to synthesis (the verified displayed
  -- term/phrase) — never lowercased or otherwise reshaped beyond trim +
  -- internal-whitespace collapse + Unicode NFC, so case/punctuation that
  -- changes pronunciation is never silently merged with a different input.
  text              text not null,
  normalized_text   text not null,
  voice             text not null,          -- e.g. 'en-US-JennyNeural'
  locale            text not null,          -- e.g. 'en-US'
  output_format     text not null,          -- e.g. 'audio-24khz-48kbitrate-mono-mp3'
  synthesis_version text not null,          -- app-defined; bump to force regeneration
  storage_path      text not null,          -- Supabase Storage object path
  char_count        integer not null,       -- for accounting/debug, not billing truth
  created_at        timestamptz not null default now(),
  last_used_at      timestamptz not null default now(),
  unique (voice, locale, output_format, synthesis_version, normalized_text)
);

alter table vocabulary_audio_assets enable row level security;
create policy "vocabulary_audio_assets_public_read"
  on vocabulary_audio_assets for select using (true);
create policy "vocabulary_audio_assets_service_manage"
  on vocabulary_audio_assets for all using (auth.role() = 'service_role');

alter table vocabulary_items
  add column pronunciation_audio_asset_id uuid null
    references vocabulary_audio_assets(id) on delete set null;
```

Why this shape:

- **Public-read / service-role-write RLS**, identical to `vocabulary_translation_cache` — the audio itself is non-sensitive, shared, content-addressed data (same pronunciation of "curb extension" is correct for every user), so there's no reason to scope it per-user, and doing so would prevent the sharing/dedup the brief explicitly asks for ("multiple cards can reuse audio without generating duplicate files").
- **`audio_url` (dictionary) and `pronunciation_audio_asset_id` (Azure) stay distinct columns** rather than unifying into one unified "audio source" table. This keeps the migration additive and trivial, and the distinction ("dictionary vs. generated") the brief asks for is already structurally explicit — one is a raw external URL, the other is a foreign key into a table with `provider`/`voice`/`synthesis_version`. Unifying them into one polymorphic table is possible later but isn't needed for this first release (avoids "unnecessary infrastructure").
- **`synthesis_version`** lets a future SSML/voice-settings change force fresh synthesis without touching old rows (bump the app constant; new lookups simply miss the old rows' unique key and synthesize again under the new version).
- **No binary audio in the DB** — only `storage_path`; the actual bytes live in Supabase Storage (§7).
- **Future flashcards** reference audio through `vocabulary_items.pronunciation_audio_asset_id` (or, once a flashcard table exists, its own copy of the same `asset_id`) — never a fresh URL per card, so the same underlying MP3 is reused everywhere the same normalized text/voice/version is needed. Building the flashcard system itself is out of scope here.

---

## 7. API contracts and storage flow

### New route: `POST /api/vocabulary/pronounce`

Request: `{ itemId: string }` — **never raw text**. The server resolves what to speak from the owned row, never from client input, closing off arbitrary-TTS abuse by construction.

Response (200): `{ audioUrl: string, source: "dictionary" | "cached" | "synthesized" }`
Response (4xx/5xx): `{ error: string, code: "TTS_NOT_CONFIGURED" | "TTS_RATE_LIMITED" | "TTS_QUOTA_EXCEEDED" | "TTS_UPSTREAM_ERROR" | "TTS_STORAGE_ERROR" | "NOT_FOUND" }`

Server logic:

1. Auth via the existing anon-key `createClient()` + `auth.getUser()`; look up the item scoped to `user_id = user.id` (same ownership pattern as `DELETE`/`PATCH`). Not found/not owned → 404.
2. Resolve `textToSpeak = (item.canonical_form ?? item.term).trim()`, capped at the existing `MAX_METADATA_FIELD_LENGTH` (200 chars) — deliberately **not** re-deriving from the live highlight cache server-side (that fallback exists only for the client's currently-loaded-video convenience; the persisted columns are the server's source of truth, and are simpler and equally correct per §2's confirmed-correct finding).
3. If `item.audio_url` is set and the item is a single word (no whitespace in `term`) → return it immediately, `source: "dictionary"`. No Azure call, no DB write.
4. Else if `item.pronunciation_audio_asset_id` is set → resolve its `storage_path` to a public URL, touch `last_used_at`, return it, `source: "cached"`.
5. Else compute the cache key `{ voice: DEFAULT_VOICE, locale: "en-US", output_format: DEFAULT_FORMAT, synthesis_version: CURRENT_VERSION, normalized_text: normalize(textToSpeak) }` and look it up in `vocabulary_audio_assets`.
   - Hit → best-effort `UPDATE vocabulary_items SET pronunciation_audio_asset_id = ...` (so the next request skips straight to step 4), return, `source: "cached"`.
   - Miss → check quota/rate limit (§9). Not allowed → 429 with the appropriate `code`, nothing written.
     Allowed → build SSML server-side (escaped, single `<voice>`), call Azure, validate the response, upload to Storage, `upsert` the asset row (`onConflict` on the unique key, exactly like `translationCache.ts`), best-effort link it to the item, return, `source: "synthesized"`.

### Storage flow

- Bucket: `vocabulary-audio` (new), **public** bucket — matches the "preserve the asset independently of temporary signed URLs" requirement directly: a public bucket's URL never expires, so no signed-URL refresh logic is needed anywhere (dialog, future flashcards, or otherwise).
- Object path: content-addressed, e.g. `azure/{sha256(voice|locale|output_format|synthesis_version|normalized_text)}.mp3` — deterministic, so a retried upload after a partial failure overwrites the same key rather than accumulating orphans.
- Upload only after Azure returns a validated (200, `audio/*`-ish content, non-trivial byte length) response, and only from the service-role client (never client-side).
- **Success but storage fails**: return `TTS_STORAGE_ERROR` to the client; do **not** write a `vocabulary_audio_assets` row (nothing is cached). The next tap retries synthesis from scratch. This wastes at most one Azure transaction per failure — acceptable and consistent with this codebase's existing best-effort caching philosophy (`translationCache.ts`'s doc comment: "a cache read/write failure... must never break [the feature] itself").
- **Client disconnects mid-request**: the route's own `await` chain (Azure call → upload → DB upsert) is not tied to the inbound HTTP connection; depending on the hosting platform, the handler may continue running to completion after the client aborts. If it does, the asset still gets cached — a pure win, since the *next* tap (by the same or another user) hits the warm cache. If the platform kills the handler immediately, nothing is cached and the next tap resynthesizes. Either way, no special handling is required — the content-addressed, upsert-based cache degrades gracefully in both cases.

### Concurrency (serverless — no in-memory map)

Two concurrent identical requests (same item, or two different items resolving to the same normalized text/voice) both miss the cache, both call Azure, and both attempt to `upsert(..., { onConflict: "voice,locale,output_format,synthesis_version,normalized_text" })`. The unique constraint makes the second write converge onto the first row's `storage_path` (last-writer-wins on the non-key columns, harmless since both wrote the same bytes to the same deterministic path) rather than creating a duplicate. This costs at most one extra Azure transaction under a race — the same tolerance this codebase already accepts for Gemini/Azure Key Phrase quota checks (`checkGeminiQuota`'s doc comment: "not perfectly atomic against concurrent requests... acceptable at personal-app traffic"). No Redis lock, no queue — matches "pragmatic implementation... not unnecessary infrastructure."

---

## 8. Azure configuration and official references

Verified against current Microsoft Learn documentation (fetched during this audit, links below):

- **F0 (free) tier TTS allowance: 0.5 million characters/month for neural voices**, tracked as a pool **separate** from the F0 STT allowance (5 audio-hours/month) — both live on the same resource type but meter independently. [Speech pricing](https://azure.microsoft.com/en-us/pricing/details/cognitive-services/speech-services/)
- **F0 rate limit for real-time TTS: 20 transactions per 60 seconds, not adjustable.** This is a resource-wide ceiling, not per-user — the app-level Upstash rate guard (§9) must be conservative enough to leave headroom rather than exactly matching Azure's limit. [Quotas and limits](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-services-quotas-and-limits)
- **REST endpoint**: `https://{region}.tts.speech.microsoft.com/cognitiveservices/v1`, `POST`, `Content-Type: application/ssml+xml`, `X-Microsoft-OutputFormat`, `User-Agent` (required, <255 chars), and either `Ocp-Apim-Subscription-Key` or a Bearer token — the existing `azureSpeech.ts` already uses `Ocp-Apim-Subscription-Key` directly for STT with the same key/region, so TTS should do the same (no token-exchange flow needed). [REST API reference](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech)
- **Output formats**: recommend `audio-24khz-48kbitrate-mono-mp3` (good quality/size balance, universally playable via `<audio>` including iOS Safari). MP3 avoids WAV's larger storage footprint for a cache meant to be reused indefinitely. [Audio outputs](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech#audio-outputs)
- **Voice recommendation**: `en-US-JennyNeural` — GA status, standard (non-HD, non-custom, non-personal) neural voice, confirmed present in Azure's own `/tts/cognitiveservices/voices/list` sample response. Exactly one voice, hardcoded server-side, never client-selectable.
- **Whether the existing `AZURE_SPEECH_KEY`/`AZURE_SPEECH_REGION` resource can be reused for TTS**: **architecturally yes** — F0 Speech resources meter STT and TTS as separate pools on the same resource, and the REST TTS endpoint is available in effectively every major region (the fetched region table includes East US, West US, etc.). **But do not assume the deployed resource is actually still on F0** — `.env.local.example`'s comment documents *intent*, not current Azure Portal state, and the task brief explicitly warns against this assumption. **Action required before implementation**: check the resource's pricing tier in the Azure Portal (Overview → Pricing tier) and confirm the configured `AZURE_SPEECH_REGION` is in the TTS-supported region list. If the tier turns out to be S0, the 20/60s F0 rate ceiling doesn't apply, but the app-level Upstash guard should stay in place regardless (defense against runaway usage/cost either way).
- **SSML vs. plain text**: standard (non-custom) voices require the request body to be SSML (`Content-Type: application/ssml+xml`); plain text is only accepted for custom voices, which this plan explicitly does not use. The server therefore always constructs a minimal SSML envelope itself (§9) — never a pass-through of client-supplied markup.

---

## 9. Cache, concurrency, and failure behavior

Already covered in detail in §7. Summary of the guardrails:

- **Auth + ownership**: item must belong to the requesting user (matches `DELETE`/`PATCH`).
- **Input**: request carries only `itemId`; text-to-speak is server-derived and length-capped (200 chars).
- **Voice/settings**: exactly one hardcoded voice/locale/format/version; no client control over any Azure parameter.
- **SSML**: server-built only, from escaped plain text — `<speak version='1.0' xml:lang='en-US'><voice name='en-US-JennyNeural'>{escaped text}</voice></speak>`. No client SSML accepted, no remote-URL fetching on the server's behalf.
- **Timeouts**: ~10s `AbortSignal.timeout` on the Azure call (TTS responses are typically sub-second for short phrases; 10s is generous headroom, in the same order of magnitude as `azureSpeech.ts`'s 15s STT budget).
- **Retries**: none automatic on the server for a 4xx (config/programming errors, or Azure's 429) — surfaced to the client as a typed error; the client's existing manual-retry affordance re-invokes the route, which re-checks quota/cache from scratch. One retry only for a bare network-level failure (not a real Azure HTTP response), matching `azureSpeech.ts`'s general philosophy of "clear, actionable failure" over silent retries.
- **Quota accounting**: a new `checkAzureTtsQuota(charCount, monthlyBudget)` in `rateLimit.ts`, structurally identical to `checkAzureKeyPhraseQuota` — Upstash fixed-window monthly counter, conservative internal budget (e.g. default 400,000 of the 500,000 free characters, leaving headroom), fails open (unenforced) if Redis isn't configured, exactly like every other quota in this codebase.
- **Rate accounting**: a second Upstash window, e.g. 15 requests/60s (under Azure's unadjustable 20/60s ceiling), shared across the whole app the same way `GEMINI_RPM_LIMIT` is — not per-IP, since Azure's limit is resource-wide.
- **Invalid/failed responses never become cache entries**: a non-200, wrong content-type, or implausibly short body is rejected before any Storage write or DB upsert — nothing partial or wrong is ever cached (§7).
- **Quota unavailable**: existing dictionary audio and any already-cached Azure asset keep working (they never reach the quota check — see §5's decision table). New synthesis fails with `TTS_QUOTA_EXCEEDED`/`TTS_RATE_LIMITED`. **Never falls back to Gemini or any other provider.**

---

## 10. Mobile playback states (extends the existing `PronunciationButton`)

The existing component (`VocabularyDetailDialog.tsx:136-213`) already gets most of this right for the dictionary-audio case; extending it for the Azure path:

| State | Behavior |
|---|---|
| No known audio yet (word with no dict audio, or any phrase) | Button visible in an "idle/unknown" state — not hidden, since it's now always potentially eligible for on-demand synthesis. |
| Tap with no known source | Loading spinner (existing `status === "loading"` visual) while `POST /api/vocabulary/pronounce` is in flight. No playback yet. |
| Synthesis succeeds | **Do not auto-play.** iOS Safari can silently block `play()` when it isn't the direct continuation of a synchronous user gesture — an awaited `fetch` in between breaks that chain. Flip the button to a distinct "ready — tap to play" affordance; the next tap is a fresh gesture and plays reliably. This is documented, expected behavior, not a bug to "fix" by trying to force autoplay. |
| Playback in progress | Existing `"playing"` state / stop-on-tap behavior, unchanged. |
| Overlapping playback | Already prevented — `audioRef` is one `Audio` instance per mounted button, remounted per item via `key={displayItem.id}`; a second tap on the same button pauses instead of layering. |
| Item switch / dialog close | Already handled — the `active` effect pauses and resets to idle before the old button unmounts. |
| Permanent failure (bad/dead URL, malformed audio) | Existing `status === "error"` text ("Couldn't play pronunciation.") plus a retry via tapping again; retry re-attempts the same known source first, only re-synthesizes if that source is empty. |
| Temporary network failure / offline | Same error state; **never auto-triggers a new synthesis request** — offline/playback failure is not evidence the *text* is wrong, only that this attempt failed. |
| Synthesis failed server-side (quota/config/upstream) | Error state with a message distinguishing "temporarily unavailable" (quota/network) from a hard failure, sourced from the route's typed `code`; the rest of the dialog (edit, delete, image, definition) stays fully usable — a TTS failure never blocks or resets the dialog. |
| Source label | "Details" section gains a minimal line when the audio is Azure-sourced, e.g. "Synthesized voice" — no dialect claim unless explicitly known (the default voice is a generic US English neural voice; no invented "US"/"UK" label). |
| Pronunciation vs. sentence playback | Unrelated, already-separate concerns — this button never touches the video/sentence-audio playback path; no shared state. |

---

## 11. Ordered implementation phases

0. **Verification spike (no code)**: confirm `AZURE_SPEECH_KEY`'s actual pricing tier and region in the Azure Portal; run a read-only query against production for how many `vocabulary_items` rows have `audio_url` set (sanity-check §3's "unknown legacy provenance" volume) — informs whether any user-facing messaging about legacy audio is worth adding.
1. **Prerequisite fixes** (§4): `dictionary.ts` phonetic/audio pairing; `PATCH` metadata-invalidation-on-term-change; `vocabulary/page.tsx` dead button.
2. **Migration**: `018_vocabulary_audio_assets.sql` (table + RLS + `vocabulary_items.pronunciation_audio_asset_id`), additive only.
3. **`src/lib/azureTts.ts`**: SSML builder, Azure REST call, response validation — mirrors `azureSpeech.ts`'s structure (typed error class, `isAzureTtsConfigured()`, no SDK dependency).
4. **`src/lib/rateLimit.ts` addition**: `checkAzureTtsQuota`.
5. **`src/lib/vocabularyAudioCache.ts`**: cache read (by key), upsert-write, Storage upload — mirrors `translationCache.ts`.
6. **`POST /api/vocabulary/pronounce`** route implementing the full flow in §7.
7. **`VocabularyDetailDialog.tsx`**: extend `PronunciationButton` to call the new route when no known source exists, add the "ready to play" post-synthesis state, always render the button (word or phrase) when any source is plausible.
8. **`src/app/vocabulary/page.tsx`**: reuse the same resolution logic for its (currently dead) button.
9. **Tests** (§13).
10. **Manual acceptance** (§13): desktop + real iPhone Safari/PWA.

---

## 12. Files to add or modify

**Add:**
- `supabase/migrations/018_vocabulary_audio_assets.sql`
- `src/lib/azureTts.ts`
- `src/lib/vocabularyAudioCache.ts`
- `src/app/api/vocabulary/pronounce/route.ts`
- `src/__tests__/azureTts.test.ts`
- `src/__tests__/vocabulary-pronounce-route.test.ts`
- `src/__tests__/vocabularyAudioCache.test.ts`

**Modify:**
- `src/lib/dictionary.ts` (phonetic/audio pairing fix)
- `src/app/api/vocabulary/route.ts` (`PATCH` invalidation-on-term-change)
- `src/lib/types/index.ts` (`VocabularyItem.pronunciation_audio_asset_id`, a `VocabularyPronounceResponse` type, a TTS error-code union alongside the existing `TranslationErrorCode`)
- `src/app/dictation/[videoId]/components/VocabularyDetailDialog.tsx` (`PronunciationButton` extension)
- `src/app/vocabulary/page.tsx` (wire the dead button)
- `src/lib/rateLimit.ts` (`checkAzureTtsQuota`)
- `.env.local.example` (document reused `AZURE_SPEECH_KEY`/`AZURE_SPEECH_REGION` for TTS, plus a new optional `AZURE_TTS_MONTHLY_CHAR_BUDGET`)
- `src/__tests__/vocabulary-save-route.test.ts` / `vocabulary-canonical-metadata-route.test.ts` (add cases for the `PATCH` invalidation rule)

---

## 13. Tests and acceptance criteria

All Azure calls mocked (`global.fetch` mocked in the same style as `vocabulary-save-route.test.ts`); no real quota consumed. Mirrors this repo's existing Jest conventions (mock `@/lib/supabase/server`, mock `getRedis`).

1. **Canonical heading and matching pronunciation** — extend `vocabularyHelpers.test.ts`: a resolved `canonicalForm` that differs from `term` still resolves a pronunciation request to the canonical text, not the surface term.
2. **Fallback to surface form when normalization is uncertain** — `canonicalFormDiffersFromSurface` returns false → heading and pronunciation both use `term`; already covered for heading by existing tests, add the pronunciation-route equivalent.
3. **Original sentence/offsets untouched** — no route in this plan writes `sentence_context`, `start`, or `end`; assert the pronounce route's DB writes are scoped to `pronunciation_audio_asset_id`/`last_used_at` only.
4. **Suitable dictionary audio prevents Azure calls** — word with `audio_url` set → route returns it, Azure mock never invoked.
5. **Missing phrase audio triggers synthesis on demand** — phrase with no `audio_url` → Azure mock invoked exactly once, response cached.
6. **Cache hits prevent repeat synthesis** — second call for the same normalized text/voice/version → Azure mock invoked zero additional times.
7. **Concurrent identical requests** — two parallel calls missing the cache both call Azure (acceptable, §7) but converge to one `vocabulary_audio_assets` row via the `upsert` `onConflict` path; assert only one row exists afterward.
8. **Invalid/failed responses never cached** — mock a non-200 and a suspiciously-short 200 body; assert no `vocabulary_audio_assets` row is written and no `vocabulary_items` update happens.
9. **Edits invalidate only relevant audio** — `PATCH` changing `term` nulls `audio_url`/`pronunciation_audio_asset_id`/`canonical_form`; `PATCH` changing only `note`/`translation` leaves them untouched (regression test for the current, correct preserve-on-omit behavior).
10. **Item switch stops playback, no stale state** — component test on `VocabularyDetailDialog`/`PronunciationButton` (extend `vocabularyPanel.test.tsx`'s existing patterns) asserting the audio element is paused/reset when `displayItem.id` changes.
11. **Legacy records** — item with `audio_url` set and `canonical_form`/`pronunciation_audio_asset_id` both null still plays via the dictionary path, never triggers synthesis.
12. **Configuration/quota/network/storage/playback failures** — one test per `code` (`TTS_NOT_CONFIGURED` when env vars missing, `TTS_RATE_LIMITED`/`TTS_QUOTA_EXCEEDED` from the Upstash mock, `TTS_UPSTREAM_ERROR` from a mocked Azure 5xx, `TTS_STORAGE_ERROR` from a mocked Supabase Storage failure with Azure otherwise succeeding — assert no cache row is written in that last case).

**Manual acceptance** (not automatable): desktop Chrome/Firefox — tap-to-play, retry-after-error, rapid item switching. Real iPhone Safari and installed PWA — first-synthesis "ready to play" second-tap flow, offline behavior (no crash, no synthesis attempt, clear error), backgrounding mid-playback.

---

## 14. Legacy-data treatment

Conservative, matching the house style in `scripts/repair-info-icon-vocab.mjs`:

- **Never** bulk-delete, bulk-regenerate, or bulk-singularize existing `audio_url`/`phonetic`/`canonical_form` values.
- Existing rows with `audio_url` set keep working exactly as today — dictionary playback is unaffected by this entire plan; the new route only ever *adds* a synthesis fallback for rows that have nothing.
- Rows with `audio_url` set but affected by the §3 pairing bug (phonetic text/audio from different `phonetics[]` entries) are **not** auto-repaired — there's no reliable signal in the stored data alone to tell a mismatched pair from a correct one (both look identical: two non-null strings). If this becomes worth fixing later, it needs a dry-run script (per the existing precedent) that re-fetches from dictionaryapi.dev and compares, reporting rather than silently overwriting.
- The prerequisite `PATCH` fix (§4) only changes behavior for *future* edits — it does not retroactively touch rows that were already edited under the old (non-invalidating) behavior. A one-off, dry-run-first audit script could flag rows where `updated_at`-equivalent evidence suggests a post-audio term edit, but that is optional follow-up, not part of this release.

---

## 15. Remaining uncertainties and the smallest complete first release

**Uncertain / needs verification before or during implementation:**
- Actual current pricing tier of the deployed `AZURE_SPEECH_KEY` resource (Portal check required — §8, §11 Phase 0).
- Whether the configured `AZURE_SPEECH_REGION` is one with strong Neural-voice backend capacity (Azure's own docs note most 429s on TTS are backend-capacity, not quota — worth a quick smoke test in Phase 0, not just a region-list lookup).
- Volume of production rows affected by the phonetic/audio pairing bug (§3) — unknown without a read-only production query.
- Whether the heteronym sense-ambiguity limitation (§3) is worth a future improvement (e.g. surfacing the sentence's part-of-speech tag from the highlight pipeline to bias which dictionary `entries[]` element is used) — explicitly out of scope here, flagged for a possible later pass.

**Smallest complete first release** (everything above, scoped to ship together):
- The three prerequisite fixes (§4).
- The `vocabulary_audio_assets` table + `pronunciation_audio_asset_id` column.
- One API route, one default voice, MP3 output, Supabase Storage caching.
- Extended `PronunciationButton` covering both words and phrases, with the iOS "ready to play" second-tap state.
- The dead button on `/vocabulary` fixed.
- No flashcard UI, no regeneration tooling, no bulk backfill, no admin dashboard for TTS usage (usage is inspectable via the Upstash counters the same way Gemini/Key-Phrase usage already is, with no new UI needed for a personal-scale app).

---

## Sources

- [Text to speech overview — Microsoft Learn](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/text-to-speech)
- [Speech Services pricing (F0/S0 tiers)](https://azure.microsoft.com/en-us/pricing/details/cognitive-services/speech-services/)
- [Text to speech REST API reference](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech)
- [Quotas and limits for Azure Speech](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-services-quotas-and-limits)

---

## Post-implementation audit addendum (2026-09-11)

A focused review of the **implemented code** (not this document) against nine correctness/security concerns. All fixes below are additive/corrective to the already-shipped feature — no restart, no new flashcard/admin surface. `npm run lint`, `npm run build`, and `npm test` all pass (756/756) after these changes.

### 1. Concern-by-concern

| # | Concern | Evidence in implemented code | Status | Action taken |
|---|---|---|---|---|
| 1 | Heading vs. pronunciation can disagree for a legacy row | `resolveVocabularyHighlightMeta` (client, falls back to live highlight cache) vs. the pronounce route's `item.canonical_form ?? item.term` (server, persisted-only) — for `canonical_form: null` + a live-cache match, these genuinely differed | **Confirmed** | Client-side backfill: `VocabularyDetailDialog` now PATCHes the resolved `canonicalForm`/`learningPattern` back onto the item the moment a legacy fallback resolves one, so the server's source of truth catches up instead of permanently diverging. Backfill-only (fills null, never overwrites a verified value) — see §2 below. |
| 1b | Same-item-id edit could play the OLD term's audio under the NEW heading | `PronunciationButton` was `key={displayItem.id}` only; `usePronunciationPlayback` seeded `resolvedUrlRef` from `knownAudioUrl` **once**, on mount, via `useRef`'s initial value — never resynced | **Confirmed, most severe finding** | Hook now takes `term`/`canonicalForm` and resets all playback state (resolved URL, status, in-flight generation) whenever that identity changes, even with `itemId` unchanged. |
| 2 | `pronunciation_audio_asset_id` trusted on ID alone | Old code: `getAudioAssetById(id)` → play, no check that the asset's voice/locale/format/`synthesis_version`/text still matches | **Confirmed** | Added `assetMatchesKey()`; the route now validates full identity before trusting a linked asset, falling through to a fresh lookup/synthesis on mismatch (e.g. after a `TTS_SYNTHESIS_VERSION` bump). |
| 2b | A cached asset's Storage object could be missing with no recovery | `publicUrlFor` never checked existence; a missing object would 404 forever once resolved | **Confirmed** | Storage access moved to signed URLs (see #7); a `null` resolution (object gone) is now treated as a miss and falls through to re-synthesis, which `upsert`s onto the same row and self-heals the shared cache. |
| 3 | Slow synthesis finishing after an edit could re-attach stale audio | `linkAssetToItem` was an unconditional `UPDATE ... WHERE id = itemId` | **Confirmed** | `linkAssetToItem` now carries a guard (`normalized_term` + `canonical_form` snapshot from request start); a 0-row no-op update is the correct outcome if the item changed mid-flight. Client discards stale in-flight responses via a generation counter (see #1b). |
| 4 | Dictionary phonetic/audio pairing | Prior session's fix (`pairedEntry = phonetics.find(p => p.text && p.audio)`) | Already resolved | No change; regression tests already existed. Confirmed synthesis always targets `canonical_form ?? term`, never `learning_pattern`'s notation. |
| 5 | Quota fails open even when Redis is unreachable, for a route that spends real money | Every quota check in `rateLimit.ts` fails open when unconfigured — correct for Gemini/Key-Phrase, not safe for paid, user-triggered TTS | **Confirmed** | New synthesis (only) now fails closed when the quota backend is unconfigured or throws, **in production only** (`isProductionEnvironment()`); dev/test keep the existing fail-open convenience. Dictionary/cached paths never reach this check. |
| 6 | Broken dictionary `audio_url` traps retries forever | `toggle()` always retried the same `resolvedUrlRef` with no path off it | **Confirmed** | Bounded, explicit "Use generated pronunciation" recovery action (never automatic); route reordered so a previously-linked generated asset is preferred over dictionary audio on later opens. |
| 7 | Public RLS on `vocabulary_audio_assets` + public Storage bucket | Migration 018 modeled both on `vocabulary_translation_cache`'s public-read pattern; nothing in the app ever reads either via the client | **Confirmed** | New migration `019_vocabulary_audio_private.sql`: table SELECT restricted to service-role; bucket flipped to private; `resolvePlaybackUrl` uses `createSignedUrl` (1h TTL) instead of `getPublicUrl`. |
| 8a | "At most one extra Azure call" under concurrency | No code claimed this, but nothing prevented/documented it either | Clarified, not changed | Added a test proving N concurrent misses → N Azure calls (not deduplicated); documented as an accepted, quantified MVP trade-off — the unique-constraint upsert still prevents duplicate **storage/rows**, just not duplicate **Azure spend**. |
| 8b | Two vocabulary cards could play audio simultaneously | Each `usePronunciationPlayback` instance owned its own `<audio>` with no cross-instance coordination | **Confirmed** | Added a lightweight module-level playback-slot coordinator inside the hook; claiming playback on one instance stops any other. |

### 2. Root causes of the confirmed defects

- **#1/#1b/#3 all trace to one design gap**: the pronunciation button was keyed and seeded only by `itemId`, treating "edit this item's text" as a no-op for playback state, when it's exactly the case that most needs invalidation. The server-side counterpart (unconditional `UPDATE`) had the same blind spot.
- **#2**: an asset *id* was conflated with an asset's *validity* — nothing re-checked that the identity the id was resolved under (voice/locale/format/version/text) still matched the current configuration.
- **#5**: a fail-open convention correct for a free-tier, best-effort feature (Gemini explanations, Key Phrase enrichment) was copied verbatim onto a feature that spends metered Azure quota on every miss.
- **#7**: the public-read RLS pattern from `vocabulary_translation_cache` was reused by structural analogy without re-examining whether *this* table's content (a user's own saved text) belongs in that trust tier.

### 3. Files changed in this pass

**Modified:**

- `src/hooks/usePronunciationPlayback.ts` — identity-aware reset, stale-response discard, playback-slot coordinator, bounded dictionary-audio recovery, self-healing retry-then-reclear for broken server-resolved assets.
- `src/app/api/vocabulary/pronounce/route.ts` — asset-identity validation, reordered resolution (linked asset → dictionary → shared cache → synthesize), conditional/guarded link, production-only fail-closed quota gate, `preferGenerated` flag, signed URLs.
- `src/lib/vocabularyAudioCache.ts` — `CachedAudioAsset` now carries full identity; new `assetMatchesKey`; `publicUrlFor` replaced by async `resolvePlaybackUrl` (signed URL).
- `src/lib/rateLimit.ts` — new `isQuotaBackendConfigured()`, `isProductionEnvironment()`.
- `src/app/api/vocabulary/route.ts` (PATCH) — accepts backfill-only `canonicalForm`/`learningPattern`.
- `src/lib/types/index.ts` — `VocabularyUpdateRequest.canonicalForm/learningPattern`, `VocabularyPronounceRequest.preferGenerated`.
- `src/app/dictation/[videoId]/components/VocabularyDetailDialog.tsx` — passes `canonicalForm` to the hook, adds the legacy-backfill effect, renders the recovery action.
- `src/app/vocabulary/page.tsx` — card button passes `term`/`canonicalForm`, renders the recovery action.
- Test files: `vocabulary-pronounce-route.test.ts`, `vocabularyAudioCache.test.ts`, `vocabulary-canonical-metadata-route.test.ts`, `vocabularyPanel.test.tsx` — updated/extended.

**Added:**

- `supabase/migrations/019_vocabulary_audio_private.sql`.
- `src/__tests__/usePronunciationPlayback.test.tsx` — dedicated hook regression suite (identity reset, stale-response discard, cross-instance exclusivity, recovery action, self-healing retry).

### 4. Migrations and deployment order

1. `018_vocabulary_audio_assets.sql` (from the original implementation pass — **not yet applied to any database**, per the prior session's report).
2. `019_vocabulary_audio_private.sql` (this pass) — apply immediately after 018, in numeric order. It is idempotent (`drop policy if exists`) and safe to apply whether or not 018 has already run elsewhere.
3. Neither migration has been applied to any real Supabase project by this assistant — both still need `supabase db push` (or your usual flow) run by you.
4. If 018 was *already* deployed with real traffic before 019 lands: any public URL a client currently holds in an open tab will start 403ing the instant 019 applies. This is expected and self-resolving — this app never persists a resolved `audioUrl` beyond one button's in-memory lifetime, so the next tap (or a reload) gets a fresh signed URL. No data is lost or needs migrating.

### 5. Resulting canonical/pronunciation rules

- **Server is always the source of truth for what gets spoken**: `item.canonical_form ?? item.term`, read fresh from the DB per request — never the client's live highlight cache, never client-supplied text.
- **The client's displayed heading now converges onto the same value**: a legacy row's live-cache-derived canonical form is opportunistically persisted (backfill-only, never overwriting a verified value) the moment it's resolved, so heading and pronunciation read the same persisted field going forward. A narrow, self-resolving window remains if a user taps pronounce before the backfill PATCH lands (see §6 Limitations).
- **Editing a saved item's term** (same `itemId`) resets all client-side playback state immediately (no stale audio, no stale in-flight response applied) and nulls all term-derived server columns unconditionally (unchanged from the original implementation).

### 6. Cache, quota, access, and recovery behavior (as corrected)

- **Cache reuse**: a linked or shared-cache asset is only served after its full identity (voice/locale/format/`synthesis_version`/normalized text) matches the current configuration; otherwise it's treated as stale and a fresh lookup/synthesis runs.
- **Resolution order**: linked generated asset (if identity-valid) → dictionary audio (skipped if `preferGenerated`) → shared cache → synthesize. This order (asset before dictionary) is what makes the recovery action in §item 6 durable across future opens.
- **Quota**: character-budget and rate checks are atomic (Redis `INCRBY`), global (not per-IP), and now fail closed for **new synthesis only** when the backend is unreachable/unconfigured **in production**; dictionary audio and any valid cached asset are unaffected regardless. Quota is spent on a failed Azure call too (no refund logic) — deliberate, matches this codebase's existing conservative-accounting convention.
- **Access**: `vocabulary_audio_assets` and the `vocabulary-audio` bucket are service-role-only; every resolution goes through the authenticated, ownership-checked pronounce route, which returns a short-lived signed URL, never a permanent public one.
- **Recovery**: unusable dictionary audio surfaces an explicit "Use generated pronunciation" action (never automatic); a broken server-resolved asset self-heals after one same-source retry fails twice, without any user action.
- **Concurrency**: concurrent duplicate requests for the same not-yet-cached text each call Azure (not deduplicated — documented, quantified limitation, not a queue); the DB `upsert` still guarantees only one surviving row/object. Playback itself is exclusive across all buttons on the page.

### 7. Test commands and results

- `npm run lint` — 0 errors (3 pre-existing warnings, unrelated to this work).
- `npm run build` — compiles and type-checks cleanly; `/api/vocabulary/pronounce` present in the route manifest.
- `npm test` — **64 suites / 756 tests passing**, including the new `usePronunciationPlayback.test.tsx` and the extended pronounce-route/cache/PATCH suites.
- All of the above are **unit/component tests against mocked Supabase and Azure clients** — no real Azure quota was consumed, and no real database was touched.
- **Not covered by this pass** (explicitly out of scope for a code-only review):
  - Database integration tests against a real/local Supabase instance (RLS policies, the `normalized_term`/`canonical_form` conditional-update guard under real concurrent writes, the unique constraint under a real race) — the mocked tests exercise the *code's* logic, not the deployed database's actual behavior.
  - Real browser testing.
  - Real iPhone Safari/PWA testing.

### 8. Remaining limitations and manual checks

- **Concurrent-miss Azure calls are not deduplicated** (§8a) — accepted MVP trade-off, quantified above; revisit only if usage volume makes it a real cost concern.
- **Legacy-row backfill has a narrow timing window**: if a user taps pronounce within the same request round-trip as the dialog opening (before the backfill PATCH commits), that one tap may still speak the un-canonicalized term. Self-resolves on the very next tap.
- **Phase 0 items from the original plan remain unverified by this assistant** (no Azure Portal access): the deployed `AZURE_SPEECH_KEY` resource's actual pricing tier, and whether `AZURE_SPEECH_REGION` has healthy Neural-voice backend capacity.
- **Manual acceptance checklist** (do before/after deploying, since none of this can be verified from jsdom):
  1. Apply migrations 018 then 019 to a real Supabase project.
  2. Desktop Chrome/Firefox: tap-to-play on a word with dictionary audio, a word without, and a phrase; confirm the "ready — tap to play" second-tap flow for on-demand synthesis.
  3. Open two different vocabulary cards' pronunciation buttons in sequence — confirm the first stops when the second starts (no overlap).
  4. Edit a saved item's term while its detail dialog is open and its pronunciation button already shows "ready" or has played — confirm the button resets and the next tap resolves the NEW text, not the old audio.
  5. Real iPhone Safari/PWA: first-synthesis flow, offline behavior, backgrounding mid-playback — none of this is verifiable via jsdom.
  6. Manually break a cached asset's Storage object (delete it in Supabase Storage) and confirm playback fails once, then self-heals on a later tap instead of failing forever.
