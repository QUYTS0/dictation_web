# Shadowing lesson summaries and report-detail retention — plan

Status: **plan only**. Nothing here is implemented; no migration is created;
no data has been changed or deleted. Items marked **Recommended** are design
proposals awaiting implementation review; items marked **Established** describe
behavior that exists in the repository today.

Related: `.claude/video-learning-management-plan.md` (Phases 3–4 status, §6.7
score separation), `supabase/PHASE4_RUNBOOK.md` (§2a what is saved, §3/§3b
evaluation contracts).

---

## 0. Baseline (verified in the repository, 2026-09-28)

| Item | State | Evidence |
|---|---|---|
| Migrations `001`–`038` | applied to the user's project; `038` postflight passed | user-confirmed |
| Saved sentence-report restoration | committed `0e35634`, on `origin/main` | git |
| "N/M evaluated" fix (saved Azure only; denominator `requiredSentenceCount`) | committed `695448c`, **not pushed** | git |
| Production build | not verified here | — |
| Browser/iPhone verification of both fixes | not done | — |
| Next migration number | `039` is Phase 5's (`039_phase5_listening_activity.sql`); the Script Versions deletion migration (not created) takes a later number. New migrations here take the next free number at implementation time; no number is pre-claimed | main plan §8 table |

This track ("SS") is independent of Phase 5 (Listening) and Phase 6
(Dashboard/Library). Neither needs the other; §11 lists the only contact
points.

---

## 1. Focused audit — reuse and gaps

Established pieces inspected: `videoPracticeSummary.ts`
(`buildShadowingEvaluationSummary`, `savedAzureEvaluationFor`,
`practicePriorityFor`, `improvementLevelFor`, `trendFor`),
`EvaluationSessionSummary.tsx`, `VideoPracticeSummaryModal.tsx` (Overall /
Your improvement / Strengths / Words to practice / Sounds to practice /
Sentences to retry), `shadowingServerMerge.ts`, migration `025`
(`shadowing_attempts`) and `038` (detail columns, `fn_finish_azure_evaluation`
full-result idempotency, `fn_shadowing_round_results`), `037` coverage/completion
(`coveredSentences.shadowing`, combined completion), `azureSpeech.ts`
(`Granularity: Phoneme`, `PhonemeAlphabet: "IPA"`, `NBestPhonemeCount: 5`,
prosody on), `azureEvaluation.ts` (`AZURE_ENGINE_VERSION`, 96 KB detail thinning),
recovery tokens (TTL `AZURE_RECOVERY_TOKEN_TTL_SEC`, default 600 s).

