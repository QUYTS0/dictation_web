# Learning Reports & Review — audit and implementation plan

Status (2026-10-04): **P0–P3 approved for implementation (app-only)**.
- **P4–P5 are not approved.** Their design (§6–§10) was revised on 2026-10-04 to resolve five
  open issues: explanation persistence, explanation recovery identity, the legacy assessment race,
  fallback, and content versions. It now awaits approval. No P4–P5 code or migration exists.
- Implementation status is recorded per phase in §12.

**Baseline**
- `main` @ `bcd27bb`, clean tree; not assumed deployed.
- Migrations `001`–`042` are immutable and none higher exists. Any migration proposed here takes
  the **next available number, verified at implementation time**.

**Evidence tiers:** **code** (`file:line`) · **test** (an existing test asserts it) ·
**user-reported** · **provider** (needs a real Gemini call; not done) · **operator** (a console
or project check).

**Phases:** P0–P3 ship without any Gemini work. P4–P5 are optional AI work. Every phase is
verified before it ships; P6 is final integration, not the first check.

---

## 1. Current-state audit (evidence)

### 1.1 Round lifecycle (code)

**Completion**
- `fn_try_complete_round` (`037:495-531`) requires `status='active'`, `completed_at is null` and
  `required_sentence_count > 0`.
- Coverage is the **union** of eligible sentences with a valid Dictation answer **or** a valid
  Shadowing take (`recording_duration_sec >= 0.5`, `validity_basis='client_reported'`,
  `037:1131`).
- It writes `completed`, `clock_timestamp()` and `completed_at_approximate=false`. It stores **no
  completion evidence** and never changes `provenance`.
- Only callers: the two attempt writers (`037:1032`, `037:1136`).

**Writers do not check round status.** Dictation and Shadowing writers (`037:943-1145`), Azure
begin/finish (`038:119-295`), `fn_record_word_match` and persist-recovery
(`persist-recovery/route.ts:54-78`) all accept writes to completed and abandoned rounds. A
completed round never re-completes. Both attempt writers bump `updated_at` (`037:1027,1135`).

**Checkpoint.** `fn_update_resume_position` (`037:795-812`) returns `applied:false` for
non-active rounds, so no checkpoint is written.

**Resume** (`src/app/api/session/resume/route.ts:30-39`)
- Returns the latest round of any status, ordered by `updated_at desc`, with **no `roundId`
  parameter**.
- A late write to an abandoned round can therefore win over the active one.
- Library and History use `(status='active') desc, started_at desc` (`040:798`, `042:181`).

**Rounds and sessions**
- One active round per user and video: partial unique index (`030:130-131`). `fn_restart_round`
  (`037:839-883`) abandons it and creates the next one, pinned to the current ready revision.
- Study sessions attach to a completed round unless a newer active round exists or the round is
  abandoned (`037:623-643`, `039:403-408`).

**Client**
- A completed round shows a card (`page.tsx:1596-1619`). `reviewSegment` never starts a round
  (`useDictationSession.ts:1484-1497`).
- Takes use `sessionStore.sessionId ?? resumeState?.sessionId` (`useDictationSession.ts:1409`).
- The report auto-opens only at `session_completed` (`page.tsx:286-292`). Confetti only when
  `completedByThisPage`.
- **Confirmed (P2) and fixed:** with a completed round known only from resume (not yet entered),
  a script-sentence click (`jumpToSegment` → `triggerAutoSave`) sent save-progress with no round
  id, so the server's get-or-create made a **new active round**. The save now always names the
  known round (§12, P2).

**Pin**
- `transcript_id` is nullable (`001:90`). Writers raise `stale_transcript_revision` /
  `round_transcript_unknown`. Resume loads the pinned revision (`useDictationSession.ts:1117`).

**Late results**
- Keyed by attempt: Azure `(attempt_id, user_id, seq)` (`038:242-245`). The client drops stale
  epochs (`useDictationSession.ts:1437-1443`).

### 1.2 Provenance fields (code)

| Field | Exact meaning |
|---|---|
| `status` | `active` / `completed` / `abandoned` |
| `completed_at_approximate` | `true` only where `fn_phase3_backfill` synthesized a missing timestamp (`least(greatest(updated_at, started_at), cutover_at)`). `false` otherwise, **including legacy rounds whose old app stored an exact time**. |
| `provenance` | `legacy_unverified` = the round existed when the Phase 3 backfill ran (`037:1368-1433`, active rounds included); `current` = created later. Completion never changes it. |
| `attempt_logs.segment_identity_provenance` | `legacy_unverified` for backfilled answers; `verified` for Phase 3 writer answers. |
| `historyComplete` (`040:1209-1211`) | `provenance='current'` and every attempt verified. |
| Completion evidence | **None stored.** `cutover_at` is owner-only, and an old tab writing before the gate can't be ruled out from the data alone. |

**The user's round** (started Sep 24, cutover Sep 26, completed Oct 4)
- The provenance is **correct**.
- The headline "Completed earlier (unverified)" is **wrong wording**: it is chosen by provenance
  alone (`RoundReportPanel.tsx:38`, `HistoryVideoCard.tsx:19`), and "earlier" isn't supported by
  any field.
- Hiding first try and best run is correct.

### 1.3 Report UI (code)

**`RoundReportPanel`**
- Tiles: coverage; sentence accuracy (`latestCorrect/practicedSentences`, `:112`); a "—" First
  try tile; answers submitted (**all rows** including invalid, `040:1297`); best run (hidden
  unless > 1); active time.
- Shadowing tiles and a lazy section.
- A fully expanded "Corrected after mistakes" list.

**Missing or unconfirmed**
- No Listening section. The AI assessment is only on `/results`, below the report
  (`results/[sessionId]/page.tsx:210-316`).
- No `text-justify` and no nested `max-h` scroll in the report components; the "justified text"
  observation needs a browser check.

**Layout and History**
- Playback pauses on report open (`page.tsx:296-298`). `useReportViewLayout` saves and restores
  the panel.
- The top-bar toggle is md+ only and has no `aria-expanded` (`page.tsx:1278-1290`). The floating
  "Show lesson panel" button shows at every breakpoint (`page.tsx:1759-1781`).
- History's round selector is local state (`HistoryVideoCard.tsx:179-200`). The report GET only
  SELECTs plus the `stable` `fn_round_report`: **read-only today**.
- Library removal keeps reports (`040:148-179`).

### 1.4 Listening (code)

- `listening_progress` is keyed `(user, video, transcript_id)` (`026:14-36`), **not by round**,
  with an owner SELECT policy (`026:56`).
- Per study session: `listening_observed_sec` and `listening_newly_covered_sec` (`023:27-28`),
  sessions carry `round_id`, owner SELECT exists (`023:59,74`).

### 1.5 Dictation scoring (code)

**Correctness is decided in SQL**, in `fn_record_dictation_attempt`:
- `v_norm_expected := fn_normalize_dictation_text(<pinned segment text_raw>, mode)` and
  `v_norm_user := fn_normalize_dictation_text(p_user_text, mode)` (`037:962-963`);
- `is_correct := equal` (`037:1002`);
- `error_type := fn_classify_dictation_error(...)` on the normalized strings (`037:1003`, defined
  at `037:379`).

**Normalization** (`037:351-375`; mirrored in TypeScript by `normalizeText`, `text.ts:42-50`;
parity is asserted by `src/__tests__/integration/phase3-scoring-parity.integration.test.ts`)
- **exact:** special characters and whitespace only. Case and punctuation remain significant.
- **relaxed** and **learning:** additionally remove punctuation and lowercase. **They are
  identical.**

**Classifier output**
- `capitalization` if the lowercased strings are equal;
- `punctuation` if they are equal after lowercasing and removing punctuation;
- otherwise `missing_word` / `extra_word` by word count;
- otherwise **`wrong_form` for any same-length difference.**

**Stored per attempt:** `match_mode` (null = pre-Phase-3), `error_type`, `hint_level_used`
(null = unknown), `is_practice_valid`, `client_attempt_id` (idempotent; a different payload under
the same key → `idempotency_key_reused_with_different_payload`, `037:964-983`).

`wink-nlp` (server-side vocabulary highlights) has POS-dependent lemmas.

### 1.6 AI assessment (code)

`src/app/api/session/[sessionId]/explain-all/route.ts`

**Model:** `GEMINI_MODEL ?? "gemini-3.6-flash"` (`src/lib/gemini.ts:1`); `.env.local.example`
says 1.5-flash (doc drift).

**Input selection**
- `is_correct=false` attempts, **no `is_practice_valid` filter** (`:234-248`).
- The **latest wrong attempt per sentence** (`:260-266`), including sentences corrected later.
- Grouped into **distinct `(expected, typed)` patterns**, keyed by
  `normalizeText(…, "relaxed")` of both texts, so case and punctuation are ignored (`buildPatterns`,
  `:35-59`; corrected 2026-10-04, previously described as "exact"). Spacing-only patterns are never
  sent.

**Overview vs detailed explanations**
- **The overview prompt lists every non-filtered pattern, uncapped** (`:14-15`, `:156-158`).
- **Detailed explanations are requested for at most `MAX_PATTERNS_PER_REQUEST = 35` distinct
  patterns** (`:16`; "the old 40" per the comment). A pattern can cover several sentences, and its
  repeats are tagged duplicates of the first occurrence (`:470-478`). Overflow patterns become
  `minor` "Not explained…" (`:523`).
- So the current app explains **up to 35 distinct patterns, not 35 sentences.**

**Accuracy context**
- `learning_sessions.accuracy` / `total_attempts` = correct ÷ **all** rows (`037:1024-1030`).
  That is the source of "74% across 90 attempts".

**Prompt**
- Learner text sits in plain quotes, with no system instruction (`:124-131`).

**Calls**
- A merged call (8192 output tokens, 55 s non-aborting race), then a parse retry **without a
  quota check** (`:548-569`).
- If that fails, an assessment-only fallback after a second quota check.
- **Up to 4 provider requests per click, 2 units charged.**

**Validation and storage**
- The shape check is minimal. A missing index borrows a positional item, and a missing status
  saves an **empty** explanation (`:444-480`).
- **Success can conceal missing explanations.** Truncation leads to the fallback with no items.
- Storage:
  - `learning_sessions.ai_assessment` via `fn_persist_session_assessment` (`037:1157-1184`,
    unconditional overwrite);
  - `ai_feedback(id, attempt_id, explanation, corrected_text, example_text, created_at)`
    (`001:121-128`): owner SELECT, service-role manage, **no unique constraint**.
- The client ignores `assessmentSaved:false`.

**`ai_feedback` writers (all code paths)**
1. explain-all, service client: `DELETE … in(attempt_ids)` then `INSERT` (`:404-411`). Not
   atomic. A DELETE error is only logged and the INSERT still runs. A failed INSERT after a
   successful DELETE leaves **no row** for those attempts. Only the first occurrence of each
   pattern gets a row (`:470-478`).
