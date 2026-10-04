# Shadowing summary / report — audit and proposal

Status: **audited, then resolved** (2026-10-04). §0 records the implementation that resolved
D1–D8 and R1. Sections 1–9 below are the **original audit, kept unchanged as history**: where they
say "current", they describe the code *before* the fix. The audit itself changed no production
code; the follow-up implementation did (no SQL, no migration).

Original audit status: **audit only**. No production code, migrations or data were changed. Two
isolated audit test files were added (§9). The related proposal document
`.claude/shadowing-summary-retention-plan.md` is still **entirely a proposal**: none of its
stages (SS1–SS5) has been implemented. The current code still has the per-sentence word dedupe,
cross-sentence improvement and completion-order promotion that it describes. Its
`shadowing_round_summaries` table, watermark and compaction functions don't exist.

Baseline: `main` @ `a392919`, clean tree. Migrations 038–042 were treated as applied, as stated;
042 history functions were exercised locally. Evidence tiers used below:
- **PG**: real PostgreSQL 17 (disposable local DB, real `authenticated` / `service_role` roles).
- **jsdom**: component and hook tests with HTTP mocked.
- **mock**: route tests with Supabase mocked.
- **code**: inspection only.

Nothing was verified against production, Supabase HTTP or a real browser.

---

## 0. Resolution (implemented 2026-10-04, not deployed)

**Scope.** Application code and tests only. No SQL or migration changed: `fn_shadowing_round_results`
(038) and `fn_round_report` / `fn_shadowing_summary` (040) already carried every field the fixes
need. Migrations `001`–`042` are untouched. Nothing was applied, deployed, committed or pushed, and
Azure was never called.

**Architecture.**

| Piece | Where | Role |
|---|---|---|
| Builder | `src/lib/practice/shadowingSummary.ts` (`buildShadowingRoundSummary`) | Pure, deterministic. Coverage, metrics, occurrence evidence, classification, comparable improvement, detail availability. All thresholds live in `SHADOWING_SUMMARY_RULES`. |
| Server adapter | `src/lib/practice/shadowingSummaryInput.ts` (`fromRoundResults`) | Saved round results → builder input (every round report). |
| Live adapter | `src/app/dictation/[videoId]/videoPracticeSummary.ts` (`summaryInputFromEvaluations`) | The practice page's map → builder input. It keeps only *saved* results; `savedAzureEvaluationFor` is unchanged. A parity test proves both adapters give identical input for the same saved data. |
| Display rule | `src/lib/practice/scoreFormat.ts` (`formatAggregateScore`) | One decimal for round-level averages, half away from zero, like SQL `round(…, 1)`. |
| Query | `src/lib/queries/shadowingRoundResults.ts`, key `["shadowing-round-results", userId, roundId]` | One cache entry per (user, round). The practice hook writes its reads into it; reports read it lazily (abortable). `invalidateLearningViews` invalidates it with the round report. |
| View | `src/components/report/ShadowingSummaryView.tsx` | One view for the practice dialog and the report section. |
| Section | `src/components/report/ShadowingFeedbackSection.tsx` | Inside `RoundReportPanel`. Open on the completion view and `/results`, collapsed in History. Fetches only when open; refuses a response for another round or revision. |

The Dashboard keeps its SQL aggregate (no detail download); only the display rule changed.

| # | Resolution | Evidence |
|---|---|---|
| **D1** | Every round surface divides by the round's **eligible** sentences (pinned revision). Recording coverage (`coveredSentences.shadowing`, practice-valid only), total recordings, Azure-scored and Word Match counts are shown separately. Unknown denominator → count only. The practice page passes `null` while the round loads, instead of `segments.length`. | `shadowing-summary-audit.test.tsx` D1; `shadowingSummary.test.ts` coverage; PG audit points 1/2/17 (a too-short take is not recorded coverage) |
| **D2** | Occurrence identity = (sentence, index in the representative result). Repeated words are kept. Priorities report occurrences, affected occurrences, sentences and affected sentences separately. "Well pronounced" requires every occurrence scored ≥ 90 and nothing flagged (rhythm included). | `shadowingSummary.test.ts` (occurrences, ranking); audit D2 |
| **D3** | Word improvement only within the same sentence, between two different saved results, when **both** results align one-to-one with the reference words (identical keys in order, only `None`/`Mispronunciation`) and the word occurs once in the sentence. Otherwise no word claim; the sentence-level comparison remains. With a full 5-item history the comparison is labelled "recent", not "since the first". Declines and unchanged scores are never positive. | `shadowingSummary.test.ts` improvement block; audit D3 |
| **D4** | Classified by error type before any threshold: `Omission` → "Not recognized in the recording" (score ignored); `Insertion` → "Extra recognized words"; `UnexpectedBreak`/`MissingBreak`/`Monotone` (word type or `prosodyFeedback`) → rhythm; `Mispronunciation` → pronunciation, even unscored; `None` + score < 60 → low score; unknown types or missing scores → uncertain (counted, never diagnosed). Sounds come only from pronunciation-evidence words, labelled "average of the low ones". | `shadowingSummary.test.ts` classification; audit D4 |
| **D5** | `detail.availability` ∈ `no_scores` / `none` / `partial` / `full`, plus `scoredWithPhonemeDetail` and `uncertainOccurrences`. "No major pronunciation issues" is gone; "nothing flagged" is scoped to the sentences with word detail. Missing detail keeps the score in the averages. | audit D5; report-section "missing word detail" |
| **D6** | `formatAggregateScore` on the practice panel, practice dialog, round report tiles, History and Dashboard. Scaled values are fixed to 6 decimals before rounding (float noise); the 84.45 boundary now reads "84.5" everywhere. | `shadowingSummary.test.ts` rounding; PG audit point 12 (report, practice and Dashboard identical) |
| **D7** | The hook's `onConfirmedSave` runs on every confirmed save — direct, polling **and recovery** — for the scope on screen only. It invalidates the round report, round results, Dashboard, Library and History, and re-reads the round. Superseded, conflicting and unsaved results trigger nothing. (The page's own Azure-refresh calls were removed; Word Match still refreshes as before.) | `shadowing-result-order.test.tsx` (recovery refresh; no refresh for superseded/conflict/unsaved) |
| **D8** | "Session" → "This round", "Session averages" → "Round averages", "Video summary" → "Round summary" / "Shadowing summary · This round". The report section is titled "Shadowing summary · Round N", so an old round opened from History is named. Study-session labels elsewhere are unchanged. | component tests |