| Existing capability | Reuse | Missing / defective | Proposed change |
|---|---|---|---|
| `fn_shadowing_round_results` (3 pointers + ≤ 5 compact Azure history per sentence) | the only read the summary needs in SS1–SS3 | history capped at 5 successful results/sentence; history words are `{word, accuracyScore, errorType}` without position | keep; document the cap as the improvement horizon. Positions: the representative result's full `azure_detail.words` keeps Azure's order (index = position). The history items are built with `jsonb_array_elements` without `WITH ORDINALITY`, so their order is preserved in practice but not guaranteed — SS3's migration adds an explicit `position` to history words (new function version; `038` untouched) before §6.6 relies on it |
| `savedAzureEvaluationFor` (saved-only predicate) | numerator + aggregates | — | keep as the single "evaluated" predicate |
| Representative result: server `latestSuccessfulAzureAttempt` = latest by attempt `created_at, id` | canonical rule | **client** `lastSuccessfulTrueEvaluation` follows *completion order* on the page — evaluating an older take after a newer one makes live and restored disagree | SS1: client promotes a newly saved result only if its attempt is not older than the current representative (compare attempt `createdAt`; attempt ids carried already) |
| `currentWordOccurrences` / `dedupedAttemptWords` | normalization (`normalizePracticeWord`: lowercase, edge punctuation) | **dedupe by word within a sentence** — the 2nd "the" in a sentence is dropped | SS1: occurrence identity = `(segmentIndex, position)`; group by word key across occurrences (§6.3) |
| `timelineByWord` + `trendFor` + word `improvements` | thresholds | **mixes sentences**: a word weak in sentence 2 and fine in sentence 9 is reported as "improved" | SS1: improvement only on comparable evidence (same sentence, same position, same engine version, §6.6); cross-sentence becomes "also seen OK elsewhere" |
| Omission / Insertion words (`accuracyScore` null) | — | silently skipped (null score) | SS1: separate "skipped words" / "extra words" evidence, never pronunciation errors |
| Prosody feedback per word (`breakErrorType`, `intonationErrorType`) | data exists | not aggregated | SS1: rhythm evidence (§6.4) |
| `practicePriorityFor` (0.55 severity / 0.30 error rate / 0.15 frequency) | keep formula | uses per-sentence dedupe counts | feed it corrected counts (§6.5) |
| Phonemes (IPA from Azure) | sound priorities | labelled as if verified IPA | label "Azure phoneme (IPA)"; only from actual phoneme arrays |
| `engine_version` column (`azure-short-audio-pa/v1`) | comparability key | never checked | SS1: improvement only within one engine version |
| Round completion (combined Dictation ∪ Shadowing, server) | unchanged | no "Shadowing done" notion | SS2: separate *Shadowing coverage* state from server `coveredSentences.shadowing`; no new completion source |
| Summary state | derived on every render from the page map | not durable; no finalization; no version | SS3: finalized summary rows (§7) |
| Detail storage | full `azure_detail` (≤ 96 KB) forever | no retention, no measurement | SS4 measurement + dry run; SS5 optional compaction |
| Full-result idempotency compares `azure_detail` | — | compaction would make a replay look like a conflict | SS5 fingerprint rule (§8.6) |

---

## 2. Concepts (Recommended definitions)

| | Concept | Definition | Source of truth |
|---|---|---|---|
| A | **Practice-round completion** | every eligible sentence of the pinned revision practiced by Dictation *or* Shadowing | server, `fn_*` (037) — **unchanged** |
| B | **Shadowing practice coverage** | distinct eligible sentences with a practice-valid Shadowing attempt in the round | server `progress.coveredSentences.shadowing` |
| C | **Azure evaluated coverage** | distinct eligible sentences with a saved successful Azure evaluation (`savedAzureEvaluationFor`) | derived from round results |
| D | **Word Match coverage** | distinct eligible sentences whose latest completed Word Match is saved | derived from round results |
| E | **Finalized Shadowing summary** | an immutable, versioned snapshot of the deterministic summary for one round, with its source watermark | new table (§7), written only by the server |

Rules:
- A does not imply B, C or E. A round completed through Dictation shows "Round
  complete" (existing) and Shadowing coverage separately ("Shadowing: 12 of
  110 sentences").
- B = 100 % does not imply C = 100 %; paid evaluation of every sentence is
  never required for a summary.
- Eligible sentences = `requiredSentenceCount` (non-empty normalized text of
  the pinned revision, Phase 3 rule). Unknown/0 → counts without percentages.

---

## 3. Lifecycle (Recommended)

States of the summary for a round: **live** (derived, not stored) → **final
v1** → optionally **final v2, v3…** (each a new row; older versions kept).