2. `/api/ai/explain`, service client: cache read `.maybeSingle()` (`:80-84`). Duplicates make it
   error, which is treated as a miss, then it regenerates and plain-`INSERT`s **another**
   duplicate (`:175-180`).
   - The prompt texts come from the request body (`:41-42`).
   - **No client caller found.**

### 1.7 Quota (code)

`checkGeminiQuota` (`src/lib/rateLimit.ts:118-125`)
- Separate `INCR` + `EXPIRE` for RPM then RPD. A denied RPD still charged RPM, and there is a gap
  between the two calls.
- A fixed 86,400 s window from the first increment, **global**; defaults 5 RPM / 20 RPD.
- **Fails open without Redis** (`:44-47`).

**Callers:** explain-all (2 checks), `/api/ai/explain`, and `/api/transcript/translate` (one check,
up to 2 `generateContent`).

**UI:** "N/20 AI calls left today" (`results/[sessionId]/page.tsx:244`).

**Provider limits are an operator check.**

---

## 2. Verdict: the remembered 80-sentence capability

| Question | Answer (tier) |
|---|---|
| Does "80" exist? | **No** — not in either commit of `explain-all` (`d0b9f36`, `691caaa`), the helpers, the tests or the docs. Only "the old 40" patterns (code, git). |
| What is capped? | **Distinct patterns** for detailed explanations (35). The overview lists every pattern (code). |
| Which attempt? | The latest wrong attempt per sentence, even if later corrected (code). |
| Invalid answers? | Included (code). |
| Corrected vs still wrong? | Not distinguished (code). |
| Several calls per click? | Up to 4, charged 2 (code). |
| Can success hide missing explanations? | Yes (code). |
| Truncated output, missing or duplicate ids, partial parse? | Parse failure leads to the fallback. A missing id gets a positional or empty item. A duplicate id: last one wins. No partial parse (code). |
| Budgets and timeouts? | 8192 / 2048 output tokens; **no input budget**; 55 s / 30 s timeouts that don't abort (code). |
| Does quota count every invocation? | No (code). |

**Reconciliation (user-reported, consistent with the code):** a round with ~80 wrong sentences
went out as one request. The overview covered all of them ("Based on all 80 mistakes"), and
detailed explanations covered at most 35 distinct patterns. Whether a larger batch fits is a
**provider** question.

---

## 3. Architecture: three layers

| Layer | Content | Needs AI | Phase |
|---|---|---|---|
| **A. Deterministic report** | Metrics, answer → reference differences, current vs corrected, recurring differences, priorities, rule-based notes labelled "Observed in your answers" | No | P1 |
| **B. Saved explanations** | Saved explanations (`attempt_explanations`, including copies of every `ai_feedback` row) reused by attempt or by same-round pattern (§6). Viewing never calls the provider. | Only to create | P4 |
| **C. Optional AI** | "Generate assessment" (overview plus the first explanation batch) and "Explain more" (further batches) | Yes (Gemini only) | P5 |

AI availability never gates A or B. No other provider.

---

## 4. Layer A — deterministic Dictation analysis

### 4.1 Authority and diagnostics

1. **Authoritative:** the stored `is_correct`, `match_mode` and `error_type` (computed in SQL from
   the pinned segment text, §1.5). Display analysis **never** changes correctness.
2. **Diagnostic recomputation** uses the TypeScript mirror `normalizeText(text, attempt.match_mode)`,
   which has a parity test, on the pinned reference and the stored answer:
   - **Consistent:** recomputed equality equals stored `is_correct` → observations below.
   - **Discrepancy:** recomputed equality ≠ stored `is_correct`. The stored result stays
     authoritative, and the wording follows it:
     - stored **incorrect** but equal under the current rules → "Marked incorrect when submitted;
       the difference isn't identifiable with the current matching rules";
     - stored **correct** but different under the current rules → "Accepted as correct when
       submitted" (never labelled incorrect), with no difference highlighting.

     No category in either case.
3. **Case and punctuation rules**, only for an incorrect `exact`-mode answer, from explicit
   comparisons of the exact-normalized strings:
   - **case only:** `lower(a) = lower(b)` → "Capitalization differs";
   - **punctuation only:** `removePunctuation(a) = removePunctuation(b)`, case-sensitive →
     "Punctuation differs";
   - **both:** neither alone, but `lower(removePunctuation(a)) = lower(removePunctuation(b))` →
     "Capitalization and punctuation differ";
   - otherwise → word-level observations (§4.2) on `lower(removePunctuation)` tokens. Case and
     punctuation are **not** additionally mentioned (implemented choice: one observation per
     real difference).
4. **Relaxed and learning:** case and punctuation can never cause incorrectness, and are never
   mentioned.
5. **Legacy `match_mode IS NULL`:** a raw-text diff labelled "matching rule unknown (older
   answer)", with no categories.
6. **Wording:** factual differences only. Never claims about hearing, grammar knowledge,
   comprehension, attention, stamina or pronunciation.

**Tests (unit, `dictationAnalysis.test.ts`):**
- exact case-only, punctuation-only, and both;
- exact with real word differences;
- relaxed with punctuation and case differences (no mention) and with word differences;
- legacy null mode;
- stored `is_correct=false` while the strings are equal under the current normalizer
  (discrepancy);
- stored `true` while they differ (discrepancy).

### 4.2 Word observations (else neutral)