**R1 — confirmed and fixed (corrected in a follow-up pass, see "R1 follow-up" below).**
- **Reproduction:** `shadowing-result-order.test.tsx`. The newer take's result arrives first and
  the older take's later. A live result carries no recording time, so the older result was
  promoted. Before the fix it stayed until a reload, which then showed the newer one.
- **First fix (superseded):** promotion followed the server's order when both recording times
  were known; a result with an unknown time was **promoted provisionally** and the round re-read.
  The follow-up showed that this still let the round summary switch to the older take's score,
  word priorities and history for as long as the re-read took.
- **Obsolete reads:** each read supersedes the previous one, so a read started before a save, or a
  reply for a previous round, is ignored (tested).

**R1 follow-up (2026-10-04) — provisional take results vs the confirmed selection.**

*Verdict:* the first fix was **incomplete**. Reproduced exactly (jsdom): B (newer) saved and
confirmed; A (older) arrives later from the evaluate response, which carries no recording time;
the re-read is held back. During the delay the summary used A — A's score, A's flagged words, A
in the history. With the guard below removed, 4 of the new tests fail; with it, all pass.

*Where ordering data exists (checked in code):* server reads and polling (`azureResultFrom` →
`recordingCreatedAt`) have it; the direct evaluate response and the recovery path
(`setTrueEvaluationPersistence`) do not, and the evaluate route does not return it. No route or
SQL was changed: the existing re-read is the authority.

*Rule now:*
- Two responsibilities are kept apart. **The take's card** (`trueEvaluation`) shows the result of
  the take just evaluated, marked "Saved · updating the round summary…". **The confirmed
  selection** (`lastSuccessfulTrueEvaluation` + `attempts`) feeds coverage, averages, priorities,
  improvement, the score badge fallback and every report.
- A saved result whose recording time is unknown is **not placed**: it is listed in the entry's
  `selectionPending` and the confirmed selection is left as it was. A recording time is only taken
  from the same attempt id (`latestRecording`, the current representative or a history item) —
  never borrowed from another take.
- A pending result is placed only by a server read that **started after** its save was confirmed
  (a per-page save counter; `mergeServerResults(…, { placedByThisRead })`). An older read that
  lands late neither places nor un-places it.
- Results that do carry their time (polling, server reads) are placed immediately by
  `created_at`, then attempt id. The id tie-break is now an ordinal comparison, matching Postgres
  `uuid` order (`order by created_at desc, id desc`), instead of `localeCompare`.
- **First evaluation** (no confirmed representative yet): the card shows the saved score; the
  summary keeps its previous state (that sentence is not counted yet) and the card says "Saved ·
  updating the round summary…". It is never labelled unsaved.
- **Re-read fails:** the confirmed data stays; the tab shows "Your score is saved, but the round
  summary couldn't refresh" with **Refresh summary**, which only re-reads (no Azure call). There
  is no automatic retry, so no refetch loop. A failed page load with a pending result restored
  from the cache shows the same.
- **Caches:** the shared query cache (`["shadowing-round-results", …]`) is only ever written with
  server responses; the sessionStorage mirror stores the confirmed selection and the pending id,
  never the pending result as representative. A reload always lets the server decide.
- **Scope changes** (account, round, revision) cancel the held-back read; nothing lands on the
  new scope.

*Tests added* (`shadowing-result-order.test.tsx`, "R1 follow-up"): the exact scenario (every
render checked: never A's score, never A's priorities; the shared cache and sessionStorage hold
B; after the re-read the live summary equals the report built from the same server data); re-read
failure (no loop, only `GET /api/practice/attempts`, manual refresh places A); restore after a
failed load; an older read landing after a newer save; the merge's placement rule; account /
round / revision change while the read is delayed; equal recording times (larger id wins in
either arrival order); first evaluation; the card's "pending" and "failed" wording. The Phase 4
recovery test now expects the server to place a recovered score.