| Situation | Behavior |
|---|---|
| Viewing while learning | live summary from round results (as today, with SS1 rules); labelled "In progress · N evaluated"; nothing stored |
| Shadowing coverage reaches 100 % (B) or round completes (A) | offer (don't force) **Save lesson summary**; the existing round-complete notice is unchanged |
| Finishing early | **Save lesson summary** is available whenever ≥ 1 sentence is Shadowing-practiced; the report states partial coverage |
| Incomplete Azure coverage | allowed; confidence statement (§5.1) says what the evidence covers; priorities need their own minimum evidence (§6) |
| Evaluations pending at save | the dialog says "1 evaluation still running"; choices: *Wait* (bounded, reuses the existing GET polling) or *Save now* (pending ones excluded, listed as "pending at save time") |
| Late result / recovery after finalization | the finalized version is **never rewritten**. The page compares the current source watermark with the latest version's; if different it shows "New results since this summary was saved — Update summary", which creates version n+1 (the old one stays viewable) |
| Reopening the lesson | shows the latest final version (if any) as the primary view, with "Current practice" (live) one tap away when the watermark differs |
| Practice again / new round | the existing restart creates a new round; each round has its own summaries. A cross-round "current weaknesses" view belongs to Phase 6 (Dashboard), not here |
| Abandoned round without a saved summary | the live summary remains derivable while detail exists; compaction (§8) never touches a round without a current final summary |

Historical vs current: a finalized version answers "how did this lesson go at
that time"; the live view answers "where am I now in this round". A later
round never changes an earlier round's summary.

---

## 4. Data flow (Recommended)

```
shadowing_attempts ──fn_shadowing_round_results──▶ GET /api/practice/attempts?roundId=
        │                                              │
        │                                  client map (existing) ─▶ buildShadowingSummaryV2 (pure TS, shared)
        │                                                              └─▶ live summary UI
        │
        └─ POST /api/practice/rounds/[roundId]/shadowing-summary (server)
              1. auth (GoTrue) → user id
              2. read round results with the caller's JWT (owner RLS; same function)
              3. buildShadowingSummaryV2 (same code) → payload
              4. service_role fn_save_shadowing_summary(user, round, payload, watermark)
                   locks the summary key, re-computes the watermark in SQL,
                   refuses a mismatch (409 summary_source_changed → client retries once)
              5. returns {version, created|existing}
```

The payload is computed by trusted server code from database rows — never
accepted from the client. The same pure module runs in the browser (live)
and on the server (final), so the two cannot drift. Porting the aggregation to
SQL (alternative) was rejected: it duplicates non-trivial logic and recreates
the TS↔SQL parity risk Phase 3 had to test around.

---

## 5. Summary content (Recommended)

Main view, top to bottom; everything beyond the first two blocks is
collapsed by default on mobile.

### 5.1 Scope and confidence
- Video title, round number, pinned revision (version label), saved date / "in progress".
- Counts: eligible *M*; Shadowing-practiced *B*; Azure-evaluated *C*; Word Match *D*; pending at save time.
- Evidence statement, generated from the counts, e.g. "Based on 3 of 110
  sentences scored by Azure. Priorities below need at least 2 sentences of
  evidence." With C = 0: "No sentences were scored by Azure — the summary shows
  practice coverage and browser recognition only."

### 5.2 Overall performance (existing rules, kept)
- Pronunciation, Accuracy, Completeness weighted by the sentence's word count;
  Fluency, Prosody weighted by audio duration (existing `weightedAverage`
  inputs); one representative result per sentence; a metric Azure didn't
  return is excluded, not 0; Word Match never contributes. Shown only when
  C ≥ 1; each metric shows "from k sentences".

### 5.3 Practice next (priorities)
Default **5** shown, "Show more" up to **12** (existing `MAX_WORDS_TO_PRACTICE`).
Each item:

```ts
interface PracticePriority {
  kind: "word" | "sound" | "rhythm" | "skipped_word";
  label: string;                  // word key, or Azure IPA phoneme, or "pauses"
  source: "azure";                // priorities are Azure-only
  issue: "mispronounced" | "low_score" | "weak_sound" | "unexpected_break" | "missing_break" | "monotone" | "omitted";
  recentScore: number | null;     // latest representative occurrence score; null for omissions/rhythm
  evidence: { issueCount: number; opportunityCount: number; sentenceCount: number; sentencesWithIssue: number };
  lastObservedAt: string;         // evaluatedAt of the latest occurrence with the issue
  priority: number;               // practicePriorityFor(...) — sort key
  why: string;                    // deterministic template, e.g. "Low in 3 of 4 sentences (latest 42)"
  examples: Array<{ segmentIndex: number; transcriptId: string; position: number; sentenceText: string; attemptId: string }>; // ≤ 3
}
```
The action "Practise this sentence" opens the example's sentence in the
round's pinned revision (§10.4).

Shown separately, never ranked with pronunciation: **Browser recognition
differences** (Word Match) — words missing/different in ≥ 2 sentences' latest
Word Match, labelled "Your browser's speech recognition — not a pronunciation score".

### 5.4 Improvement
- "Improved": comparable evidence only (§6.6), latest ≥ first + 10
  (existing `improvementLevelFor` levels).
- "Still worth checking": previously flagged, latest comparable attempt still flagged.
- "Not re-checked": flagged once, no later comparable attempt — never called improved.
- "Seen OK in other sentences": weak in one sentence, fine elsewhere — explicitly not "improved".

### 5.5 Sentences
Per-sentence list (all eligible sentences, index order): Shadowing practiced ✓/–,
representative Azure score or "not evaluated", Word Match %, attempts count;
tap opens the sentence (pinned revision). Replaces "Sentences to retry" as the
full list; the 5 lowest remain a sorted shortcut.

---

## 6. Deterministic evidence rules (Recommended; thresholds are configurable product defaults, not validated proficiency levels)

Constants live in one module (`shadowingSummaryConfig.ts`) and are recorded
with each finalized version (`algorithm_version` + `config`).

### 6.1 Representative Azure result per sentence
`R(s)` = the saved successful Azure evaluation of sentence *s* in the round
with the greatest `(attempt.created_at, attempt.id)` — the server's
`latestSuccessfulAzureAttempt`. Not the best score; not the newest recording if
that one is unevaluated. Pending/failed/expired/unsaved/superseded/conflict
never qualify.

### 6.2 Word Match evidence
`W(s)` = latest completed, saved Word Match of *s* (`latestWordMatchAttempt`).
Comparison recomputed from its recognized text and the pinned sentence (as the
restored report does). Used only in §5.3's recognition section and D.

### 6.3 Occurrences and grouping
- An **occurrence** = one entry of `R(s).words`, identified by
  `(segmentIndex, position)` where `position` is its index in Azure's word array.
- **Word key** = `normalizePracticeWord` (lowercase, edge punctuation stripped).
  No stemming/lemmatization: "cat"/"cats", "walk"/"walked" stay distinct
  (their pronunciation differs). Contractions are kept as spoken.
- Two occurrences of the same word in one sentence are two occurrences.
- Retries don't add occurrences: only `R(s)` contributes to current evidence.

### 6.4 Issue classification per occurrence (Azure only)
| Condition | Issue |
|---|---|
| `errorType = Mispronunciation` | `mispronounced` |
| `errorType = None` and `accuracyScore < LOW_WORD_SCORE` (default 60) | `low_score` |
| `errorType = Omission` | `omitted` (not a pronunciation error; score not used) |
| `errorType = Insertion` | ignored for priorities (extra words) — counted in scope only |
| prosody `breakErrorType` / `intonationErrorType` present | `unexpected_break` / `missing_break` / `monotone` (rhythm) |
| phoneme `accuracyScore < WEAK_PHONEME_SCORE` (default 60, existing `PHONEME_PROBLEM_THRESHOLD`) | contributes to the phoneme's `weak_sound` evidence |

Phoneme evidence exists only when the occurrence has a `phonemes` array; a
word's total score never produces phoneme issues.

### 6.5 Counting and priority
For word key *k*: `opportunityCount` = occurrences of *k* over all `R(s)`;
`issueCount` = those with an issue; `sentenceCount` / `sentencesWithIssue` =
distinct sentences. A priority requires `issueCount ≥ 1` and is **recurring**
when `sentencesWithIssue ≥ MIN_RECURRING_SENTENCES` (default 2); a
single-sentence issue is shown only as "one-off — worth checking" and ranks
after recurring items. Priority = existing `practicePriorityFor({averageLatestScore, errorRate = issueCount/opportunityCount, evaluatedOccurrences = sentenceCount})`.
Sound *p*: occurrences = phoneme entries labelled *p* in `R(s)`; recurring when
weak in ≥ 2 distinct words **and** ≥ 2 sentences. Omissions: listed under
"skipped words" when ≥ 2 sentences.

### 6.6 Improvement (comparable evidence)
Comparable = same sentence, same `position`, same word key, both results saved,
same `engine_version`, within the round's history (≤ 5 per sentence,
`azureHistory`). Word improved when latest − first ≥ 10 over ≥ 2 comparable
points and the latest is `R(s)`; sentence improved on Pronunciation score the
same way. Different sentences are never compared for "improvement".