| Category | Explicit rule | Wording |
|---|---|---|
| Missing | Reference token unmatched | "Missing: *the*" |
| Extra | Answer token unmatched | "Extra: *really*" |
| Word ending differs | Single-token substitution: one = the other + `s/es/ed/d/ing/'s/'` | "You wrote *span*; the reference has *spans*" |
| Close spelling | Single-token substitution, both ≥ 4 characters, edit distance ≤ 2 with adjacent transpositions (`editDistance` in `dictationAnalysis.ts`; the existing `hasSpellingError` only checks for *any* word difference, so it isn't reused) | "Spelling: *recieve* → *receive*" |
| Contraction | Span pair in a fixed list (`don't`/`do not`, …) | "Contraction differs" |
| Number form | Digits vs a number word (0–100) | "Number written differently" |
| Words differ | Anything else | "*cat* → *hat*" |
| No answer | `is_practice_valid=false` | Invalid count only |

- The stored `wrong_form` is **never** displayed as "Wrong form".
- No grammar engine and no `wink` lemmas in this release.
- With repeated words, the alignment is "one possible alignment". Only unambiguous single-token
  substitutions between matched anchors feed the recurring statistics.

### 4.3 Units (never conflated)

| Unit | Definition |
|---|---|
| Incorrect submissions | Valid incorrect answers (retries count once) |
| Distinct sentences ever incorrect | Eligible sentences with ≥ 1 valid incorrect answer |
| Currently incorrect | Latest valid answer incorrect |
| Corrected | Latest valid answer correct, an earlier one incorrect |
| Changed word occurrences | Differing positions in each currently-incorrect latest answer, and in each corrected sentence's last wrong answer |
| Recurring difference pairs | Distinct single-token substitutions in ≥ 2 sentences |

### 4.4 Priority order

1. Currently incorrect (most valid incorrect answers first).
2. Recurring pairs (more sentences first).
3. Corrected after ≥ 3 valid incorrect answers.

Shadowing priorities stay in the Shadowing section. A corrected sentence is always "Corrected after
N earlier answers", never unresolved.

---

## 5. Lifecycle and provenance

### 5.1 Hierarchy and default section

- **Levels:** the video is navigation (the History card and its rounds); the round is the metric
  scope; study sessions are supporting history; each mode is a section.
- **One shell:** an always-visible summary (the "Overview") followed by **Dictation · Shadowing ·
  Listening** tabs. Implemented this way instead of an Overview tab, so the summary and the next
  action are never behind a tab. Each report names its round and pinned script version ("Round 2 ·
  script version 3").
- **Selecting a round never writes.**
- **Default section:** `?section=`, else the practice page's `entryMode`, else the first mode with
  evidence (Dictation, Shadowing, Listening). Never
  `last_mode`.

### 5.2 Completion and history wording (no promotion)

| Shown | Predicate | Wording |
|---|---|---|
| Headline | `completed` / `abandoned` / `active` | "Round complete" (all completed rounds) / "Round ended — a newer round was started" / "Round in progress" |
| Date | `completed_at`, `completed_at_approximate` | "Completed 4 Oct 2026", or "Completed around … (date estimated)" |
| History note | `historyComplete=false` | "Part of this round was practised before detailed tracking. First-try and best-run statistics aren't available." |
| Metric availability | `firstTry.available`, `bestStreak` | One line, no "—" tiles |

**Dashboard and Library** — wording only, predicates unchanged (`040:900-920`, `040:802`):

| Stat | Predicate | Wording |
|---|---|---|
| `completedVideos` | completed with `provenance='current'` | "Completed videos" |
| `legacyCompletedVideos` | completed, `legacy_unverified`, no current completion | "+N completed in rounds started before detailed tracking" |
| `hasLegacyCompletion` | the same per video | "Completed · started before detailed tracking" |

Changing the counts is a separate, unresolved decision (§14).

### 5.3 Same-round Shadowing continuation

**Verified now (code):** completed rounds accept new takes, Azure, Word Match and recovery
without re-completing, and study sessions attach unless a newer active round exists.

**Gaps (code):** no checkpoint for non-active rounds; resume can't target a round; resume
ordering; possible implicit round creation.

**Contract**

1. **Entry.** Every continuation action navigates to
   `/dictation/<videoId>?round=<roundId>&mode=shadowing&start=<rule>`.
   - `GET /api/session/resume` gains an optional `roundId`. It returns that owned round (any
     status) plus `newerActiveRoundId`.
   - Without `roundId`, the order becomes `(status='active') desc, started_at desc, id desc`.
2. **Script version.** The pinned revision is always loaded. A "newer script" notice offers only
   the clearly labelled "Practice again — new round".
3. **Start position, re-derived from server data each time** (no checkpoint write, no
   migration):
   - `start=unrecorded`: first eligible sentence without a valid take.
   - `start=unscored`: first sentence with a valid take but no saved Azure result.

   This is **not** an exact saved playhead: it is recomputed from coverage each time.
4. **Leaving midway** re-derives the same rule on return.
5. **A newer active round at load:** no recording controls; "Go to current round (Round N)".
6. **A newer round created after the report loaded:** the entry check re-reads
   `resume?roundId=`, shows the notice from item 5, and records nothing.
7. **Direct links and old tabs** go through the same entry check.
8. **Delayed submissions** that were already started land in their own round (existing
   behaviour).
9. **Recovery:** completion or supersession of the round does not itself invalidate recovery for an
   existing attempt. Ownership, signature, sequence, conflict and the other existing validity
   checks still apply.
10. **Fresh takes in a superseded round** are blocked in the UI only. The server can't tell them
    from delayed ones without a trusted client timestamp. A modified client could add takes to an
    old round; that affects only the user's own old report, never completion. This is unresolved
    (§14).
11. **No pin:** no continuation.
12. **Auto-save in continuation mode never calls `fn_create_or_get_active_round`.** P2 starts with
    a test that reproduces the suspected implicit-creation path.

**Unchanged:** mixed-mode completion. Per-mode completion and "Finish Shadowing" are rejected for
this release, because they would change counts and round semantics. "Practice again — new round"
uses `fn_restart_round`: fresh progress, prior attempts stay in their round.

### 5.4 Unified action table (completion view, full report, History)

| State | Primary action | Secondary | Never |
|---|---|---|---|
| Active round | "Continue practice" | "Practice again — new round" (confirm) | |
| Completed, valid recordings < eligible | **"Continue Shadowing (N sentences left)"** → `start=unrecorded`, same round | "View full report", "Practice again — new round" | |
| Completed, all recorded, some unscored | **"Continue pronunciation scoring (N left)"** → `start=unscored`, same round. Note: "You'll record these again — recordings aren't kept." | same | |
| Completed, all scored | **"View Shadowing summary"** | "Practise Shadowing in this round" → sentence 1, same round; "Practice again — new round" | |
| Newer active round exists | "Go to current round (Round N)" | "View full report" | continuation |
| Abandoned | "View full report" | "Practice again — new round" | continuation |
| No pin | "View full report" | "Practice again — new round" | continuation |
| Legacy (`historyComplete=false`) | per the rows above, if pinned | | |

Same-round actions always say "in this round". New-round actions always say "new round". A new
round is never created implicitly.

Coverages are shown separately: completion · Dictation · Shadowing recorded · Azure scored · Word
Match · Listening (script version).

### 5.5 Cross-round

Fresh progress; no copying or credit; no badges or video overview; no merging across revisions by
index. The Dashboard keeps its documented account-wide pronunciation scope.

---

## 6. Layer B — saved explanations (P4)

**Source identity.** `attempt_id` is a sound key. The attempt row is immutable and fixes the user,
the round (and therefore the pin), the sentence, the reference, the answer and the mode.

**Missing today:** model and prompt version, operation identity, uniqueness, and protection
against the old DELETE → INSERT writer (§1.6).

### 6.1 Why insert-only on `ai_feedback` is not enough

- An old explain-all instance can be running during a deploy window, after an app rollback, or in
  a long-lived serverless instance. It runs `DELETE FROM ai_feedback WHERE attempt_id IN (…)` and
  then `INSERT`. If the INSERT fails, nothing replaces the deleted rows (code, §1.6).
- The app cannot stop old code from running. So **any explanation the new app saves in
  `ai_feedback` can be deleted by an old writer**. Making the new writers insert-only does not
  change that.
- **Decision: new explanations are stored in a new table that no old code references.**
  `ai_feedback` becomes legacy input only.

### 6.2 Storage (P4 migration, next free number, additive)

**`explanation_operations`**: one row per explanation batch, i.e. one provider operation.
- `id uuid pk` (the operation id, generated by the server in `begin`); `user_id`; `round_id` →
  `learning_sessions` on delete cascade.
- `seq bigint not null`, with `unique (round_id, seq)`. Allocated in `begin` as
  `coalesce(max(seq), 0) + 1` while the per-round lock (§10.2) is held.
- `op_key text`: `sha256(sorted target attempt ids + prompt_version + model)`.
- `target_attempt_ids uuid[]`: 1–35, distinct, all owned by the round. Checked in `begin`.
- `prompt_version int not null`, `model text not null`.
- `status`: `started` / `accepted` / `abandoned`; `lease_token uuid`; `lease_expires_at`.
- `payload_hash text`, `accepted_at`.

**`attempt_explanations`**: one row per saved note.
- `id uuid pk`; `user_id`; `round_id` → `learning_sessions` on delete cascade; `attempt_id` →
  `attempt_logs` on delete cascade.
- `source`: `legacy_ai_feedback` / `batch` / `single`.
- `operation_id uuid null` → `explanation_operations`; `seq bigint null` (copied from the
  operation).
- `legacy_feedback_id uuid null unique`. **Deliberately no foreign key to `ai_feedback`**, so an
  old writer's DELETE can never cascade into this table.
- `explanation text not null` (non-empty), `corrected_text`, `example_text`.
- `prompt_version int null`, `model text null`. Both are null for legacy copies.
- `created_at`.
- `unique (operation_id, attempt_id)`.
- Check: `source = 'legacy_ai_feedback'` ⇔ `legacy_feedback_id is not null and operation_id is
  null`.

**Access**
- RLS: owner SELECT (`user_id = auth.uid()`). No insert, update or delete grants to `anon` or
  `authenticated`.
- Writes go only through security-definer RPCs, which take `user_id` and `round_id` from the
  locked round row and never from the caller's payload.

**Legacy capture**
- An `AFTER INSERT` trigger on `ai_feedback` copies each row that has an `attempt_id` into
  `attempt_explanations` (`source='legacy_ai_feedback'`), resolving the user and round through
  `attempt_logs → learning_sessions`. It uses `on conflict (legacy_feedback_id) do nothing`.
- A one-time backfill copies the existing rows the same way.
- Order inside the migration: `CREATE TRIGGER` first, then the backfill.
  - `CREATE TRIGGER` takes a `SHARE ROW EXCLUSIVE` lock on `ai_feedback`, which blocks concurrent
    INSERTs until commit.
  - Rows committed before the lock are seen by the backfill statement (READ COMMITTED takes a new
    snapshot per statement).
  - Rows inserted after commit fire the trigger.
  - So every row is copied exactly once (test 60).
- The backfill is also exposed as an idempotent, operator-only function
  `fn_copy_legacy_ai_feedback()`, for use if the trigger is ever removed.
- **Result:** an old writer can still delete `ai_feedback` rows, but every one of them was already
  copied when it was inserted. Nothing the new app reads is reachable by an old DELETE.

### 6.3 Writer RPCs (P4)

All are service role only. All take the per-round lock first (§10.2).

| RPC | Rule |
|---|---|
| `fn_explanations_begin(user, round, targets[], prompt_version, model)` | Validates the targets (owned by the round, 1–35, distinct; else `invalid_targets`, nothing written). A live `started` operation with the same `op_key` → `in_progress{operationId}`. Any other live `started` operation in the round → `busy` (one live batch per round, so overlapping batches never pay twice). Otherwise inserts the operation (`seq`, new token, lease 120 s) → `started{operationId, token, seq}`. |
| `fn_explanations_finish(user, round, operationId, token, items jsonb)` | Locks the operation row. The **payload hash is computed in SQL**: `sha256` of the items' `jsonb` text, aggregated in `attempt_id` order. Then: **accepted** with the same hash → `already_saved` (no write); accepted with a different hash → `conflict` (stored rows unchanged). **Token ≠ `lease_token`** → `invalid_token`. **`abandoned`** → `invalid_state`. An item whose attempt is not in `target_attempt_ids`, or an empty explanation → `invalid_payload`, nothing written. Otherwise all items are inserted in one transaction with the operation's `seq`, and the operation becomes `accepted` with its hash; the lease is cleared → `saved{count}`. **A late finish after lease expiry is accepted when the token matches** (ordering is decided by `seq`, below). |
| `fn_explanations_abandon(user, round, operationId, token)` | Provider or admission failure. A matching `started` operation → `abandoned`. Saved rows are never touched. |

**Same operation, same payload** → `already_saved`. **Same operation, different payload** →
`conflict`. Both are enforced by the database (the operation row and
`unique (operation_id, attempt_id)`), not by the client or Redis.

### 6.4 Which explanation is shown (read-only)

**Effective explanation of an attempt:** among its `attempt_explanations` rows, the first by
`seq desc nulls last, created_at desc, id desc`.
- `seq` is allocated when an operation **begins**, under the per-round lock. A late recovery of an
  older operation (lower `seq`) therefore **never displaces** a newer operation's note, even though
  it is inserted later (test 63).
- Legacy copies (`seq` null) rank below every new-mechanism note. Among themselves the newest
  `(created_at, id)` wins.

**Repeated error patterns after reload** (no stored mapping is needed)
- `patternKey(attempt) = normalizeText(expected, "relaxed") + "\u0000" + normalizeText(user,
  "relaxed")`. This is the same key `buildPatterns` uses today (§1.6), moved to a shared module.
  It is computed at read time from the immutable attempt texts.
- For each sentence's displayed attempt:
  1. it has its own effective explanation → shown;
  2. otherwise, an attempt **in the same round** with the same `patternKey` has one → shown as
     "Same mistake as sentence N", linking to that sentence's note. When several match, the one
     with the newest effective note wins, using the same order;
  3. otherwise → unexplained.
- No reuse across rounds, users, videos or by text similarity.
- **Explanation targets** (§7.2) count a pattern as explained when step 1 or step 2 finds a note.

| Case | Behaviour |
|---|---|
| Attempt = the sentence's latest wrong answer, still incorrect | Current |
| Earlier wrong answer (later changed or corrected) | Historical: "Earlier mistake (now corrected)" / "Earlier answer" |
| No explanation for a current wrong pattern | Offered via "Explain more" (§7.4) |
| Legacy copy, or a note from an older `prompt_version` / `model` | Viewable, labelled "earlier explanation". **Never regenerated automatically**. "Re-explain with the current version" is an explicit, costed action |

### 6.5 Writers and readers after P4

- **explain-all:** begin → the existing provider call and quota → finish (or abandon). It no
  longer touches `ai_feedback`. The overview path is unchanged until P5.
- **`/api/ai/explain`:** cache lookup = the effective explanation; texts come from the attempt row,
  not the request body; begin/finish with a single target (`source='single'`). No client caller is
  known.
- **The report GET** reads `attempt_explanations` only (its legacy rows included) through the
  owner RLS client. It never writes.
- P4 adds no recovery route; that is P5 (§8.4). In P4, a finish that fails after a provider success
  loses that batch, as today, but **never removes** an earlier note.

### 6.6 P4 deployment and rollback

**Deploy**
1. Apply the migration. The old app keeps working unchanged: it still writes `ai_feedback`, and
   the trigger copies those rows.
2. Operator check: `count(ai_feedback with attempt_id)` = `count(attempt_explanations where
   source='legacy_ai_feedback')`.
3. Deploy the app.

**Mixed versions (old and new app instances at the same time)**
- Old explain-all: its DELETE reaches only `ai_feedback`; its INSERT is copied.
- New writers: write only the new table.
- No interleaving can remove a row from `attempt_explanations` except attempt or round deletion.
- **Evidence:** PG tests 55, 59 and 60 run the literal old statements against the migrated schema.
  The claim holds only once they pass.
- Known limitation: an old-app reader (it reads `ai_feedback`) does not show notes created by the
  new app.

**Rollback**
- App revert only. The migration stays; tables and trigger are never dropped by a rollback.
- The old app reads `ai_feedback`: legacy notes are shown, notes created by the new app are not
  (they are kept and reappear on roll-forward).
- Old-app writes during the rollback are copied by the trigger.
- If the trigger itself ever has to be removed, that is a forward migration and an explicit
  operator choice; `fn_copy_legacy_ai_feedback()` then catches up.

**Uniqueness on `ai_feedback` is no longer planned.** The table is legacy input.

---

## 7. Layer C — AI input, batching and coverage

### 7.1 Server metrics (authoritative, labelled)

`latestAnswerCorrect`, `validSubmissionCorrectness` ("correct answers across all valid
submissions", never "accuracy"), `currentlyIncorrect`, `corrected`, `distinctEverIncorrect`,
`eligibleSentences`, `historyComplete`, and `firstTry` when available.

The prompt states: "These figures are final; explain, do not recompute or rename."
`learning_sessions.accuracy` is no longer sent.

### 7.2 Units

- **Overview evidence:** every currently-incorrect and corrected sentence.
- **Distinct error patterns:** `patternKey` (relaxed-normalized `(reference, answer)`, §6.4),
  spacing-only excluded.
- **Explanation targets:** distinct patterns without an effective note (§6.4). One explanation is
  stored on the first occurrence's attempt; repeats map to it by `patternKey` after reload.
- **Explanations returned:** valid notes per target.

### 7.3 Budgets

- **Input:** the overview gives sentences **individually**, in priority order, until
  `AI_INPUT_CHAR_BUDGET` (default 60,000 characters) is reached. Long answers are trimmed to the
  differing spans ±6 words.
  - The rest go in as **aggregate counts** by observation category.
  - Disclosure: "Gemini saw 52 sentences individually and 28 only as counts."
  - The deterministic metrics are always complete.
  - Characters → tokens is an **estimate**. The provider's `usageMetadata` is logged, and
    `finishReason=MAX_TOKENS` is treated as truncated.
- **Explanation batch size** = min(**35**, the output-budget fit):
  `floor((maxOutputTokens − reserve) / AI_TOKENS_PER_EXPLANATION)`.
  - 35 stays the conservative cap, consistent with the current code. It is a **ceiling, not a
    guarantee**.
  - 80 targets mean batches of **35, 35, 10** if each fits the budget; smaller if not.

### 7.4 Actions and costs

- **"Generate assessment"** = the overview plus the first batch (≤ 35) in one provider call, plus
  at most one **metered** parse retry. Label: "Uses up to 2 AI requests."
- **"Explain more"**
  - Selects the next ≤ 35 **missing** targets in priority order; the user may also pick specific
    sentences.
  - **Explanations only**: the overview is not regenerated, and existing valid explanations are
    kept.
  - Each note is tied to its target attempt. Corrected or superseded answers keep historical
    notes, labelled as such.
  - Label: "Explain next 35 of 45 — uses up to 2 AI requests."
  - No automatic loop over the remaining batches.
- **"Update assessment"** (data changed) and **"Regenerate"** (same data, older `prompt_version`
  or `model`, §8.2) regenerate the overview plus the first missing batch. Their labels show the
  same maximum cost. Neither is ever triggered automatically.
- **"Re-explain with the current version"** (explicit, user-selected targets ≤ 35) is the only way
  older-version or legacy notes are replaced; the replacement wins by `seq`, and the older notes
  stay stored.

### 7.5 Output and validation

**Schema**
- Overview op: `overview`, `strengths[]{text, evidenceIds≥1}`,
  `priorities[≤3]{title, explanation, evidenceIds≥1, practice}` (three is a UI summary, not an
  analysis limit), `practicePlan[≤3]`, `limitations[]`, and `sentenceNotes[]` for the batch.
- Explain-more op: `sentenceNotes[]{targetId, explanation, correctedText, example?}` only.

**Validation** (hand-written; no `zod`)
- The shape must parse.
- Ids must belong to the request and to the right kind: strengths cite `correct_evidence` or
  `corrected`.
- A duplicate id keeps the first; unknown ids are dropped; empty explanations are dropped.
- A strength without evidence is dropped.

**Coverage shown:** statistics (all sentences) · individually sent · aggregate-only · requested
targets · valid notes returned · reused saved notes · still unexplained. Example: "Explained 31 of
35 requested; 4 missing." Never shown as complete when it isn't.

**Prompt safety:** a system instruction says all content inside `data` is untrusted text; learner
and transcript text are JSON-encoded.

---

## 8. Generation, idempotency and recovery

### 8.1 Identities (kept separate)

| Identity | Definition | Decides |
|---|---|---|
| Learning-data fingerprint | `sha256(canonical metrics + evidence state of valid attempts)`. The same for every operation on that data | **Freshness** ("based on current learning data") |
| Content version | `prompt_version` (int, raised for every prompt or schema change) + `model` | **Whether a saved result matches the current generator.** Never decides freshness |
| Overview operation | `(round_id, generation)`, allocated in `begin` (§8.2) | Ordering and acceptance |
| Explanation operation | `explanation_operations.id`, plus `seq` for ordering (§6.3) | Idempotency and ordering |
| Explanation `op_key` | `sha256(sorted target ids + prompt_version + model)` | `in_progress` detection only |
| Provider attempt | 1 = call, 2 = parse retry | Quota (§9) |

A request for a **different** batch has a different operation and `op_key`, so it can never be
answered by another batch's result.

### 8.2 Overview: database generation ordering (P5 migration, next free number after P4's)

**Table `round_assessments`** (`round_id` pk → `learning_sessions` on delete cascade, `user_id`):
- `latest_started_generation int not null default 0`;
- the lease for the latest started generation: `lease_token uuid`, `lease_fingerprint text`,
  `lease_prompt_version int`, `lease_model text`, `lease_expires_at timestamptz`;
- the accepted result: `accepted_generation int null`, `accepted_token uuid`,
  `accepted_fingerprint text`, `accepted_prompt_version int`, `accepted_model text`,
  `accepted_payload_hash text`, `accepted_payload jsonb`, `accepted_meta jsonb`, `accepted_at`;
- `updated_at`.

The accepted identity and hash are **retained**, so duplicate finishes and conflicts can still be
checked after the lease is cleared. The payload hash is computed in SQL from the `jsonb`
(payload, meta).

**Transitions** (security-definer RPCs, service role only; per-round lock first, §10.2; then the
`round_assessments` row is created if missing and locked):

| Event | Rule |
|---|---|
| **begin**(fp, pv, model) | 1. `pv < accepted_prompt_version` → `outdated_app` (no call, no charge; an older instance must not replace a newer prompt's result). 2. Accepted `(fp, pv, model)` all equal → `reuse`. 3. Live lease with equal `(fp, pv, model)` → `in_progress`; a live lease with anything different → `busy`. 4. Otherwise `latest_started_generation + 1`, a new token, lease 120 s → `started{gen, token}`. A start after an expired lease supersedes the old worker. **Creating the row or starting a generation never changes the accepted result or the legacy column.** |
| **finish**(gen, token, fp, pv, model, payload, meta) | 1. `gen = accepted_generation`: same token **and** same hash → `already_accepted`; same token, different hash → `conflict` (stored result kept); different token → `invalid_token`. 2. `gen < latest_started_generation` → `superseded`. 3. `gen > latest_started` → `invalid`. 4. `gen = latest_started`: the token, fp, pv and model **must equal the lease's**, **even when the lease has expired**; otherwise `invalid_token`. 5. `pv < accepted_prompt_version` → `outdated_app`. Then accept: write `accepted_*`, mirror the legacy column (§10.2), clear the lease. Late completion after expiry is allowed **only** in branch 4, i.e. when no newer generation has started. |
| **abandon**(gen, token) on provider or admission failure | Clears the lease if it matches. The accepted result is untouched. |
| Lease expiry | Passive: the next begin supersedes. |
| DB write failure | Finish didn't commit, so the client holds a recovery token (§8.4). |
| Recovery | Calls **the same finish** with the same arguments. |

**Freshness and version are shown separately** (read-only; computed at GET time):

| Accepted fp = current fp | Accepted `(pv, model)` = server's current | Shown |
|---|---|---|
| yes | yes | "Based on your current answers" |
| no | any | "Practice changed since this assessment — Update (uses up to 2 AI requests)" |
| yes | no | "Made with an earlier assessment version — Regenerate (uses up to 2 AI requests)" |

- Neither state ever starts a call by itself. Only the explicit, costed POST does.
- A corrected prompt (higher `pv`) on unchanged learning data fails rule 2 (`reuse`), so the POST
  starts a new generation instead of returning the old result.
- A model change alone is handled the same way: offered, never automatic.

### 8.3 Explanation batches

- Storage, ordering, idempotency and pattern mapping are defined in §6.2–§6.4 (built in P4). P5
  adds batching, budgets (§7.3), quota admission (§9) and recovery (§8.4) on top of the same RPCs.
- **Concurrency is decided in the database:** `fn_explanations_begin` returns `in_progress`
  (same `op_key`) or `busy` (another live batch in the round). **The Redis lease from the earlier
  draft is dropped.**
- **"Generate assessment"** = one provider call serving two operations: overview `begin`, then
  explanation `begin` for the first batch, in that order.
  - Both are finished separately, overview first. Each result is reported on its own, so a partial
    save is shown honestly.
  - If the explanation begin returns `busy` or `in_progress`, the call is made for the overview
    only, and the UI says so.
- **Partial results:** valid notes are saved; missing targets stay "unexplained"; existing notes
  are never removed.

### 8.4 Recovery and read-only GETs (P5)

- **Report GETs stay read-only.** A route test asserts that no `rpc` other than
  `fn_round_report` runs, and no insert, update or delete.
- On provider success the route returns the payload plus a **signed recovery token**. It reuses the
  `src/lib/practice/recoveryToken.ts` HMAC pattern with a distinct purpose prefix
  (`ai-recovery:v1`). The token signs **every** field that affects stored content:
  - `userId`, `roundId`, `operation`;
  - for the overview: `generation`, `leaseToken`, `fingerprint`;
  - for explanations: `operationId`, `leaseToken`, the target ids;
  - `promptVersion`, `model`, `sha256(payload)`, `sha256(meta)`, `exp` (24 h).
- A combined call carries one token per operation.
- `POST /api/session/[id]/assessment/recover`:
  - authenticated; checks ownership;
  - verifies the token and the submitted payload/meta against the signed hashes;
  - calls the **same** finish RPC (`round_assessments` finish or `fn_explanations_finish`);
  - never calls the provider and never charges quota.
- **Idempotency is the database's:** same operation and payload → `already_accepted` /
  `already_saved`; same operation, different payload → `conflict`; an older overview generation →
  `superseded`; an older explanation batch is saved but ranks below newer notes by `seq` (§6.4).
- **Client:** recovery entries live in sessionStorage keyed
  `ai-recovery:<userId>:<roundId>:<operation>:<id>`.
  - They are cleared on `saved`, `already_saved`, `already_accepted`, `superseded` or `conflict`.
  - Sign-out clears the prefix.
  - Polling and recovery are cancelled on unmount, round change, sign-out and account switch.
  - Responses are applied only if their `(userId, roundId)` matches the current scope (the same
    guard pattern as `acceptsOrigin`).

| Failure | Result |
|---|---|
| Provider ✓, DB ✗ | Shown with "Not saved yet — Save" (one automatic retry) |
| Provider ✓, Redis ✗ | Irrelevant to the result; admission happened before the call |
| Redis ✗ and DB ✗ | Same as DB ✗ |
| Reload | sessionStorage still holds the entry; Save is offered |
| Token expired, or the tab and storage cleared | Lost; the quota was spent (stated in help) |
| Newer overview generation started or accepted | `superseded`; the client copy is discarded |
| Older explanation batch recovered after a newer one | Saved; the newer notes stay effective |

**Durability:** saved once the DB write succeeds, directly or by recovery within 24 h from the
same browser. **Not** guaranteed otherwise. A failed generation or recovery never removes the last
saved assessment or explanation.

---

## 9. Quota admission (P5)

**Limits**
- **Application:** `GEMINI_RPM_LIMIT`, `GEMINI_RPD_LIMIT` (shared), optional
  `GEMINI_USER_RPD_LIMIT` (default **unset = equal to shared**; no per-user value is assumed).
- **Provider:** an operator check.

**Admission identity** (server-generated only; client ids are never authority):

`<env>:<operationType>:<operationId>:<providerAttemptNo>`

| Operation | `operationId` |
|---|---|
| Assessment overview | `overview:<roundId>:<generation>` |
| Explain more (and the batch inside "Generate assessment" uses the overview's id) | `explanations:<roundId>:<operationId>` |
| Single explanation | `explain:<roundId>:<operationId>` |
| Translation | `translate:<transcriptId>:<lang>:<chunkHash>:<serverNonce>` |

- `env` = deployment environment name.
- Users, rounds and operation types can't collide.

**Atomic Lua script (Upstash `EVAL`)**
- If `adm:<id>` exists, return its recorded outcome with **no new charge**.
- Otherwise check RPM, shared RPD and user RPD together. If all pass, increment all of them and
  set their TTLs, then `SET adm:<id> reserved EX 86400`. If any fails, charge nothing.

**Policy**
- **Order:** DB `begin` (which allocates the generation or operation id) → admission → provider
  call. If admission is denied, the route calls `abandon` and charges nothing.
- Every real provider attempt costs 1, including parse retries (attempt no. 2 = a separate
  admission).
- Timeouts and ambiguous network outcomes count as spent.
- **A reused reservation never authorizes another provider call.** A route that finds
  `adm:<id>` already reserved does **not** call the provider again. It returns `in_progress`, or
  `unknown_outcome` ("Try again" starts a new operation with a new charge, shown to the user).
- If no capacity remains for the parse retry, skip it and report "AI response couldn't be read".

**Window:** recommended calendar-day keys `rpd:<YYYY-MM-DD>` in `GEMINI_QUOTA_TZ`. The provider's
reset time must be confirmed by the operator. The UI shows "N AI requests left today (shared app
limit) · resets at <time>".

**Redis unavailable**
- **Production (`NODE_ENV=production`): always fail closed** for new Gemini calls (503 "AI
  temporarily unavailable"). The dev fail-open flag is **ignored in production**.
- Layers A and B and reading saved explanations stay available.
- Non-production: fail-open only with `GEMINI_QUOTA_FAIL_OPEN=true`.

**Tests**
- The **real Lua script** runs against a local Redis-compatible server, or an equivalent real
  `EVAL` executor, in an integration test.
- Cases: concurrent admissions never exceed the caps; two rounds with the same generation number
  don't collide; different users; translation vs assessment ids; a parse retry charged
  separately; a lost admission response then a retry with the same id → no double charge and no
  second provider call.

---

## 10. Contracts, schema and compatibility

### 10.1 Report contract additions

| Field | Status |
|---|---|
| `scope{…, transcriptVersion}` | API change (one join) |
| `completion`, `history`, `coverage` | available |
| `dictation{latestAnswerCorrect, validSubmissionCorrectness, validSubmissions, invalidSubmissions, currentlyIncorrect, corrected, distinctEverIncorrect}` | derivable plus an API change (valid counts) |
| `dictation.observations[]` | new TS module `src/lib/practice/dictationAnalysis.ts` |
| `listening{scope:'script_version', …, roundSittingsNewlyCoveredSec, roundSittingsObservedSec}` | API change (owner-readable tables) |
| `actions` (§5.4 table: kind, label, href, start rule, counts) | API change |
| `mistakes[].explanation{text, correctedText, example, via:'attempt'\|'pattern', viaSegmentIndex?, historical, promptVersion\|null, model\|null}` | P4 schema (`attempt_explanations`, §6.4) |
| `ai{overview, meta, acceptedFingerprint, currentFingerprint, fresh, contentCurrent, generating, legacy?, coverage}` | P5 schema; the legacy column is the fallback until a payload is accepted (§10.2) |

### 10.2 Per-round lock and legacy writer policy (P4 lock, P5 legacy rule)

**Per-round lock protocol (one rule for every AI writer)**
- The first statement of every AI write RPC is
  `select 1 from learning_sessions where id = p_round and user_id = p_user for no key update`.
  No row → `not_found`.
  - This covers: overview begin, finish and abandon; explanation begin, finish and abandon; the
    replaced `fn_persist_session_assessment`.
- `FOR NO KEY UPDATE` conflicts with itself and with the plain `UPDATE` the legacy writer performs.
  - It does **not** conflict with the `FOR KEY SHARE` lock that an `attempt_logs` INSERT takes on
    the round.
  - The attempt writers' own `UPDATE learning_sessions` (`037:1024-1030`) **does** wait for it.
    Provider calls never run inside these transactions, so the wait lasts only one short RPC.
- **The eligibility check and the write both run after the lock**, as separate statements in a
  volatile plpgsql function. Under READ COMMITTED each statement takes a new snapshot, so the check
  sees anything committed by the previous lock holder.
- **Lock order** is always `learning_sessions` row → `round_assessments` row →
  `explanation_operations` row. No AI RPC takes them in another order.
  - Attempt writers never lock AI tables.
  - The only other lock an AI RPC takes is the FK `KEY SHARE` on existing `attempt_logs` rows,
    which attempt writers never lock exclusively.
  - So there is no deadlock cycle (test 66 also runs an attempt write concurrently).
- P4 introduces the lock in the explanation RPCs. P5 adds the overview RPCs and the legacy rule.

**Legacy rule (P5 migration replaces `fn_persist_session_assessment`)**
1. Take the per-round lock.
2. If `round_assessments.accepted_generation is not null` for the round → return `false` (refused).
3. Otherwise, write the legacy column exactly as before → `true`.

**Overview finish (accept branch)** writes `accepted_*` and mirrors the overview into
`learning_sessions.ai_assessment` in the legacy shape (`verdict`, `strengths`, `weaknesses`,
`recommendation`), in the same transaction and under the same lock.

**Race "legacy A vs new B" (both orders, serialized by the lock)**
- **A holds the lock first:** A writes the legacy column and commits. B then accepts and overwrites
  the column with its mirror. Final state: B in both places.
- **B holds the lock first:** B accepts and commits. A then checks, sees `accepted_generation`, and
  is refused. Final state: B in both places.
- In the old tab, A is displayed but not saved: the old client ignores `assessmentSaved` (code), so
  it disappears on reload and B shows. The release notes say old tabs should be reloaded.

**Fallback (reader rule)**
- A `round_assessments` row with `accepted_generation is not null` → show the accepted result.
- Otherwise, when the legacy column is set → show it as "Earlier assessment (earlier format,
  freshness unknown)". **This includes rounds whose row exists only because a generation started,
  is in progress, was abandoned or has expired.**
- A row without an accepted payload never hides the legacy assessment, and the legacy writer still
  accepts writes for such a round.
- While a generation is in progress the legacy assessment stays visible with "Generating a new
  assessment…".

**P5 deployment order**
1. The P4 migration is already applied, and the P4 app deployed and verified.
2. Apply the P5 migration. The table is empty, so the replaced legacy RPC accepts every write, as
   before. The old app is unaffected apart from the lock, which only serializes.
3. Deploy the app.

**Mixed versions:** a round becomes new-only from its first **accepted** new generation, not from
its first begin.

**Rollback (app only)**
- The old app reads the mirrored legacy column, which holds the latest accepted result.
- **Limitation:** the old app can no longer save assessments for rounds with an accepted new
  generation (persist refused; output shown but lost on reload). Rounds without one keep working.
- Restoring old writes needs a forward migration that re-creates the unconditional function, an
  explicit operator choice.
- Tables are never dropped.

**Migrations**

| Phase | Migration |
|---|---|
| P0–P3 | none |
| P4 | **required, additive**: `explanation_operations`, `attempt_explanations`, the `ai_feedback` copy trigger plus backfill, `fn_copy_legacy_ai_feedback`, the explanation begin/finish/abandon RPCs |
| P5 | **required**: `round_assessments`, the overview begin/finish/abandon RPCs, the replaced `fn_persist_session_assessment` |
| Later (not planned) | Retire `ai_feedback` (drop the trigger and stop the backfill) once no old writer can run |

Both take the next free number, verified at implementation time; P5's number follows P4's.

---

## 11. Report UX

**Completion summary**
- An accomplishment sentence built from the metrics, e.g. "You completed 59 sentences. All are
  correct on your latest answer; 23 were corrected after earlier mistakes."
- 3–4 tiles, ≤ 3 priorities.
- The saved fresh AI overview (1–2 lines) if present.
- Actions from the **§5.4 table**, with "Full report" and "Open script".

**Full report** (`/results/[roundId]`, History)
- Summary, then tabs (ARIA tabs; ←/→/Home/End; `?section=` kept with `history.replaceState`, no
  navigation).
- **Dictation:**
  - the AI overview near the top, collapsible;
  - "Still needs review", or "Nothing left to review";
  - corrected sentences paged 5 at a time;
  - rows lead with **Your answer → Reference** and differences (§4);
  - recurring differences;
  - the history note.
- **Shadowing:** the existing `ShadowingSummaryView` / `ShadowingFeedbackSection` on the pinned
  revision.
- **Listening:** "Listening — this script version (all sittings)", plus "In this round's
  sittings: X newly covered". Note: "Coverage measures playback, not attention." Media time is
  kept separate from active time.
- **Study sessions:** History keeps its lazy session list. **Not added to the full report in
  P3** (deferred; the report shows the session count in its identity line).

**Labels**
- "Answers submitted: 92 · 2 empty answers not counted".
- "Correct on latest answer" (headline).
- "Correct across valid answers: 74%" (secondary).
- First try only when available, with hint and hint-unknown counts.

**Side panel (P0)**
- Remove the floating button on md+ in normal mode; show the top-bar toggle on mobile and remove
  the extra row; keep Zen.
- Add `aria-expanded` / `aria-controls`; "Open script" focuses the panel heading, and closing
  returns focus.
- One `showLearningPanel` state. Pause on open (exists); restore without autoplay; the checkpoint
  is untouched.

---

## 12. Phases

| Phase | Outcome | Modules | Schema | Acceptance criteria (§13) and tests | Rollback |
|---|---|---|---|---|---|
| **P0** Side panel | No redundant control; accessible toggle | `page.tsx`, layouts | — | 22–24; component and browser | revert |
| **P1** Deterministic Dictation report and labels | §4, §5.2, §11 labels | `dictationAnalysis.ts` (new), `RoundReportPanel`, report route, History / Library / Dashboard wording | — | 1–3, 12–14, 25–27, 33–34, 46; unit, component, PG (counts) | revert |
| **P2** Same-round continuation | §5.3–5.4 | resume route, page entry, auto-save guard, report `actions` | — | 4–7, 21, 28–30, 56–57; implicit-creation test first; PG and jsdom | revert |
| **P3** Report shell and sections | Tabs, compact summary, Listening, identity | shared `ReportShell` for `PracticeReportView`, `/results`, History | — | 8–11, 24; component and browser | revert |
| **P4** Saved explanations | New explanation storage isolated from old writers; operation identity; `seq` ordering; pattern mapping; per-round lock | report route, explain-all and `/api/ai/explain` writers, shared `patternKey` | **required, additive** (§6.2, §10.2) | 35–36, 55, 59–65, 71; PG (two real connections), mocked provider, route | §6.6 (app revert; tables and trigger stay) |
| **P5** AI assessment | Overview generations with content versions, Explain more, recovery, quota, legacy rule | explain-all rewrite, Lua admission, recover route, UI | **required** (§8.2, §10.2) | 14–20, 31–32, 37–45, 47–54, 58, 66–70, 72; PG (two real connections), real-Lua integration, mocked provider | §10.2 |
| **P6** Integration and rollout | | runbook, operator checks | — | browser, iPhone, operator | — |

**Dependencies:** P1 → P3. P0 and P2 are independent. **P0–P3 never wait for P4 or P5.**
- P4 → P5: the P5 migration assumes the P4 tables, RPCs and per-round lock. The P4 app must be
  deployed and verified (§6.6 operator check) before the P5 migration.
- P4 needs no Redis change and no quota change. It keeps the existing `checkGeminiQuota`, adds no
  provider calls, and adds no automatic calls.
- P5's quota (§9) gates every new P5 call.

### 12.1 Implementation status (2026-10-04, local only — not committed, not deployed)

**P0 — side panel: implemented.**
- The top-bar toggle shows at every width, with `aria-expanded` / `aria-controls="lesson-panel"`.
- The floating "Show lesson panel" button is now Zen-only.
- The panel is a labelled region; "Open script" moves focus to it.
- Pause on report open is unchanged.
- Tests: `practice-report-layout.test.tsx` (expanded state, no floating button outside Zen, focus).

**P1 — deterministic Dictation report and labels: implemented.**
- New `src/lib/practice/dictationAnalysis.ts`, implementing §4.1–§4.4:
  - stored correctness stays authoritative;
  - discrepancy wording follows the stored result, and a stored correct answer is "Accepted as
    correct when submitted", never "Marked incorrect";
  - explicit case/punctuation rules;
  - neutral legacy answers.
- The report route adds `dictationEvidence`, built from the rows it already reads (read-only).
- `RoundReportPanel`:
  - "Round complete" for every completed round, with a "(date estimated)" date when the timestamp
    was synthesized and a history note;
  - no "—" first-try tile; "Correct on latest answer";
  - answers submitted name the empty answers and show "correct across valid answers";
  - review priorities; rows lead with "You wrote → Reference";
  - corrected sentences paged 5 at a time.
- History, Library and Dashboard wording follow §5.2, with counts unchanged.
- Tests: `dictationAnalysis.test.ts` (the §4.1 cases, plus units and priorities);
  `round-report.test.tsx`; `phase6-routes.test.ts` (evidence; the GET makes no writes);
  `dashboard-library.test.tsx`.

**P2 — same-round Shadowing continuation: implemented.**
- New `src/lib/practice/roundActions.ts` (the §5.4 table, start rules, links) and
  `src/components/report/RoundActions.tsx`, used by the completion view, `/results` and History.
- `GET /api/session/resume`:
  - optional `roundId` (UUID-checked);
  - active round first, else latest started — no longer `updated_at`;
  - `newerActiveRound`.
- The report route adds `newerActiveRound`.
- Practice page:
  - `?round=&mode=shadowing&start=unrecorded|unscored|first` loads that round, switches to
    Shadowing and selects the re-derived start sentence;
  - a newer active round, an abandoned round or a missing pin shows a notice and hides practice.
- Auto-save always names the known round (the fix above).
- No SQL: the server already accepts takes on completed rounds without re-completing them.
- Tests:
  - `roundActions.test.ts`;
  - `session-resume-route.test.ts` (roundId, ordering, newer round, invalid id);
  - `practice-report-layout.test.tsx` (continue from the report; continuation link with
    `start=unscored`; newer-round notice; **regression for the implicit new round**, which fails
    with the guard removed);
  - real PostgreSQL `phase4-shadowing.integration.test.ts`: after Dictation completes the round, a
    Shadowing take counts in it, `completed_at` / status / provenance are unchanged, the checkpoint
    write is refused, and there is still one round.

**P3 — report shell and sections: implemented.**
- Summary block: accomplishment sentence, key tiles, top 3 priorities, actions.
- Dictation / Shadowing / Listening tabs (keyboard, `?section=` on `/results`, entry mode on the
  practice view, the Shadowing summary action switches tab).
- Identity line with the script version.
- The Listening section is labelled by its real scope (script version, all sittings), plus this
  round's own sittings.
- The report route adds `transcriptVersion` and `listening`, read-only.
- Tests: `round-report.test.tsx` (P3 block); `phase6-routes.test.ts` (fields, still only
  `fn_round_report`); `history-sessions.test.tsx` and `shadowing-report-section.test.tsx` (open the
  Shadowing tab first; lazy loading unchanged).

**Not done in P0–P3:**
- the study-session list inside the full report;
- browser and iPhone checks (§13 rows 22–24 and the layout rows) — pending.

**Verification (final code):**
- `tsc` clean.
- Lint: 0 errors and the same 3 existing warnings (one new warning was fixed rather than
  suppressed).
- Production build passes.
- Full Jest, in band, with the disposable local PostgreSQL: **1,627 passed, 113 skipped (Supabase
  HTTP suites — not run), 1 failed**.
  - The failure is `vocabulary-page.test.tsx` › "selection cap", a 30 s timeout. That file and the
    vocabulary page are unchanged, and the same test also failed on a clean `HEAD` checkout in the
    earlier investigation (`.claude/shadowing-summary-audit.md` §0). The cause is still unknown.
- Not verified: browser, iPhone, Supabase HTTP, production.

### 12.2 P2 follow-up — Round menu and one new-round flow (2026-10-04, local only — not committed, not deployed)

**Problem.** An active round's report could only be opened by reaching the end of the video. Once
the learner was practising inside a completed round, "Practice again — new round" was hard to
reach.

**Placement**
- One **Round menu** in the practice page's top bar, before Settings.
  - From `sm` up the trigger reads "Round N ▾" (or "Round ▾" when the number is unknown).
  - Below `sm` it reads "Round ▾".
  - At every width its accessible name names the round and its state, e.g. "Round menu — Round 3,
    in progress".
- Zen mode: the same menu sits beside "Exit Zen Mode" in the existing Zen controls.
- No floating button and no new mobile row.
- Model and handlers are shared by every layout: `src/lib/practice/roundMenu.ts` (rules) and
  `components/RoundMenu.tsx` (menu button: ↓/↑/Home/End, Escape closes and returns focus, outside
  click closes).

**Menu actions** (`roundMenuModel`)

| State | Items |
|---|---|
| Round on screen (active, completed or ended) | "View round report", "Practice again — new round" |
| Newer active round exists (outdated view) | "View round report", "Go to current round (Round N)" — no new-round item |
| Recording running | both disabled: "Stop recording to view report." / "Stop recording to start a new round." |
| Restart in flight | new round disabled: "Starting a new round…" |
| Resume lookup loading / failed | both disabled, explained; no round id is guessed |
| No round (e.g. Listening-only) | both disabled; note: "Listening doesn't start a practice round …" — nothing is created |
| Signed out | both disabled |

**View round report** (any round, including active)
- Opens the existing report view in place.
- Read-only:
  - loads the current round's report (its pinned script) through the existing GET;
  - no submit, no start/restart/complete, no provider call.
- Shows "Round report" and "Round in progress" for an active round.
- Confetti only when this page's server-confirmed completion opened the report, never from the
  menu.
- Playback pauses (existing effect).
- The practice view stays mounted, hidden, so these are kept: mode, sentence, playhead (no
  autoplay on return), answer draft, clip, take/evaluation state and panel layout.
- Focus moves to the report heading; "Back to practice" returns it to the menu trigger.
- Load errors show Retry; "Back to practice" is always present.

**One new-round flow** (`useNewRoundFlow` + `components/NewRoundDialog.tsx`)
- Used by the Round menu (top bar and Zen), the completed-round card, the active-round resume card
  ("Restart" is now "Start new round") and the report's "Practice again — new round".
- `window.confirm` is no longer used for new rounds.
- Wording:
  - completed / ended: "Start a new round? Your previous round and reports will remain in History.
    Progress starts from zero."
  - active: "End this round and start a new one? Your current answers and results will remain in
    History. The new round starts from zero."
- Buttons "Start new round" / "Cancel"; Cancel and Escape send nothing.

**Pending local work** (`newRoundConfirmation`)

| Situation | Handling |
|---|---|
| Recording running | Blocks: "Stop recording first." Nothing is stopped or discarded for the learner. |
| Dictation answer being checked/saved | Blocks until the existing bounded request settles. |
| Take save in flight | Blocks until it settles (the button re-enables by itself). |
| Take save failed / score recovery pending | "Retry saving" (same client attempt id, same round) or tick "Discard them and continue". The discard is applied **only after** the server confirms the new round. |
| Unsent Dictation draft | Disclosed: "Your unsent answer for this sentence will be discarded." |
| Azure evaluation running | Disclosed, not blocked. It is never resubmitted; the late result stays keyed to its own attempt and round (existing attempt-scoped writes). |

**Restart request**
- Exactly one request per confirmation.
- Repeated clicks are stopped twice: the button is disabled while in flight, and an in-flight
  guard in `restartRound`.
- No automatic retry.
- The server is already retry-safe: `fn_restart_round(video, expected round)` returns the round
  an earlier attempt created, with `created:false`.
- If `created:false` names a different round, the page changes **nothing** locally. The dialog
  says "A newer round is already in progress" and offers "Go to current round". It never shows
  that round as a fresh one.

**On success** (server-confirmed only)
- Adopts the returned round id and number.
- Clears the round-local state of the old round (scores, combo, snapshot).
- Keeps the selected mode.
- Dictation/Shadowing: back to the first sentence, paused, with the existing start rules (the
  "Start Dictation" card, or Shadowing's auto-enter, which saves into the new round).
- Listening: the playhead, coverage and checkpoint are untouched.
- Clears the old sentence's draft and clip.
- Refreshes report, History, Library and Dashboard through `invalidateLearningViews` (old and new
  round).
- Buffered activity and pending takes keep the round they were observed in (existing tagging).

**On failure:** nothing local changes; the dialog shows "… Your current round is unchanged."

**Confirmed defect, fixed:** with the report open, the practice keyboard shortcuts still acted on
the hidden player and recorder:
- Space play/pause, Shift+Space replay and Shift+←/→ in every mode;
- R record and Shift+E evaluate in Shadowing.

`useKeyboardShortcuts` now takes `suspended` (report or new-round dialog open) and ignores keys
pressed inside menus and dialogs. Escape still leaves Zen.

**Changed:**
- new `src/lib/practice/roundMenu.ts`, `useNewRoundFlow.ts`, `components/RoundMenu.tsx` and
  `components/NewRoundDialog.tsx`;
- `page.tsx`, `useDictationSession.ts` (`restartRound` outcome, `roundNumber`,
  `resumeLookupFailed`, `restartPending`; `handleRestart` kept as the fire-and-forget form), and
  `api.ts` (`created` and `roundNumber`);
- `useShadowingRecordings.ts` (`pendingWork`, `retryUnsaved`, `discardUnsaved`);
- `useKeyboardShortcuts.ts`;
- `PracticeReportView.tsx` (`autoFocus`; "Round report" for an active round).

No SQL, no migration, no configuration change.

**Tests**
- `roundMenu.test.ts` (10): menu states, wording, guards.
- `practice-report-layout.test.tsx`: a new describe block of 15 tests on the real page, covering:
  - active report before the end, read-only, paused, everything restored, focus;
  - no repeated confetti;
  - the shortcut defect;
  - recording disables the report;
  - clip and pending evaluation kept, with no second save or Evaluate and the late score on its own
    attempt;
  - Listening without a round;
  - load error, Retry and back;
  - card and menu share the dialog; Cancel and Escape; three clicks → one request; fresh round and
    cache refresh;
  - active wording, draft note and failed restart;
  - failed take: Retry (same id) or discard after success;
  - a save in flight blocks;
  - `created:false`;
  - Listening progress untouched;
  - an outdated view offers the current round;
  - keyboard and Zen;
  - the resume card and the report action.
- Existing test 8 now uses the dialog.
- `phase3-submission-client.test.tsx`: concurrent `restartRound` → one request; `created:false` is
  not adopted.
- Real PostgreSQL, `phase3-authoritative.integration.test.ts`: a new round from a **completed**
  round is created once; a retried request returns it (`created:false`); the completed round keeps
  its status and `completed_at`; the new round has no attempts.
- Mutation checks:
  - removing the shortcut suspension, the menu confetti guard or the in-flight guard each fails
    its test;
  - removing the in-flight guard alone is still blocked in the UI by the disabled button, so the
    hook test covers it.

**Verification (final code)**
- `tsc` clean.
- Lint: 0 errors, the same 3 existing warnings.
- Production build passes.
- Integration suites against the disposable local PostgreSQL 17 (`phase3-authoritative`,
  `phase4-shadowing`, `history-by-video`, `phase5-listening`): **67 passed**.
- Full Jest (no database URL, so the 20 PostgreSQL suites skip): **128 suites passed, 1,495
  passed, 273 skipped, 0 failed**. The known vocabulary "selection cap" timeout did not occur in
  this run.
- **Not verified:** browser, iPhone, Supabase HTTP, production. jsdom checks no CSS layout, so
  narrow-width overflow is a manual check (`supabase/PHASE6_RUNBOOK.md` §8, item 3b).

**Limits**
- The round number is unknown, so the trigger reads "Round", for a round the page created itself
  in this visit (save-progress returns no number); it is known after a reload or a restart.
- Late Listening and activity batches keep their observed round through the existing flush
  tagging, covered by the existing Phase 5 tests; no new test for them here.

### 12.3 Fix — earlier rounds' reports after a new round (2026-10-04, local only)

**Reported:** after round 2 was created, round 1's report could no longer be opened.

**Root cause** (reproduced): **navigation**, not data, authorization, SQL, rendering or cache.
- These all serve round 1 correctly with round 2 active, as its owner:
  - the report route's reads, `fn_round_report(round 1)` and `fn_history_video_rounds` (real
    PostgreSQL);
  - `/results/<round 1>`;
  - the History round selector (component).
- Two entry points only knew the video's **current** round:
  - the Library/Dashboard card showed "Review report" only when the current round was completed,
    so the link vanished as soon as round 2 started;
  - the History card's "View report" opened round 2.
- Round 1 was reachable only through History → "Rounds and sessions" → Round 1.
- This code predates P0–P3 (unchanged since `HEAD`); the new Round menu just makes round 2 easy to
  create.

**Fix** (app-only, no migration):
- Library card: "Past reports" → `/history?reports=<videoId>` when the current round isn't
  completed but a completed round exists.
- History card: "Earlier round reports" when the current round isn't completed and there are
  other rounds.
- Both open the card on the newest earlier completed round, from the server's own list.
- History reads `?reports=` once.
- No redirect, no round switching, no writes. The practice page's Round menu still opens the round
  being practised.

**Tests**
- `dashboard-library.test.tsx` (+2).
- `history-sessions.test.tsx` (+3: earlier report with its own transcript and metrics, no
  continuation, explicit "Go to current round"; `?reports=`; out-of-order responses never mix).
- `round-report.test.tsx` (+1: `/results/<round 1>` with a newer round — no redirect, GET only).
- Real PostgreSQL, `historical-round-report.integration.test.ts`: own report and distinct metrics,
  pinned revisions, History lists both, another user reads neither, reads change nothing.
- The three navigation tests fail with the fix disabled.

**Verification**
- tsc clean; lint: 3 existing warnings; build OK.
- Full Jest: 128 passed, 21 skipped (PostgreSQL), 0 failed; 1,501 tests passed.
- PostgreSQL suites `historical-round-report`, `history-by-video` and `phase6-library`: 30 passed.
- Browser/iPhone: not done (runbook §8, History).

### 12.4 Report navigation — one report label, round selector on the report page (2026-10-04, local only)

**This replaces the §12.3 entry points:** the Library card's "Past reports", the History card's
"Earlier round reports" and History's `?reports=` deep link are removed.

**Report links (one label everywhere: "Review report" / "View report")**
- **Library/Dashboard card:** "Review report" opens the card's round. That round follows the shared
  default rule of `fn_video_library` / `fn_history_videos`: the active round, else the latest.
  - Shown when that round is completed, or when an earlier round was completed (or a legacy
    completion exists).
  - With round 2 active and round 1 completed, it opens round 2's report, and the selector reaches
    round 1.
- **History card:** "View report" opens the default round, or the round explicitly chosen under
  "Rounds and sessions".

**Report page (`/results/<roundId>`)**
- The header shows "Round report", the video title and a **Viewing round** dropdown with the exact
  round count ("1 round" / "N rounds").
- Each option reads "Round N · In progress | Completed | Ended · started <date>"; dates use
  `toLocaleDateString`, like History.
- Ordering is newest first (started_at desc, id desc), the History order.
- The opened round is always selected and named, even when it isn't in the loaded page.
- With one round, the dropdown is disabled.
- The P3 identity line still shows that round's script version.
- **Source:** new `GET /api/history/videos/<videoId>/round-list?offset&limit`. It is a plain owner
  read of `learning_sessions` (RLS `learning_sessions_owner_select` plus `user_id` and video
  filters), `count: "exact"`, pages of 50 (`limit` capped at 100), with no RPC and no writes.
  - The History RPC (`fn_history_video_rounds`, capped at 100, no offset) is unchanged and not
    reused here, because it can't page.
  - "Show older rounds (N more)" loads the next page.
  - The query key sits under `["history-sessions", user]`, so the existing account-scoped
    invalidation refreshes it.

**Switching rounds**
- `router.push("/results/<id>?section=<current tab>")` → the canonical URL with the same section.
  Back, Forward and Reload work.
- The page body is keyed by round id. Per-round state (AI explanations fetched this visit, the
  assessment override) can't carry over, and a late response lands only in its own round's cache
  entry.
- While loading, the header names the new round (from the cached list); no metrics from another
  round are shown.
- Read-only: no round, restart, resume, last-mode, completion or provider call.

**Tests**
- `round-report.test.tsx` (+6, real page with a router mock): count and options, an older round
  selected while round 2 is active, switching (URL, section, metrics, script), Back/Forward/reload,
  delayed responses, one round, list error, 120 rounds with paging.
- `round-list-route.test.ts` (3).
- `dashboard-library.test.tsx` and `history-sessions.test.tsx` were rewritten: one label, no extra
  button, and the explicit History choice drives "View report".
- Real PostgreSQL: the route's list query under RLS (own rounds, exact total, another user sees
  none).
- Mutation checks: dropping `section` on switch, or dropping the "keep the opened round" merge, each
  fails a test.

**Verification**
- tsc clean; lint 0 errors (3 existing warnings); build OK.
- Full Jest: 129 suites passed, 21 skipped (PostgreSQL), 0 failed; 1,509 passed.
- PostgreSQL suites (`historical-round-report`, `history-by-video`, `phase6-library`): 30 passed.
- **No migration.**
- Browser/iPhone not done (runbook §8).

**P4–P5:** not started. Their review findings (§6–§10) stay as prerequisites.

**Deferred:** retention, snapshots, compaction, raw Azure payloads and audio
(`shadowing-summary-retention-plan.md`); Shadowing AI; cross-round aggregation; per-mode
completion; SQL consolidation; `ai_feedback` uniqueness.

---

## 13. Acceptance matrix

| # | Scenario | Expected | Layer |
|---|---|---|---|
| 1 | Pre-cutover round completed now | "Round complete", exact date, history note | component, PG |
| 2 | Synthesized completion timestamp | "Completed around … (date estimated)" | component |
| 3 | Fully current round | No note; first try and best run shown | component |
| 4 | Dictation 59/59, recordings 6/59, Azure 6/59 | Separate coverages; "Continue Shadowing (53 left)" | component |
| 5 | Continue Shadowing | `?round=` opens that round at the first unrecorded sentence; takes land there; no confetti | PG, jsdom |
| 6 | Newer active round when opening an old report | "Go to current round"; no recording | component, PG |
| 7 | Practice again | New round, fresh progress, old report intact | PG |
| 8 | History round switch | No non-GET requests | component |
| 9 | Pinned revision ≠ current | Pinned text; notice | component |
| 10 | Listening-only video | Script-version Listening in Library and History | component |
| 11 | Removed Library video | Reports reachable; stays removed | PG |
| 12 | First try unavailable | One line, no "—" tile | component |
| 13 | Nothing left to review, 23 corrected | Positive line; corrected list paged | component |
| 14 | 74% vs 100% | Separately labelled metrics | unit, mocked |
| 15 | Mistakes-only evidence | Unsupported strengths dropped | unit |
| 16 | Saved assessment reopened | No provider call | mocked |
| 17 | Same source, concurrent | One call; second `in_progress` | PG, mocked |
| 18 | Source changed | "Practice changed — Update" | unit, component |
| 19 | Quota exhausted / provider down | Layers A and B intact; last assessment kept | mocked |
| 20 | Invalid or malformed output | Dropped; coverage shows missing | unit |
| 21 | Shadowing recovery and late results | Own round; report refreshed | jsdom, PG |
| 22 | Closed panel | No floating button on md+; toggle works | component, browser |
| 23 | Report open | Playback paused; layout restored | browser |
| 24 | Desktop and mobile | No scroll traps; focus order | browser, iPhone |
| 25 | Exact historical timestamp | Not "verified"; neutral headline | component |
| 26 | Completed today with old attempts | "Round complete" plus note | component |
| 27 | Dashboard and Library wording | Matches the §5.2 predicates; counts unchanged | PG, component |
| 28 | `resume?roundId` | Returns that round even when not latest | PG |
| 29 | Leave midway and return | Re-derived start | jsdom |
| 30 | Newer round appears after report load | Notice; nothing recorded | jsdom |
| 31 | 80 distinct targets, cap 35 | Batches 35 / 35 / 10 (smaller if over budget); no auto loop; cost shown | unit |
| 32 | Response omits ids | "Explained 31 of 35"; missing stay unexplained | unit |
| 33 | Partial AI input | Deterministic statistics cover all mistakes | unit |
| 34 | Corrected errors | Never "unresolved" | unit, component |
| 35 | Saved explanation reused (own attempt or same pattern in the round) | No provider call | mocked, route |
| 36 | Explanation for an earlier attempt | Historical label | component |
| 37 | A-old / B-new finish reversed | A `superseded`; B kept | PG |
| 38 | Stale worker after lease expiry with a newer start | `superseded` | PG |
| 39 | Expired lease, **wrong token**, no newer start | `invalid_token`; nothing written | PG |
| 40 | Duplicate finish, same identity and payload | `already_accepted` | PG |
| 41 | Same identity, different payload | `conflict`; stored result kept | PG |
| 42 | Recovery after the lease was cleared by acceptance | Same-hash → `already_accepted` (via retained `accepted_token` and hash) | PG |
| 43 | Direct save vs recovery | Same RPC, same outcomes | PG |
| 44 | GET report | No writes | route |
| 45 | Redis failure after provider success | Result saved via the DB | mocked |
| 46 | Exact-mode case-only / punctuation-only / both / words; relaxed; legacy null; normalizer discrepancy | §4.1 outputs | unit |
| 47 | Explain more | New notes added; the overview and earlier explanations unchanged | mocked, PG |
| 48 | Two different batches with the same data fingerprint | Different operations and op keys; the second gets `busy` while the first is live; neither gets the other's result | PG, mocked |
| 49 | Quota ids: two rounds with the same generation, different users, translation vs assessment | No collisions | real-Lua integration |
| 50 | Concurrent admissions at the cap | Never exceeds it | real-Lua integration |
| 51 | Parse retry | Separate admission, charged | real-Lua, mocked |
| 52 | Lost admission response, then retry | No double charge, no second provider call | real-Lua, mocked |
| 53 | Production Redis down | Gemini routes 503 even with the fail-open flag; reports work | route |
| 54 | Delayed legacy A vs newer accepted B (sequential) | A refused; B kept in table and legacy column; A lost on reload in the old tab | PG |
| 55 | Literal old explain-all statements against the migrated schema: DELETE succeeds, INSERT fails | `attempt_explanations` and the report output unchanged; no cascade from `ai_feedback` | PG |
| 56 | All recorded, partly scored | "Continue pronunciation scoring"; `start=unscored`; re-record note | component, jsdom |
| 57 | Same-round vs new-round actions | Distinct labels; no implicit new round | component |
| 58 | Account switch during polling or recovery | Polling cancelled; the other user's entries are not read; late responses ignored | jsdom |
| 59 | Old writer inserts into `ai_feedback` (explain-all and `/api/ai/explain` statements) | Copied once; trigger and `fn_copy_legacy_ai_feedback` idempotent | PG |
| 60 | An `ai_feedback` INSERT on a second connection while the P4 migration body runs | Waits, then copied exactly once (not lost, not doubled) | PG (two real connections) |
| 61 | Explanation finish repeated: same operation, same payload (direct and via recovery) | `already_saved`; no new rows | PG |
| 62 | Same operation, different payload | `conflict`; stored rows unchanged | PG |
| 63 | Older batch (seq 1) finished or recovered after newer batch (seq 2) saved the same attempt | seq 2 stays effective; seq 1 kept as history | PG, route |
| 64 | Repeated pattern after reload (sentences 4 and 10, note stored on 4) | Sentence 10 shows "Same mistake as sentence 4"; not mapped across rounds; GET makes no writes | route, component |
| 65 | Foreign or duplicate targets, > 35 targets, items outside the targets, empty explanation | `invalid_targets` / `invalid_payload`; nothing written | PG |
| 66 | Legacy persist vs new finish, **genuinely concurrent**, both orders: one connection holds its transaction open while the other is shown waiting (`pg_locks` / `pg_stat_activity` wait event `Lock`), then commits; a concurrent attempt write is also included | B in the table and in the legacy column in both orders; no deadlock | PG (two or three real connections) |
| 67 | Generation started, in progress, abandoned or expired with no accepted payload | The legacy assessment is still shown (with "Generating…" while live); the legacy persist is still accepted | PG, route, component |
| 68 | Prompt version raised, learning data unchanged | "Made with an earlier assessment version — Regenerate"; the GET makes no call; the POST starts a new generation (charged); equal `(fp, pv, model)` → `reuse`, no charge | PG, mocked, route |
| 69 | Older instance (lower `prompt_version`) begins or finishes after a newer version was accepted | `outdated_app`; no provider call, no charge, nothing written | PG, mocked |
| 70 | Model change only | Regenerate offered, never automatic | unit, component |
| 71 | P4 rollback: old app statements against the migrated schema | Old reads and writes work; its writes are copied; notes created by the new app kept and shown again after roll-forward | PG |
| 72 | Combined "Generate assessment": overview saved, explanation finish fails | Overview accepted; the batch is recoverable on its own; UI reports it as not saved | mocked, PG |

---

## 14. Unresolved decisions

1. Whether legacy rounds completed after cutover count in `completedVideos`. No completion-evidence
   source exists.
2. A per-user AI limit value (default: unset).
3. Whether to refuse fresh takes into a superseded round server-side. That needs a trusted
   ordering signal, and recovery is unaffected either way.
4. The quota reset time zone, after the operator confirms the provider's reset time.
5. Raising the explanation cap above 35, after token-usage logs exist.
6. When `ai_feedback` can be retired (§10.2, "Later"). This needs evidence that no pre-P4 writer can
   still run in any deployment.
7. Whether an old-app rollback should also show notes created by the new app. Currently it does
   not; they are kept and reappear on roll-forward (§6.6).

---

## Tóm tắt (tiếng Việt)

**Báo cáo mới**
- Một vỏ báo cáo cho mỗi round, gồm Tổng quan · Dictation · Shadowing · Listening.
- Ghi rõ round và phiên bản script; nhãn hoàn thành trung tính.
- Phần lớp A (chỉ số, khác biệt "Bạn viết → Đáp án", câu còn sai / đã sửa, lỗi lặp lại, ưu
  tiên) chạy hoàn toàn **không cần Gemini**.

**Tiếp tục Shadowing**
- Thực hiện trong **cùng round**, mở bằng `?round=`.
- Vị trí bắt đầu được tính lại mỗi lần (câu chưa ghi âm, hoặc câu chưa chấm điểm). Đây không phải
  playhead đã lưu.
- Bị chặn khi đã có round mới đang hoạt động, khi round đã bỏ dở, hoặc khi thiếu pin.
- "Practice again — new round" luôn có nhãn riêng và không bao giờ tự tạo round.

**"Unverified"** chỉ nghĩa là round đã tồn tại trước khi theo dõi chi tiết. Timestamp chính xác
không chứng minh việc hoàn thành đã được xác minh.

**Gemini (tùy chọn)**
- Phần tổng quan gồm bằng chứng từng câu cộng với phần tổng hợp có công bố rõ.
- Giải thích theo lô tối đa 35 mẫu lỗi, tùy ngân sách token (80 → 35/35/10); "Explain more" không
  ghi đè tổng quan và không tự lặp.
- Giải thích mới lưu ở bảng riêng `attempt_explanations`, mà writer DELETE → INSERT cũ không chạm
  tới được. Mỗi dòng `ai_feedback` được trigger và backfill sao chép sang đó.
- Mỗi lô có một operation trong DB: cùng operation và cùng payload → dùng lại; khác payload →
  `conflict`. Thứ tự hiển thị theo `seq` cấp lúc begin, không theo thời điểm insert.
- Lỗi lặp lại được ánh xạ khi tải lại qua `patternKey` trong cùng round.
- Thứ tự thế hệ tổng quan nằm trong DB. Độ mới dữ liệu (fingerprint) tách khỏi phiên bản nội dung
  (prompt/model). Prompt mới chỉ đề nghị "Regenerate", không tự gọi.
- Mọi RPC AI và writer legacy cùng khóa dòng round (`FOR NO KEY UPDATE`). Assessment legacy vẫn
  hiển thị đến khi có payload mới được chấp nhận.
- Khôi phục bằng POST có chữ ký; GET chỉ đọc. Quota được giữ chỗ nguyên tử; ở production, Redis
  lỗi thì từ chối.

**Migration**
- P0–P3 không cần migration.
- P4 bắt buộc (chỉ thêm mới). P5 bắt buộc, chạy sau khi P4 đã deploy và kiểm tra.
- Cả hai dùng số trống kế tiếp khi triển khai.
- Nên làm P1 trước; P0 là việc nhỏ, làm song song được.