*Full-suite timeout (`vocabulary-page.test.tsx` › "disables further checking at the shared
selection cap") — investigated, existing, cause not established.*
- The test clicks 100 checkboxes over 101 rendered cards, with its own 30 s timeout. The test
  file and the vocabulary page are unchanged from `HEAD`.
- Its own duration varies widely between identical standalone runs: **9.4 s, 18.6 s, 33.1 s
  (fail), 33.4 s (fail)**. The other 44 tests in the file stay at 10–12 s in total. Only this test
  slows down, not the whole file.
- **Baseline:** a clean worktree at `HEAD` (none of this work) failed the same way in 1 of 3
  standalone runs. Runbook §10 already recorded a timeout in this file during an earlier parallel
  run, before the Shadowing work existed.
- **No leak path from the new tests:** Jest isolates each test file (module registry, jsdom
  environment, timers), and the failure also occurs with the file run alone. The new suites use no
  fake timers, resolve every deferred response, and create their QueryClients per test. Run in band
  with the new Shadowing/History suites, the vocabulary file passed (89/89).
- Of the changed modules, the vocabulary test reaches `types.ts` (types only) and
  `learningInvalidation.ts` / `shadowingRoundResults.ts` (key definitions). The changed
  invalidation code runs only when a round id is passed, and the vocabulary page never calls it.
- **Unknown:** what makes the click loop take 9 s in one run and over 33 s in the next. Machine
  load is plausible — a `next dev` server was running throughout — but that isn't proven. The
  timeout wasn't raised, the test wasn't skipped, and `--forceExit` wasn't used.

*Final verification (this pass):*
- `tsc` clean.
- Lint: 0 errors, the same 3 existing warnings.
- Focused Shadowing/report/History suites with the real-Postgres parity test: 11 suites,
  128 passed.
- Full Jest, in band, with the local DB: 140 suites passed, 4 skipped, 1 failed; **1,578 passed,
  113 skipped (Supabase HTTP — not run), 1 failed** (the vocabulary test above). Jest printed "did
  not exit one second after the test run", as in the previous run.
- `npm run build` passes.
- Browser and iPhone: not verified.

**Final rules (application rules, not diagnoses).**
- **Coverage:** recorded = eligible sentences with a practice-valid take; scored = sentences with a
  saved successful Azure result; Word Match separate. "All sentences recorded" never implies
  "evaluated". Round completion is unchanged and independent.
- **Representative and weights:** unchanged (latest saved success by recording time; word-count /
  duration weights; missing metrics excluded).
- **Evidence:** only from the representative result of each scored sentence. Recurring = affected
  in ≥ 2 sentences. Ranking: recurring, then priority (0.55·severity + 0.30·error rate +
  0.15·recurrence; an unscored mispronunciation is ranked at the 60 threshold), then affected
  occurrences, then the word. Five shown, then "Show N more" (`aria-expanded`), at most 12.
- **Word key:** lowercase, typographic apostrophes normalized, edge punctuation removed, internal
  `'`/`-` kept, no stemming.

**Remaining limitations.**
- **Alignment:** word-level improvement is deliberately conservative. Azure tokens that differ
  from the reference text (numbers, contractions split differently) or any omission/insertion
  suppress it.
- **History cap:** history is capped at 5 successes per sentence (038). Older comparisons are
  "recent".
- **Thinned detail (R4):** results thinned above 96 KB lose phonemes; dropped detail is reported
  as unavailable, not clean.
- **R2/R3:** they remain provider-dependent, but are now classified safely if they occur.
- **Not verified:** browser, iPhone and production behaviour (see PHASE6_RUNBOOK §8 item 7).
- **Not implemented:** the retention plan's snapshot/compaction stages SS3–SS5, an explicit
  "Finish Shadowing" action, retention, cleanup and audio storage.

---

## 1. Assessment

The **numbers are sound**:
- Every surface selects the representative Azure result the same way: the latest *saved
  successful* result per (round, sentence), ordered by `created_at desc, id desc`. It is never
  the best score.
- Word Match is never substituted for Azure. Missing metrics are excluded, never zero.
- Pending, failed, expired, unsaved, superseded and conflicting results never add coverage, and
  a newer failed or unevaluated take never removes an earlier success.
- Results are scoped to user + round + pinned revision.
- Reading reports writes nothing.
- The practice page's client builder and the server report agree on counts and weighted
  metrics. The only difference is display rounding.

The **review experience is weak and partly misleading**:
- **Two builders, two scopes.** The weak-word / sound / improvement summary exists only inside
  the practice page (client builder). The round report shown at completion, at `/results/[id]`
  and in History has only three Shadowing tiles and a per-sentence score. It can't be "the main
  review experience" today.
- **Denominators disagree.** The report's "evaluated" denominator is *recorded* sentences, so a
  Dictation-completed round reads "3/5 evaluated" while the practice panel reads "3/6".
- **Word evidence is lossy or wrong in three ways:**
  - repeated words in a sentence are deduped (an error can be dropped);
  - "improvement" compares different sentences;
  - any non-`None` Azure error type with a score counts as a pronunciation issue.
- **Missing detail looks like a clean result.** A result without word detail renders as "No
  major pronunciation issues detected."

The persisted data already supports a correct occurrence-level weak-word summary **without
another Azure call and without a migration** (§5).

---

## 2. Report surfaces and data flow

```
record take ─POST /api/practice/attempt──▶ fn_record_shadowing_attempt (037) ─▶ shadowing_attempts row
   │                                          (is_practice_valid, study_session_id, pinned transcript/segment)
   ├─ Word Match (browser ASR) ─POST …/attempt/[id]/word-match──▶ fn_record_word_match (038)
   └─ Evaluate ─POST /api/practice/evaluate──▶ fn_begin_azure_evaluation ─▶ Azure ─▶ toStoredAzureResult
                                               (96 KB thinning) ─▶ fn_finish_azure_evaluation (seq-guarded)
        persisted:false ─▶ recovery token (memory, 600 s) ─▶ POST …/evaluate/persist-recovery ─▶ fn_finish (same seq)

READ A (practice page, any round of the user):
  GET /api/practice/attempts?roundId= ─▶ fn_shadowing_round_results (038, SECURITY INVOKER + owner RLS)
     per practiced sentence: latestAttempt, latestSuccessfulAzureAttempt (full detail),
     latestWordMatchAttempt (full detail), azureHistory (≤ 5 compact successes)
  ─▶ useShadowingEvaluations: sessionStorage mirror shown first, server merge wins (shadowingServerMerge.ts),
     refuses a round pinned to another revision
  ─▶ buildShadowingEvaluationSummary (videoPracticeSummary.ts) ─▶ EvaluationSessionSummary ("Session" panel)
                                                                ─▶ VideoPracticeSummaryModal ("Video summary")
     per sentence: EvaluationTab (Focus / Word details from lastSuccessfulTrueEvaluation)

READ B (reports):
  GET /api/session/[roundId]/report ─▶ fn_round_report (040) ─▶ fn_shadowing_summary(user, round)
  ─▶ useRoundReportQuery ["round-report", userId, roundId] ─▶ RoundReportPanel, used by:
     PracticeReportView (completion view) · /results/[roundId] · History card (HistoryVideoCard)
READ C (Dashboard):
  GET /api/dashboard/summary ─▶ fn_dashboard_summary ─▶ fn_shadowing_summary(user, NULL) (all rounds)
```

| Surface | Builder | Scope | All study sessions of round? | Depends on browser session? | Live = restored rules? | Detail used | Loading / missing / stale |
|---|---|---|---|---|---|---|---|
| "Session" panel (`EvaluationSessionSummary`) | client `buildShadowingEvaluationSummary` | user + video + pinned revision + round (cache key and server merge) | yes, after the server merge | shows the sessionStorage mirror first; server wins | yes, except R1 (order) and R4 (thinning) | full latest-success detail; ≤ 5-item compact history for trends | load error message; mismatched revision not merged; stale only between scope change and fetch |
| "Video summary" modal | same object | same | yes | same | same | same | same |
| EvaluationTab (per sentence) | `entryFromServer` | same | yes | same | yes | full detail of the latest success; Word Match recomputed from the stored text | detail-less → scores only (tested) |
| Completion view (`PracticeReportView`) | SQL `fn_shadowing_summary` + per-sentence `latestAzure` | user + round (pinned transcript) | yes | no | n/a (server only) | **none** (scores only) | loading / retry; invalidated after saved Azure or Word Match, **not after recovery (D7)** |
| `/results/[roundId]` | same | same | yes | no | n/a | none | same query key |
| History card report | same (`RoundReportPanel`) | explicit round | yes | no | n/a | none | same |
| Dashboard "Pronunciation" | `fn_shadowing_summary(user, NULL)` | user, **all rounds** (incl. abandoned and legacy) | yes | no | n/a | none | invalidated with the views above |

**Read-only:** report reads are read-only in practice (PG fingerprint test, §9). This covers:
- the report, round-results, attempt, dashboard, progress, History and Library functions;
- no rounds, memberships, sessions or activity are created;
- no Azure call is made; the read routes call only stable RPCs (mock tests).

The one deliberate write on a read is `GET /api/practice/attempt/[id]`, which lazily records an
**expired** evaluation for its own seq. It's used by the practice page's evaluation polling and
by no report, and it changes no score or coverage. Keep it.

---

## 3. Metric definitions

| UI label (surface) | Actual formula | Source | Scope | Missing data | Verdict |
|---|---|---|---|---|---|
| "N/M evaluated · P%" (Session header) | N = sentences in map with `savedAzureEvaluationFor` (completed + saved or visitor-local); M = `progress.requiredSentenceCount` (eligible = non-empty normalized text of pinned revision), falls back to `segments.length` before the round is known | client | round | M = 0 or unknown → count only, never "complete" | **Correct** |
| "Complete / Partial summary" (modal) | `M > 0 && N ≥ M` | client | round | as above | Correct (evaluation-complete, not round-complete) |
| Session averages / modal Overall: Pronunciation, Accuracy, Completeness | Σ score·words / Σ words over representative results; words = whitespace tokens of the sentence (client) or `fn_word_count(text_raw)` (server), same tokenization | Azure | round | metric absent → excluded from its own average | Correct; label "Session" is wrong (**D8**); display rounding differs from the report (**D6**) |
| Fluency, Prosody | Σ score·duration / Σ duration (`recording_duration_sec`) | Azure | round | excluded | Correct (PG: 74 with a null-metric sentence excluded and no Word Match fallback) |
| Strongest skill / Needs most work | max / min of the four metric averages | derived | round | absent metrics skipped | Works; compares unlike scales (product note, not a defect) |
| Words to practice | per normalized word key: occurrences = distinct sentences (**first occurrence per sentence only**); Avg = mean latest score; issues = `errorType ≠ "None"`; priority = 0.55·(100−avg) + 0.30·errorRate·100 + 0.15·min(n/3,1)·100; top 12, 5 shown | Azure detail | round | words with null score skipped | **Defects D2, D4** |
| Well-pronounced words | avg ≥ 90 and no issues | Azure | round | — | **D2** (can list a word mispronounced elsewhere in the same take) |
| Sounds to practice | phoneme entries of deduped current words with score < 60; avg of weak entries; top 8, 5 shown | Azure detail | round | no phonemes → none | Inherits D2; otherwise correct |
| Lowest-scoring sentences | PronScore, else Azure accuracy (flagged "*") | Azure | round | neither → not listed | Correct |
| Improvement (word / sentence) | word: first vs last score over the word key's timeline across **all sentences** (≤ 5 compact successes each); sentence: first vs last of that sentence's history; levels +10 / +20 / +30 & ≥ 70 | Azure history | round | single point → none | Sentence level correct; **word level D3** |
| Practice coverage (report) | `fn_round_progress`: distinct eligible sentences with a valid Dictation answer ∪ valid Shadowing take / required | server | round | required null → count only | Correct |
| Shadowing takes / "N sentences practiced" (report) | all takes (incl. too-short) / distinct sentences with a practice-valid take | server | round | — | Correct |
| Pronunciation (Azure) tile + "x/y evaluated sentences" | value: word-weighted, `round(…, 1)`, UI `Math.round`; y = `attemptedSentences` (any take) | Azure (SQL) | round | null → "—", "No saved pronunciation scores" | Value correct; **denominator D1**, **rounding D6** |
| Word Match tile | latest completed Word Match per sentence, word-weighted accuracy | Word Match | round | null → "—" | Correct; same denominator issue (D1) |
| Per-sentence "pronunciation X · Word Match Y%" | latest completed per sentence | server | round | omitted | Correct |
| Dashboard "Pronunciation · N scored sentences" | word-weighted over each round's latest success per sentence, **all rounds** | Azure (SQL) | account | "—" | Correct as defined; N counts (round, sentence) pairs (R8) |
| Listening coverage | not part of Shadowing reports | — | — | — | n/a |

**Completion vs Shadowing.** No code equates round completion with "Shadowing evaluated" or uses
it as a retention trigger:
- `isComplete` compares saved evaluations with the eligible count;
- the report headline "Round complete" refers to the round.

The only misleading spot is D1's denominator.

---

## 4. Confirmed defects

| # | Severity / impact | Where | Evidence | Minimal fix |
|---|---|---|---|---|
| **D1** | **Medium.** Report surfaces (completion view, `/results`, History) show Azure (and Word Match) coverage as "3/5 evaluated sentences" when only 3 of 6 eligible sentences were scored. The practice panel says "3/6". In a Dictation-completed round with few recordings, this reads as nearly fully evaluated. | `src/components/report/RoundReportPanel.tsx:152`, `:161` (`/${shadowing.attemptedSentences}`) | jsdom `shadowing-summary-audit.test.tsx` "D1"; PG audit points 1/8 (`evaluatedSentences 3`, `attemptedSentences 5`, `requiredSentenceCount 6`) | UI only: `"{evaluated} of {required} eligible sentences scored"` using `progress.requiredSentenceCount` (count-only when unknown), plus "{attempted} recorded" as separate text. No migration. |
| **D2** | **Medium.** Repeated words: only the first occurrence of a word in a sentence counts. A mispronounced second "the" is dropped, and "the" can even appear under *well pronounced* from the same take. | `videoPracticeSummary.ts` `currentWordOccurrences` (227–241), `dedupedAttemptWords` (210–221) | jsdom "D2" | Occurrence identity = (segmentIndex, index in Azure's word array); aggregate per word key across occurrences; "well pronounced" requires no flagged occurrence. |
| **D3** | **Medium.** "Great improvement: water 30 → 92" when "water" was weak in sentence 1 and fine in sentence 6, with nothing retried. At the same time it's listed under Words to practice. | `buildShadowingEvaluationSummary` word timeline (`timelineByWord`, 355–362, 409–430) | jsdom "D3" | Improvement only from comparable points: same sentence and same position (history already carries the word array in Azure order). Cross-sentence evidence becomes "also fine in sentence k", never "improved". |
| **D4** | **Low–medium (conditional).** Every `errorType ≠ "None"` with a numeric score is a pronunciation "issue". An Omission or Insertion with a score becomes "Avg. 0/100 · 1/1 issues". A recognition or omission problem is presented as a pronunciation fault. | `videoPracticeSummary.ts:397` (`errorType !== "None"`), `:234` | jsdom "D4": confirmed *if* the score is numeric. With a null score, the omission is silently ignored (also tested). Whether Azure sends a numeric score for Omission/Insertion was **not observed** (no Azure calls). | Classify explicitly: `Mispronunciation` or low score → pronunciation; `Omission` → "skipped words" (no score); `Insertion` → ignored for priorities; prosody types → rhythm. |
| **D5** | **Low (latent).** A saved result without word detail adds to the averages, but the panel says "No major pronunciation issues detected." That isn't an honest fallback. It becomes real if detail is dropped (> 96 KB after thinning) or ever compacted. The per-sentence view is already honest (existing test). | `EvaluationSessionSummary.tsx:137–138`; `videoPracticeSummary.ts` (no "has detail" count) | jsdom "D5" | Count sentences with word detail; show "Word-level detail is available for k of N scored sentences" and suppress "no issues" when k = 0. |
| **D6** | **Low.** For the same round, the report or Dashboard and the practice modal can show integers 1 apart. SQL rounds to one decimal, then the UI rounds again (84.45 → 84.5 → 85, vs 84). | `040` `fn_shadowing_summary` `round(…, 1)`; UI `Math.round` in `RoundReportPanel` / `VideoPracticeSummaryModal` | PG audit "rounding" test | UI-only: round the client value to one decimal before integer display (matches numeric half-away-from-zero for these positive scores), or show one decimal on both surfaces. |
| **D7** | **Low.** After a recovery save succeeds, the round report, Dashboard and History aren't invalidated. They can show the old count until refetched (global `staleTime` 60 s). A direct save and the polling path do invalidate. | `src/app/dictation/[videoId]/page.tsx:374` (`onScorePersistence: setTrueEvaluationPersistence`) vs `:689`, `:717` | code | Wrap `onScorePersistence`: on `"saved"`, also call `refreshShadowingAggregates()`. |
| **D8** | **Low (wording).** Round-wide data restored across every study session is labeled "Session" / "Session averages", and the modal is "Video summary" although other rounds are excluded. | `EvaluationSessionSummary.tsx:102`, `:116`; `VideoPracticeSummaryModal.tsx:120` | code + PG point 6 (the builder includes both sessions) | Rename to "This round" / "Round summary". |

---

## 5. Unverified risks

| # | Risk | Why unverified / bound |
|---|---|---|
| R1 | Live promotion follows **completion** order (`useShadowingEvaluations` `withSavedEvaluation`), while the server follows `created_at`. If an older take's result lands after a newer take's result (e.g. two tabs), live and reloaded representatives differ until reload. | One tab is guarded: `busySegmentIndex` blocks parallel evaluations, and recovery only promotes the result still shown. Not reproduced. |
| R2 | Azure documents `UnexpectedBreak`, `MissingBreak` and `Monotone` as possible **word `ErrorType`** values. If they appear there (not only in the prosody feedback object), D4 counts rhythm as mispronunciation. | Provider payload not observed. |
| R3 | `Insertion` words (EnableMiscue on) have no reference position, but would be aggregated as normal words when scored. | Same. |
| R4 | Thinning above 96 KB drops nBest, then sub-word detail, then all detail: a live result can show sounds that disappear after reload. | Local synthetic measurement: a 20-word sentence with full detail is ~25.7 KB JSON, so thinning needs about 75+ words. Rare. |
| R5 | `azureHistory` words carry no explicit position; order relies on `jsonb_array_elements` without `WITH ORDINALITY` (preserved in practice, not guaranteed). Fixing D3 at position level should not depend on it long-term. | Behaviour of PG 17 observed only indirectly. |
| R6 | Initial payload: `fn_shadowing_round_results` returns full detail for both the latest success and the latest Word Match of every practiced sentence. Locally measured synthetic sizes (JSON) — 6 words: full 7.7 KB / compact 0.4 KB; 12 words: 15.4 KB / 0.8 KB; 20 words: 25.7 KB / 1.3 KB. A fully evaluated 110-sentence round could send about 1.5–2 MB. | Not measured on real data. |
| R7 | Dashboard `fn_shadowing_summary(user, NULL)` scans all of the user's takes; there's no `user_id` index on `shadowing_attempts` (indexes: round/segment/created_at, study session, transcript). | Fine at personal scale; not measured. |
| R8 | Dashboard pronunciation includes abandoned and legacy rounds, and counts a sentence once per round. Defined that way in 040; the label doesn't say so. | Product definition. |
| R9 | `totalCount` falls back to `segments.length` (may include empty sentences) until round progress loads. | Transient; not reproduced. |
| R10 | Browser, iPhone, Supabase HTTP and production behaviour of every surface. | Not run. |

---

## 6. Correct behaviour to preserve

- **Selection:**
  - latest saved successful Azure result per (round, sentence), `created_at desc, id desc`, never best score;
  - the same rule in `fn_shadowing_round_results`, `fn_shadowing_summary` and `fn_round_report`.
- **Separation:** three independent pointers (latest take, latest Azure success, latest Word
  Match). Word Match never feeds Azure aggregates.
- **Missing and failed data:**
  - absent metrics are excluded (PG point 9);
  - pending, failed, expired, unsaved, superseded and conflicting results never count;
  - a newer failed or unevaluated take keeps the earlier success (PG 2–3; jsdom coverage tests).
- **Weighting:** word count (text of the pinned sentence) and recording duration. Retries add no
  weight.
- **Seq guard and recovery:**
  - `fn_finish_azure_evaluation` guards by seq;
  - recovery writes only the same seq;
  - `persisted:false` results count only after recovery (PG point 4, jsdom).
- **Scope:**
  - user + round + pinned revision;
  - client refuses to merge a round pinned to another revision;
  - rounds and revisions stay separate (PG point 7);
  - all study sessions of a round contribute (PG point 6).
- **Shared report contract:** one report component across completion view, `/results` and
  History.
- **No storage of recordings or raw payloads:** audio and the raw Azure payload are never stored;
  the recovery token lives in memory only.
- **Read-only reports**, including expired-pending reported without a write (PG point 12).
- **Honest restore:** per-sentence restore never invents words for detail-less records.

---

## 7. Recommendation for the next report

**Initial view (one screen, per round):**
1. Scope line: "Round N · {eligible} sentences · recorded {B} · scored by Azure {C} · Word Match
   {D}", plus state (below).
2. Overall Azure metrics only when C ≥ 1, each with "from k sentences".
3. "Practice next": up to 5 items (word, sound, or skipped word). Each shows:
   - its evidence ("low in 2 of 3 sentences");
   - its latest score;
   - a link to one example sentence (pinned revision only).

**Expandable:**
- more priorities (≤ 12);
- browser recognition differences (Word Match, labeled "not a pronunciation score");
- improvement (comparable only);
- the full sentence list (recorded ✓, score or "not scored", Word Match %);
- per-sentence Focus / Word details loaded on demand.

**Weak-word aggregation rules:**
- **Occurrence and word key:**
  - occurrence = (sentence, position in the representative result);
  - word key = lowercase with edge punctuation stripped, no stemming.
- **What counts as a pronunciation issue:** only `Mispronunciation` or a score below a
  configurable threshold (today's tier boundary is 60).
- **Separate categories, not pronunciation:** omissions are listed as "skipped words"; insertions
  and prosody types go to rhythm, or are ignored.
- **Recurring:** an issue in ≥ 2 sentences (configurable). One-offs rank after recurring items.
- **Improvement:** only same sentence and position.
- **Product decisions:** thresholds are product decisions, recorded with the algorithm version.

**States:**
- *In progress*: live, nothing stored.
- *Shadowing complete*: every eligible sentence has a practice-valid recording.
- *Partial evaluation*: always shows "C of M scored". Never imply that unscored sentences were
  assessed.
- Round completion stays separate.

**What "finish Shadowing" should mean.** Compared options:
- *Recording all eligible sentences.* Server-derived (`coveredSentences.shadowing = required`),
  free, and needs no storage.
- *Evaluating all eligible sentences.* Requires paid evaluation of every sentence. Reject it as
  the trigger.
- *Explicit finish with partial evaluation.* Clearest intent, but it must be persisted to survive
  reload or other devices, which needs a migration.

**Recommended default:** recording coverage (derived, no migration), with the summary always
stating how many sentences were scored. Add an explicit "Finish early" only together with
persisted snapshots (option B/C).

**Storage options.**
- A, compute on demand: the data is already there. `fn_shadowing_round_results` is readable for
  any of the user's rounds. Cost: payload (R6) and client CPU.
- B, versioned snapshot: needed only if detail is ever compacted, or a "finished" state must
  persist. Cost: new table, watermark, staleness and version UX (retention plan §7).
- C, hybrid: A now, B added when needed.

**Recommendation: A now, as one shared pure TS builder.**
- Move it from `app/dictation/[videoId]/` to `src/lib/practice/`.
- Feed it from `/api/practice/attempts?roundId=` on the practice page, the completion view,
  `/results` and History.
- Load it lazily when the Shadowing section opens.

This gives one rule set and no migration. **Defer** B (snapshot table, watermark, algorithm
version) until compaction is actually approved. Its lifecycle questions (late results, extra
practice, missing historical detail) are answered in the retention plan §3/§7 and stay valid.

**Deferred retention / compaction.** Nothing now. When decided:
- **Removable per non-representative attempt:**
  - `syllables`, `phonemes` (incl. `nBestPhonemes`);
  - `offset` / `duration`;
  - `prosodyFeedback`.
- **Keep:** scores, statuses, seqs, timestamps, engine version and the ordered word list (word,
  score, errorType).
- **Lost:** sound / phoneme priorities, syllable view, rhythm feedback and playback word timing
  for those takes. Word-level summaries remain recomputable; sound and rhythm do not unless
  captured in a snapshot.
- **Preconditions:** a current snapshot (watermark equal), no pending evaluations, and the
  recovery TTL elapsed.
- **Concurrency and idempotency:**
  - row lock plus watermark re-check;
  - `fn_finish_azure_evaluation`'s detail-equality idempotency must switch to a stored
    fingerprint first (retention plan §8.6).
- **Measurement:** measure real sizes before deciding. Locally, compact detail is ~5% of full
  (§5 R6).

---

## 8. Ordered implementation plan

**A. Correctness fixes (no migration):**
1. D1: report denominators use eligible sentences (`RoundReportPanel`).
2. D2 + D4: occurrence identity and explicit error-type classification in the builder.
3. D3: comparable-only improvement.
4. D5: honest "no word detail" state.
5. D7: invalidate the views after a recovery save.
6. D6: one display rounding rule.
7. D8: "Round" wording.

Update the pinned audit tests with each fix (they assert today's behavior).

**B. Report improvements (no migration expected):**
8. Move the builder to `src/lib/practice/` and type its output for reuse.
9. Add a lazily loaded "Shadowing summary" section to `RoundReportPanel` (completion view,
   `/results`, History) from `GET /api/practice/attempts?roundId=`.
10. Scope line and the three states (§7), "Practice next" with evidence, a sentence list, and
    links only for the pinned revision.
11. *Optional, migration*: a slimmer read function (summary fields without nBest/syllables) and
    explicit `position` in history words, if R6 or R5 prove real.

**C. Optional future compaction (migrations):**
12. Snapshot table + watermark + save route (retention plan SS3).
13. Measurement + dry-run function (SS4).
14. Compaction function + fingerprint idempotency rule (SS5), disabled by default.

---

## 9. Verification, files and open decisions

**Files added (audit only, untracked; production code unchanged):**
- `src/__tests__/integration/shadowing-summary-audit.integration.test.ts`: PG, 6 tests.
- `src/__tests__/shadowing-summary-audit.test.tsx`: jsdom, 6 tests. They pin current behavior for
  D1–D5.
- `.claude/shadowing-summary-audit.md` (this file).

**Runs:**
- Both audit files: 12/12 passed.
- Audit plus existing related suites, one in-band run with the local DB: 14 suites, 165 tests,
  all passed. The suites:
  - `shadowing-evaluated-coverage`, `shadowing-report-restore` (.ts and .tsx), `videoPracticeSummary`;
  - `round-report`, `phase4-shadowing-client`, `auth-shadowing-cache`;
  - `practice-word-match-and-read-routes`, `evaluate-recovery-token`;
  - real PG: `phase4-shadowing`, `phase6-library`, `history-by-video`;
  - the two audit files.
- ESLint on the new files and `tsc --noEmit`: clean.
- The full suite, `npm run build` and browser checks were not run, since no production code
  changed.

| # | Check | Result | Evidence (tier) |
|---|---|---|---|
| 1 | 3 Azure + 1 recording / Word Match-only → 3 | ✅ | audit PG (`evaluatedSentences 3`); `shadowing-evaluated-coverage` 1/11 (jsdom) |
| 2 | Newer failed / unevaluated take keeps the earlier success | ✅ | audit PG (s1 failed, s0 unevaluated newest); jsdom 2/3/7 |
| 3 | Newer success replaces, no double count | ✅ | audit PG (80 not 60, still 3 sentences); jsdom 6 |
| 4 | `persisted:false` excluded until recovery | ✅ | audit PG (3 → 4 after the same-seq write); jsdom 2/3/4/5; `evaluate-recovery-token` (mock). Cache refresh after recovery: **D7** |
| 5 | Reload vs History equivalent | ✅ counts and metrics equal; ⚠ display rounding can differ by 1 (**D6**) | audit PG (client builder over `fn_shadowing_round_results` vs `fn_round_report`) |
| 6 | Several study sessions in one round | ✅ | audit PG (2 sessions, both contribute) |
| 7 | Rounds / revisions separate | ✅ | audit PG (restart on revision B; round 1 unchanged); jsdom 8 (other revision not merged) |
| 8 | Dictation-completed, partial Shadowing not "fully evaluated" | ✅ practice panel `isComplete=false`; ⚠ report shows "3/5" (**D1**) | audit PG + jsdom D1 |
| 9 | Missing Azure metric ≠ 0, no Word Match substitute | ✅ | audit PG (fluency / prosody 74 with a null sentence and Word Match 100); `phase6-library` 19/22 |
| 10 | Repeated words keep occurrence evidence | ❌ **D2** | jsdom D2 |
| 11 | Honest fallback without detail | ✅ per-sentence restore (`shadowing-report-restore`); ❌ summary panel (**D5**) | jsdom |
| 12 | Reading reports mutates nothing, no Azure | ✅ | audit PG fingerprint over 8 learning tables across 9 read functions; read routes call only RPCs (mock). Exception kept: lazy expiry in `GET /api/practice/attempt/[id]` (not a report) |

**Unresolved product decisions:**
1. Default meaning of "finish Shadowing" (recommended: all eligible sentences recorded).
2. Thresholds: low word score (60?), minimum sentences for "recurring" (2?), and how many
   priorities to show (5 / 12).
3. Whether omissions are shown to the learner, and how.
4. Whether the Dashboard pronunciation stays account-wide across all rounds, or uses the latest
   round per video.
5. Whether retention / compaction is ever needed at current volumes (measure first).

---

## Tóm tắt (tiếng Việt)

**Hiện trạng.** Phần số liệu nền tảng đúng: mỗi câu lấy kết quả Azure thành công *mới nhất* đã
lưu (không phải điểm cao nhất), và Word Match không bao giờ thay cho Azure. Metric thiếu thì bị
loại khỏi trung bình chứ không tính là 0. Lần thu mới bị lỗi hoặc chưa chấm không làm mất kết quả
cũ. Dữ liệu tách đúng theo vòng và phiên bản script, và mở báo cáo không ghi gì vào cơ sở dữ
liệu.

Vấn đề nằm ở phần trình bày và phân tích từ yếu:
- **Báo cáo vòng** ghi "3/5 câu đã chấm" (mẫu số là số câu đã thu âm), trong khi màn luyện tập
  ghi "3/6".
- **Từ lặp lại trong một câu** chỉ tính lần đầu, nên lỗi ở lần sau bị mất.
- **"Tiến bộ"** đang so sánh giữa các câu khác nhau.
- **Lỗi bỏ sót (Omission)** có thể bị tính như lỗi phát âm.
- **Kết quả không có chi tiết từ** lại hiện "không có vấn đề".
- **Báo cáo không làm mới** ngay sau khi lưu bù (recovery) thành công.

**Nên sửa trước:**
1. Đổi mẫu số trong `RoundReportPanel` thành số câu hợp lệ của vòng.
2. Sửa bộ tổng hợp từ yếu: tính theo từng lần xuất hiện (câu + vị trí), phân loại đúng loại lỗi
   Azure, chỉ coi là "tiến bộ" khi so cùng câu, cùng vị trí.
3. Hiện thông báo trung thực khi thiếu chi tiết từ.
4. Làm mới các view sau khi recovery thành công.
5. Thống nhất cách làm tròn và đổi nhãn "Session" thành "Round".

Sau đó chuyển bộ tổng hợp thành module dùng chung và đưa phần "Shadowing summary" vào báo cáo vòng
(màn hoàn thành, `/results`, History). Dữ liệu lấy từ endpoint
`/api/practice/attempts?roundId=` sẵn có.

**Có cần migration mới không?** Gần như **không**, cho cả các bản sửa lẫn phần cải tiến báo cáo:
dữ liệu đã lưu đủ để dựng tóm tắt từ yếu mà không phải gọi Azure lại. Chỉ cần migration nếu sau
này muốn có một trong ba thứ sau:
- hàm đọc gọn hơn, hoặc thêm vị trí từ vào lịch sử;
- lưu snapshot tóm tắt hoặc trạng thái "đã hoàn thành Shadowing";
- nén (compaction) dữ liệu chi tiết.

Cả ba đều là việc tùy chọn về sau, chỉ làm khi đã đo dữ liệu thật và đã chốt quyết định sản phẩm.