### 6.7 Sparse evidence
C = 0 → no Overall, no priorities (state it). C < `MIN_EVALUATED_FOR_OVERALL`
(default 1) → same. Priorities never show `recentScore` without evidence
counts. LLM narrative: optional later, reads the stored structured summary,
never a source of scores or evidence.

---

## 7. Durable storage (Recommended)

| Data | Where |
|---|---|
| live summary | derived on demand (client + server share the module) |
| cached while learning | the existing round-results response (React state + scoped sessionStorage mirror) — nothing new |
| finalized summary + compact evidence | **one** new table, one row per version |
| per-attempt scalars | unchanged `shadowing_attempts` columns |

### 7.1 Table `shadowing_round_summaries` (new migration, next free number)
```sql
create table shadowing_round_summaries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  round_id uuid not null references learning_sessions(id) on delete cascade,
  youtube_video_id text not null,
  transcript_id uuid null references transcripts(id) on delete set null, -- pinned revision at save time
  version integer not null check (version >= 1),
  schema_version smallint not null,           -- payload shape
  algorithm_version text not null,            -- e.g. 'ss-summary/1' + config hash
  source_watermark text not null,             -- sha256 of the round's evaluation state (§7.2)
  selected_attempt_ids uuid[] not null,       -- R(s) per sentence, lineage
  coverage jsonb not null,                    -- {eligible, shadowingPracticed, azureEvaluated, wordMatch, pendingAtSave}
  metrics jsonb not null,                     -- {pronunciation:{value,from}, ...} (absent = unavailable)
  priorities jsonb not null,                  -- PracticePriority[] (bounded: ≤ 12 + ≤ 12 sounds)
  improvements jsonb not null,
  sentences jsonb not null,                   -- per-sentence compact rows (§5.5), no word detail
  evidence jsonb not null,                    -- compact occurrences referenced by priorities (≤ 3 per item)
  created_at timestamptz not null default now(),
  unique (round_id, version),
  unique (round_id, source_watermark, algorithm_version)   -- idempotent save
);
-- size guard: pg_column_size of the jsonb columns ≤ 256 KB total (checked in the function)
```
RLS: `select` for `auth.uid() = user_id`; **no** insert/update/delete grants to
`anon`/`authenticated`; writes only through `fn_save_shadowing_summary`
(SECURITY DEFINER, `search_path=public, pg_temp`, EXECUTE service_role only),
matching the Phase 4 pattern. Rows are immutable (no update path).

### 7.2 Watermark and staleness
`fn_shadowing_summary_watermark(round_id)` (SQL, stable) = sha256 over the
ordered list of `(attempt id, azure_eval_request_seq, azure status,
word_match_request_seq, word_match status)` for the round. The summary is
**stale** when the latest version's watermark ≠ the current one. The save
function locks the round's summary key (`pg_advisory_xact_lock(hashtext('ssum:'||round_id))`
— not the `learning_sessions` row, to stay out of the attempt-recording lock
path), recomputes the watermark, and:
- equal to the latest version's (same algorithm) → returns it (`existing`);
- differs from the watermark the server computed the payload from → `409 summary_source_changed` (server retries once);
- otherwise inserts `version = max + 1`.
Concurrent/retried saves therefore produce at most one row per state.

### 7.3 Deletion
Account deletion cascades through `users`; a round deletion cascades its
summaries; a revision deletion (Phase 9, currently unreachable) sets
`transcript_id` null — evidence keeps the sentence text snapshot so the report
still reads correctly. Attempts referenced by `selected_attempt_ids` are not
FK-bound (array); if missing, the report says "source attempt no longer
available".

### 7.4 Limitation (stated in the UI help and here)
After detail compaction (§8) a **new** aggregation algorithm cannot be
recomputed for old rounds; their stored versions keep the algorithm/config
they were produced with (`algorithm_version`), which the report displays.

Alternative considered: storing the summary inside `learning_sessions`
(jsonb column). Rejected: no versioning, and it would put report writes on the
row Phase 3 locks for attempt recording/completion.

---

## 8. Retention (separate from finalization; Recommended; default **disabled**)

### 8.1 Policies compared
| Policy | Storage | Loss | Verdict |
|---|---|---|---|
| Keep everything (today) | grows with attempts | none | fine at personal scale; default |
| Age only ("delete after N days") | smallest | loses unsummarized evidence | rejected |
| **Summary-gated compaction** (below) | bounded per round | only sub-word detail of non-representative attempts, after a final summary and grace | **recommended when enabled** |
| Keep last N per sentence | medium | arbitrary | used as a secondary keep rule |

### 8.2 Compaction — exact definition
Applies to one `shadowing_attempts` row. **Never** changes: the row itself,
scores, statuses, seqs, timestamps, validity, round/segment/revision ids,
`word_match_*` columns (≤ 32 KB, small — out of scope in v1).
Changes only `azure_detail`, from full `{recognizedText, words[]}` to
```json
{"compact": 1, "recognizedText": "...", "words": [{"word": "cat", "accuracyScore": 40, "errorType": "Mispronunciation"}]}
```
(word order kept = positions kept; syllables, phonemes, nBest, offsets and
prosody removed), and sets new nullable columns:
`azure_detail_compacted_at timestamptz`, `azure_detail_sha256 text` (hash of the
full detail before compaction, `sha256(azure_detail::text)`).
Distinguishing states: `azure_detail` null ⇒ never saved (legacy);
`compacted_at` set ⇒ intentionally reduced; UI says respectively "detail wasn't
saved for this recording" / "sound-level detail was removed to save space —
scores and word results are kept".

### 8.3 Eligibility (all required)
1. retention enabled (`app_retention_policy.enabled`, singleton, admin-only; default false);
2. the round has a final summary whose watermark equals the current one;
3. that version's `created_at` ≤ now − `grace_days` (configurable; no default is approved — recommendation 180 days);
4. attempt `azure_eval_status = 'completed'`, `azure_evaluated_at` ≤ now − max(`grace_days`, recovery TTL), not pending;
5. attempt is **not** a representative `R(s)` of that round and not among the `keep_recent_per_sentence` (default 2) latest successful attempts of its sentence;
6. `compacted_at is null`.
Representative attempts keep full detail so reopening a sentence keeps Focus/Word details.

### 8.4 Execution
`fn_compact_shadowing_detail(p_limit int, p_dry_run boolean)` (service_role /
operator only): selects eligible ids `for update skip locked limit p_limit`,
re-checks eligibility per row, rewrites detail, sets the markers; one batch =
one transaction; idempotent (`compacted_at is null` filter); crash ⇒ the batch
rolls back, rerun continues. Ordering is guaranteed by rule 2 (summary saved
and current before any compaction). A new evaluation of the same attempt is
impossible (completed attempts are never re-admitted); a new attempt changes
the watermark, making the round ineligible until a new summary version exists.
Fail-closed: missing policy row, disabled, or any prerequisite unknown ⇒ zero
rows. Dry run returns `{eligible_rows, rounds, bytes_before, bytes_after_est}`
and changes nothing. Disabling stops future runs; it **does not restore**
removed detail.

### 8.5 Scheduling
SS5 ships an operator SQL script (manual) first; a cron route only after the
dry run has been reviewed on real data.

### 8.6 Phase 4 idempotency after compaction
`fn_finish_azure_evaluation` compares `azure_detail`. A new migration replaces
it with one extra rule: if `azure_detail_compacted_at` is set, the stored
result is "identical" when scores + engine version match **and**
`sha256(p_detail::text) = azure_detail_sha256`; outcome `already_applied`, no
write (never re-inflating detail); otherwise `conflict`, no write. In practice
unreachable — tokens live 600 s and compaction starts days later — but it
keeps a stale replay from producing a false conflict or restoring purged data.
The persist-recovery route is unchanged.

---

## 9. Storage measurement (read-only; nothing has been run)

Run in the Supabase SQL editor (read-only) or against the local disposable DB:
```sql
-- per-row detail size
select count(*) filter (where azure_detail is not null) as with_detail,
       avg(pg_column_size(azure_detail))::int as avg_bytes,
       percentile_cont(0.5) within group (order by pg_column_size(azure_detail)) as p50,
       percentile_cont(0.95) within group (order by pg_column_size(azure_detail)) as p95,
       max(pg_column_size(azure_detail)) as max_bytes,
       sum(pg_column_size(azure_detail)) as total_detail_bytes,
       sum(pg_column_size(word_match_detail)) as total_wm_bytes
from shadowing_attempts;
-- attempts / evaluations per sentence and round
select round_id, count(*) attempts, count(*) filter (where azure_eval_status='completed') evaluated,
       count(distinct segment_index) sentences,
       round(count(*)::numeric / nullif(count(distinct segment_index),0), 2) attempts_per_sentence
from shadowing_attempts group by round_id order by attempts desc limit 20;
-- table + index + toast
select pg_size_pretty(pg_total_relation_size('shadowing_attempts')) total,
       pg_size_pretty(pg_relation_size('shadowing_attempts')) heap,
       pg_size_pretty(pg_indexes_size('shadowing_attempts')) indexes;
-- savings estimate: bytes of non-representative completed detail
with rep as (select distinct on (round_id, segment_index) id from shadowing_attempts
             where azure_eval_status='completed' order by round_id, segment_index, created_at desc, id desc)
select count(*) candidates, sum(pg_column_size(azure_detail)) candidate_bytes
from shadowing_attempts a where a.azure_eval_status='completed' and a.id not in (select id from rep);
```
Summary size: measure `pg_column_size` of a locally generated payload (SS3
test fixture of 110 sentences). Illustrative only (not measured): a 10-word
sentence with phonemes and 5 alternatives is on the order of 10–30 KB of
`azure_detail`; a compact row ~1 KB; a summary ~10–40 KB. At personal-app
volumes (hundreds of evaluations) total detail is likely a few MB — well
inside Supabase limits — so enabling compaction may not be justified yet;
SS4 decides from measured numbers.

---

## 10. UI (Recommended; no redesign)

1. **In progress**: the existing Session panel header gains "In progress";
   its button opens the modal restructured per §5 (scope first, Practice
   next second).
2. **Save**: "Save lesson summary" in the modal footer (and the round-complete
   notice); pending-evaluation dialog per §3.
3. **Completed view**: reopening a round with a final summary shows "Lesson
   summary · saved <date> · v2"; a "Current practice" tab shows the live one
   when the watermark differs ("New results since saving — Update summary").
4. **Links to sentences**: open the sentence only when the page displays the
   summary's pinned revision (`transcript_id` equal); otherwise show the stored
   sentence text with "This sentence is from an earlier script version" and no
   jump. Uses the existing pinned-revision resume path.
5. **States**: no-Azure (coverage + recognition only), partial, legacy (no
   detail: scores only), compacted ("sound-level detail removed"), audio
   ("audio isn't kept" — existing copy).
6. **Mobile**: modal as full-height sheet, one column; priority cards wrap
   example chips; long words truncate with the full word in `title`.
Existing saved sentence feedback stays exactly as now until retention is enabled.

---

## 11. Implementation sequence (Recommended)

| Stage | Content | Migration | Depends on |
|---|---|---|---|
| **SS1** | `shadowingSummary` pure module v2: rules §6 (occurrence identity, comparable improvement, omissions/rhythm, representative-by-`created_at` on the client), contract types; reuse in the existing panel | none | current `main` |
| **SS2** | UI §5/§10.1–2 on live data; Shadowing coverage label; "Save" hidden until SS3 | none | SS1 |
| **SS3** | table + `fn_save_shadowing_summary` + watermark fn + POST/GET route + completed view; new version of `fn_shadowing_round_results` adding `position` to history words (`WITH ORDINALITY`) | next free number | SS1–SS2 |
| **SS4** | measurement SQL (§9) as `supabase/shadowing-summary/00_measure.sql`, compaction markers + dry-run function (no writes possible: dry run only granted) | next free number | SS3 |
| **SS5** | compaction function (write), `fn_finish` compacted rule, policy row (disabled), operator script; enable only after reviewing SS4 numbers | next free number | SS4 + decision |

No automatic deletion ships before SS5, and SS5 ships disabled. Phase 5
(Listening) is independent: it touches `listening_progress`/study sessions,
not these objects. Phase 6 may later reuse `shadowing_round_summaries` for
history/dashboard cards (read-only).

---

## 12. Acceptance tests

| # | Scenario | Tier |
|---|---|---|
| 1 | Round completed via Dictation → Shadowing coverage & summary unaffected, no auto "Shadowing complete" | unit + real-PG |
| 2 | All sentences Shadowing-practiced, 3 evaluated → report states 3/M evidence; priorities need ≥ 2 sentences | unit |
| 3 | Word Match-only lesson → no Overall/priorities, recognition section only | unit |
| 4 | No successful evaluations → honest empty state; save allowed | unit + browser |
| 5 | Several successful attempts on one sentence → one representative (latest `created_at`), no extra occurrences | unit |
| 6 | New unevaluated recording after a success → representative unchanged | unit |
| 7 | Evaluating an older take after a newer one → live and restored pick the same representative | unit |
| 8 | Weak word improved on the same sentence/position → "Improved"; weak in one sentence, OK in another → not "improved" | unit |
| 9 | Repeated word in one sentence → two occurrences, separate evidence; plural vs singular kept apart | unit |
| 10 | Sparse evidence (one flagged occurrence) → "one-off", ranked after recurring | unit |
| 11 | Pinned revision differs from displayed → links disabled, text snapshot shown | unit + browser |
| 12 | Save during pending evaluation → pending excluded and listed; late result → stale → Update creates v2, v1 unchanged | real-PG + unit |
| 13 | Recovery result after save → watermark changes → stale | real-PG |
| 14 | Concurrent and retried saves → one row per watermark; `409` on source change | real-PG |
| 15 | Cross-user: another user can't read/save a summary; no client write path | real-PG (real roles) |
| 16 | Legacy rows without detail → scores only, no invented words | unit |
| 17 | Summary save failure → compaction finds zero eligible rows | real-PG |
| 18 | Compaction rerun / crash mid-batch → idempotent, no partial row | real-PG |
| 19 | After compaction: scores, statuses, attempt counts, coverage, completion, summary rows identical | real-PG |
| 20 | Replay of the original result after compaction → `already_applied`, no write; different result → `conflict`, no write | real-PG |
| 21 | Stored summary evidence still renders after compaction; representative attempts keep full detail | unit + real-PG |
| 22 | Dry run changes nothing and reports counts/bytes | real-PG |
| 23 | Mobile layout of the summary sheet | browser |

Azure is always mocked; real-PG uses the disposable harness only.

---

## 13. Limitations and open decisions

Limitations: improvement horizon = 5 successful results per sentence (existing
read); compacted rounds cannot be re-summarized with a new algorithm; Azure
phoneme labels are provider IPA, not verified transcription; Word Match depends
on the browser's recognizer.

Decisions for the reviewer (consequential):
1. **Save trigger** — explicit "Save lesson summary" only (recommended) vs
   automatic at round completion.
2. **Grace period and keep-N** for compaction (recommended 180 days / 2), or
   leave retention disabled indefinitely at current volumes.
3. **Word Match detail** — out of compaction scope in v1 (recommended) or
   included.
4. Whether Phase 6 should surface cross-round "current weaknesses" from saved
   summaries or recompute from recent rounds.
