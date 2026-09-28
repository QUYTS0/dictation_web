# Phase 4 runbook — Shadowing server-side persistence

Baseline (confirmed by the user): migrations `001`–`037` applied, Phase 3
cutover **activated** (`legacy_writes_retired = true`,
`authoritative_writes_active = true`, 25/25 permission checks, legacy bridges
removed), Vercel `PRACTICE_WRITE_PATH=authoritative`. Phase 4 never touches the
Phase 3 cutover: nothing here pauses writes, reopens a legacy path or rolls the
cutover back.

**Current state (user-confirmed):** commit `3d38124` (Phase 4 including the
review fixes) is on `main` and is serving Vercel Production; migration `038`
is **not** applied. Until it is, Production runs the Phase 4 app without its
schema — see §5 "Compatibility" for exactly what works meanwhile. Changes made
after `3d38124` (evaluation-wait cancellation, documentation/comments) are
local and uncommitted.

## 1. What ships

| Piece | Where |
|---|---|
| Migration `038_phase4_shadowing_persistence.sql` | additive: 4 nullable columns on `shadowing_attempts`, evaluation lifecycle + read functions; revokes the two superseded 035 writers |
| `POST /api/practice/attempt` | save a finished take as practice (`fn_record_shadowing_attempt`, from 037) |
| `POST /api/practice/evaluate` | **breaking**: `attemptId` + audio only |
| `POST /api/practice/evaluate/persist-recovery` | save a paid result whose first write failed (signed token only) |
| `PATCH /api/practice/attempt/[attemptId]/word-match` | store Word Match (server-computed scores) |
| `GET /api/practice/attempt/[attemptId]` | one saved take + results (lazy timeout expiry) |
| `GET /api/practice/attempts?roundId=` | a round's saved Shadowing results, for restoring after reload |
| Operator SQL | `supabase/phase4/00_preflight.sql`, `01_postflight.sql` (both read-only) |

Numbering: `038` is Phase 4. The Script Versions deletion migration the plan
previously called `038_fn_delete_transcript_revision.sql` is renumbered to
**`039` and is not created**.

## 2. Flow

1. **Recording finishes** (a cancelled/discarded take produces no clip and is
   never sent). The page captures the take's identity once — user, video,
   pinned revision, sentence, duration, round, and a new `clientAttemptId` —
   and POSTs it immediately. No audio is sent or stored; the clip stays in
   memory for playback/evaluation/retry while the page is open.
2. **Save** → `fn_record_shadowing_attempt` (caller's JWT): round/video/pin/
   segment checks, validity (`duration ≥ 0.5 s`, `validity_basis =
   'client_reported'` — duration does not prove speech), idempotency on
   `(round, clientAttemptId)`, study-session attribution (Phase 3 rules,
   including `null` for a superseded round), combined coverage and
   completion. With no known round the route first calls
   `fn_create_or_get_active_round` — the same round Dictation uses. The page
   shows "Saving…" → "Recording saved as practice" or "Not saved — Retry
   saving" (the retry reuses the same `clientAttemptId`). Progress/celebration
   come only from the server response, and only onto the round the take
   belongs to.
3. **Word Match** (automatic, browser speech recognition, unchanged
   algorithm) is shown instantly and, once the take has an attempt id, sent
   as `{status, recognizedText}`; the server recomputes accuracy/completeness
   from the attempt's pinned sentence and stores them under
   `word_match_request_seq` (independent of Azure).
4. **Evaluate** (explicit user action, signed-in only) waits for the save,
   then sends `attemptId` + audio. The server: checks configuration →
   validates the WAV and derives its duration (§3a) → auth →
   `fn_begin_azure_evaluation` (per-attempt admission, §3) → quota check by
   the derived duration (§3a) → Azure → usage recorded (best effort) →
   `fn_finish_azure_evaluation(attempt, user, seq)`. If the recording is
   already being evaluated (another tab, a double click) the answer is
   `409 evaluation_in_progress`, and `409 azure_already_evaluated` if it has a
   score. In both cases the page keeps showing "Evaluating…" and reads the
   stored outcome with `GET /api/practice/attempt/[id]` every 4 s, for at
   most 130 s — it never posts Evaluate again and never calls Azure. Each such
   wait is cancelled (the in-flight read and the delay are aborted, nothing on
   the page changes) when the page unmounts, on sign-out/account or video
   change, when the round or revision shown changes, or when a newer wait for
   the same recording starts; switching sentence or mode does not cancel it,
   and the result still lands only on the sentence it belongs to. Reaching the
   130 s bound shows "still being evaluated — check back in a moment"; a
   stored failure/expiry ends the wait with **Retry**.
5. **Persist**: applied only for the current seq while pending. A superseded
   response is shown as "replaced, not saved"; a different result already
   stored for the same seq is a *conflict* ("a different score is already
   saved") and the stored one is kept (§3b). A provider failure stores
   `failed` for that seq only — practice credit is untouched. A database
   failure after a paid result is retried 3× (0/250/750 ms); then the response
   carries `persisted:false` + a signed recovery token; the page shows "This
   score isn't saved yet", retries once automatically and offers **Save
   score**.
6. **Reload**: the page fetches `GET /api/practice/attempts?roundId=` for the
   round it shows and rebuilds the per-sentence view from it (no Azure call, no
   local attempt id needed). The sessionStorage mirror is only a cache, scoped
   to `(user, video, revision, round)`; server results win; only unsaved local
   results for known attempt ids are kept; pre-Phase-4 cache keys are never
   read and are deleted on sign-out/account switch. The original audio is not
   available after a reload — the saved scores are shown, "record again" to
   practice.

## 3. Contracts and permissions (migration 038)

| Function | Kind | anon | authenticated | service_role |
|---|---|---|---|---|
| `fn_begin_azure_evaluation(uuid,uuid,numeric)` | SECURITY DEFINER, `search_path=public, pg_temp` | ✗ | ✗ | ✓ |
| `fn_finish_azure_evaluation(uuid,uuid,integer,text,numeric×5,jsonb,text,text)` | SECURITY DEFINER | ✗ | ✗ | ✓ |
| `fn_expire_azure_evaluation(uuid,uuid,integer)` | SECURITY DEFINER | ✗ | ✗ | ✓ |
| `fn_record_word_match(uuid,uuid,text,numeric,numeric,jsonb)` | SECURITY DEFINER | ✗ | ✗ | ✓ |
| `fn_get_shadowing_attempt(uuid)` | SECURITY INVOKER (owner RLS) | ✗ | ✓ | ✗ |
| `fn_shadowing_round_results(uuid)` | SECURITY INVOKER (owner RLS) | ✗ | ✓ | ✗ |
| `fn_shadowing_attempt_dto(shadowing_attempts,boolean)`, `fn_shadowing_eval_timeout_sec()` | helpers used by the reads | ✗ | ✓ | ✗ |
| `fn_shadowing_max_audio_sec()` | constant (21 s), used only inside `fn_begin_azure_evaluation` (runs as its owner) | ✗ | ✗ | ✗ |
| 035 `fn_persist_azure_result(uuid,integer,text,numeric×5,text,text)`, `fn_persist_word_match_result(uuid,integer,text,numeric,numeric)` | superseded; **EXECUTE revoked by 038** (still defined) | ✗ | ✗ | ✗ |

Every service-role function takes the user id the route verified with GoTrue
and re-checks `(attempt, user)` itself. No table grant changes: users keep
SELECT-only on `shadowing_attempts`, and `learning_sessions`/`attempt_logs`
stay SELECT-only for every app role.

**Superseded 035 writers.** No caller of `fn_persist_azure_result` /
`fn_persist_word_match_result` exists in the application, in any SQL function,
in the operator scripts or in the Phase 3 build (only the old Phase 2 HTTP
test suites and historical postflight matrices name them). They lack the
admission and pending guards, so 038 revokes EXECUTE from every application
role (exact signatures); they stay defined. Rolling the app back to the
Phase 3 build is unaffected — it never calls them. The Phase 3 postflight's
25-row matrix (`supabase/phase3/06_postflight.sql`) is the **Phase 3
baseline**: after 038 its two rows for these functions intentionally show
`service_role = false`. From 038 on, use `supabase/phase4/01_postflight.sql`.

**Admission (one live evaluation per recording).**
`fn_begin_azure_evaluation(attempt, user, audio_duration_sec)` locks the ONE
attempt row (`FOR UPDATE`) in its own short transaction — released before
Azure is called. Other recordings and other users never wait on it; there is
no global lock, flag or queue. Checks, in order: audio duration valid
(> 0, ≤ 21 s, else `audio_invalid`); attempt owned by the user; round/video/
revision/segment relationships; practice-valid take (`attempt_not_evaluable`);
then:

| State of the recording | Result | Changes |
|---|---|---|
| completed | `already_evaluated` → HTTP `409 azure_already_evaluated` | none |
| pending and younger than 120 s | `in_progress` → HTTP `409 evaluation_in_progress` (`seq`, `expiresAt`, `Retry-After`) | **none** — no seq/timestamp change, no quota check, no Azure call |
| never evaluated / failed / pending older than 120 s, audio ≤ recording × 1.25 + 1 s | `admitted` — seq + 1, `pending`, `eval_requested_at = now` | yes |
| same, audio longer than that | error `audio_duration_mismatch` (409) | none |

A request admitted but never finished (the function instance died between
Azure and the write) stays `pending` for at most 120 s; after that the reads
report it `expired` (lazily written by `GET /api/practice/attempt/[id]` for
that exact seq only) and a replacement may be admitted — the old request's
late result is then rejected by seq (`superseded`). A real result for the
newest seq still replaces its own `expired` marker. One successful score per
recording: re-record for a new score. Azure's own request timeout is 15 s, far
inside the window. Unavailable provider metrics (e.g. prosody) stay NULL.

### 3a. Audio, quota and usage

- **Audio** — the only format accepted is what the app sends: RIFF/WAVE, PCM
  (format 1), mono, 16 kHz, 16-bit, produced in the browser by
  `src/lib/utils/wavEncode.ts` from every recorder/iPhone format. The route
  (`src/lib/practice/wavValidation.ts`) walks the chunks (unknown chunks such
  as `LIST` are skipped; odd sizes padded), requires exactly one `fmt ` and
  one `data` chunk, checks format/channels/rate/bits, that byte rate and block
  alignment agree, that the RIFF size matches the upload (±1 pad byte), that
  no chunk runs past the end and that the data is whole samples. Limits:
  upload ≤ 1 MiB, ≤ 64 chunks, audio 0.1–21 s (recorder cap 20 s + 1 s decoder
  slack; the same 21 s is enforced in SQL by `fn_shadowing_max_audio_sec()`).
  Anything else → `400 audio_invalid` (`413` when too large/too long), with a
  `reason`, before auth, admission, quota or Azure.
- **Duration** — derived by the server from the data chunk (bytes ÷ 32 000,
  rounded to ms); it is what the quota check and usage use. The stored
  `recording_duration_sec` stays client-reported practice metadata and is
  not rewritten; admission uses it only to refuse audio materially longer
  than the take it belongs to (audio > recording × 1.25 + 1 s →
  `409 audio_duration_mismatch`, nothing changed). The duration measures how
  much audio there is, not that it contains speech.
- **Quota is an approximate personal-app limit, not a strict spending
  guarantee** (unchanged store: Upstash monthly counters of audio seconds and
  calls). `reservePracticeQuota` only *reads* the counter — despite its name
  it reserves nothing — so concurrent evaluations of different recordings can
  all pass the check against the same remaining budget. It runs after
  admission, so a duplicate request for the same recording never reaches it.
  Over the limit → the evaluation is recorded `failed/quota_exceeded`,
  `429`. If the read itself errors → that request is recorded
  `failed/quota_unavailable`, `503 quota_unavailable` (retryable) and Azure is
  not called. With Upstash not configured the quota is not enforced (existing
  local-dev behaviour). Both failure records are written for the admitted seq
  only, so the attempt does not sit `pending` for 120 s and a newer request or
  a stored score is never overwritten.
- **Usage** is added (`INCRBY` seconds + `INCR` calls) once per admitted
  `(attempt, seq)` after a successful Azure call; persistence recovery never
  calls Azure and never records usage. A failed or timed-out provider call
  records nothing (existing policy; Azure may still have processed a
  timed-out call). The usage write **can fail even when the read succeeded**,
  and its two increments can **partially** succeed. The route then logs
  `usage_accounting_failed` (attempt id, seq, duration only) and still stores
  the score or issues the recovery token. That log line records the failure —
  it does not mean the usage was counted. Each such failure under-counts, and
  failures accumulate over the month; the counter is not reconciled and the
  write is deliberately not retried (the increments are not idempotent — a
  retry after a lost reply would double-count). Operators can count
  `usage_accounting_failed` lines in the Vercel logs and compare with Azure's
  own usage metrics; Azure's F0 free-tier limit is enforced by Azure itself.

### 3b. Result persistence

`fn_finish_azure_evaluation(attempt, user, seq, …)`:

| Incoming | Stored state | Outcome | Row |
|---|---|---|---|
| any, seq ≠ current | — | `superseded` | unchanged |
| completed/failed | `pending` (current seq) | `applied` | written |
| completed | `failed/expired` (current seq) | `applied` (late real result) | written |
| completed, identical | `completed` | `already_applied` | **unchanged** |
| completed, any difference | `completed` | `conflict` (stored result kept) | unchanged |
| failed | `completed` | `conflict` | unchanged |
| failed | `failed` | `already_applied` | unchanged |

"Identical" = every score column, the per-word detail (`jsonb` equality: key
order irrelevant) and the engine version — never persistence timestamps. The
route and the recovery token use one canonical serialization
(`canonicalStoredResult`), so a direct write and a recovery replay compare
equal. The response labels `superseded` and `conflict` separately and neither
as saved.

Trust boundaries (documented, unchanged in kind): practice validity is
duration-based and client-reported; Word Match's recognized text comes from
the browser's speech recognition (no server transcription is added) but its
scores are computed by the server; Azure scores come only from the server's own
provider call (or a token the server signed for that exact result).

HTTP errors: `409 stale_client_version` + `action: "reload_required"` (evaluate
without `attemptId`), `401` not signed in, `404 attempt_not_found` /
`round_not_found`, `409 evaluation_in_progress | attempt_not_evaluable |
azure_already_evaluated | audio_duration_mismatch | reference_unavailable |
attempt_relationship_invalid | word_match_already_recorded |
recovery_superseded | recovery_conflict`, `400/413 audio_invalid`, `413
audio_too_large`, `429` quota exceeded, `503 quota_unavailable` (retryable),
`410
recovery_token_expired`, `400 invalid_recovery_token`, `403
recovery_account_mismatch`, `503 evaluation_not_configured` (secret missing —
returned before anything is spent), `503 evaluation_unavailable` (038 missing),
and the Phase 3 mappings (`503 write_gate_paused` retryable, `409
idempotency_key_reused_with_different_payload`, …) for saving a take.

## 4. Environment

| Variable | Where | Notes |
|---|---|---|
| `AZURE_RECOVERY_SIGNING_SECRET` | Vercel **Production** (and Preview if used), server-only — never `NEXT_PUBLIC_` | **Required** for Pronunciation evaluation. ≥ 32 characters, e.g. `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`. Missing/short → evaluate answers `503 evaluation_not_configured` before calling Azure. Never logged. |
| `AZURE_RECOVERY_TOKEN_TTL_SEC` | optional | default `600` |
| `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`, `AZURE_SPEECH_MONTHLY_LIMIT_SEC` | unchanged | |
| `PRACTICE_WRITE_PATH` | unchanged | stays `authoritative` (or unset) |

Rotating the secret only invalidates recovery tokens issued in the last TTL
window (those results must be re-evaluated).

## 5. Rollout (in this order)

1. **Preflight** — SQL editor: `supabase/phase4/00_preflight.sql`. Expect stage
   `activated`, gate ok, both grants `true`, `begin_fn`/`round_results_fn`
   NULL, `new_columns = 0`.
2. **Set `AZURE_RECOVERY_SIGNING_SECRET`** in Vercel (no redeploy needed yet —
   the running Phase 3 build doesn't read it).
3. **Apply 038** — `supabase db push` (after `supabase migration list` shows
   `038` as the only pending migration). Additive columns and functions, no
   rows or table grants changed; the only privilege change is the revoke of
   the two superseded 035 writers, which no deployed build calls.
4. **Postflight** — `supabase/phase4/01_postflight.sql`: every `ok` true — 4
   column rows, 13 function-permission rows (incl. `fn_shadowing_max_audio_sec`
   and the two revoked 035 writers, all ✗), 9 SECURITY DEFINER/INVOKER +
   `search_path` rows, table privileges.
5. **Deploy the Phase 4 app** and confirm 100% of instances are on the new
   build. Production already serves `3d38124`; this step is the build that
   includes the later local changes (evaluation-wait cancellation) once they
   are committed — or confirming `3d38124` if they are not shipped yet.
6. **Manual checks** (§7), then run `01_postflight.sql` §5 again: counts grow,
   `azure_overdue_pending` stays ~0.

Order constraints: the migration should precede the app. The secret must be
present when the app runs, or Pronunciation shows "not fully set up"
(`503 evaluation_not_configured`, checked before anything is spent; Word Match
display and practice credit are unaffected).

**Compatibility (actual situation: `3d38124` is live, 038 is not applied).**

| App build | Database | Result |
|---|---|---|
| `3d38124` (corrected) | 001–037 (now) | Saving takes works (037's `fn_record_shadowing_attempt`). Everything that needs 038 fails cleanly: Evaluate → `503` (`evaluation_unavailable`, or `evaluation_not_configured` first if the secret is missing) before any Azure call or spend; Word Match storing, the single-attempt read and the round restore fail (shown as "not saved" / "couldn't load your saved recordings"). No row is corrupted. |
| `3d38124` (corrected) | 001–038 (corrected) | Intended pairing: the app calls `fn_begin_azure_evaluation(uuid,uuid,numeric)`, which the corrected 038 defines. |
| `0e159a6` (earlier Phase 4 commit) | 001–038 (corrected) | **Incompatible for evaluation**: that build calls a two-argument `fn_begin_azure_evaluation(uuid,uuid)`, which the corrected 038 does not create → Evaluate keeps failing (`503`). Saving and reads work. Production must not be on `0e159a6` after 038. |
| Phase 3 build | 001–038 (corrected) | Works; Phase 4 objects are unused (rollback target). |

Do not rush 038 to compensate for the early deployment: the current state is
degraded but safe. Run the preflight and postflight as written.

## 6. Stale clients

- A tab still running the Phase 3 bundle posts `referenceText` without
  `attemptId` → `409 stale_client_version / reload_required`; its generic
  error handling shows "This page is out of date. Reload it…". Nothing is
  spent or written. Such a tab never recorded Shadowing practice either
  (that bundle has no Shadowing save), so there is no unsaved work to rescue
  beyond the in-memory recording itself.
- Pre-Phase-4 sessionStorage entries (`dictation.shadowing-evaluations.*`)
  are never read again and are removed on sign-out/account switch; their
  scores are not promoted to saved results.
- Pronunciation evaluation now requires sign-in (it is always tied to a saved
  attempt). Visitors keep local Word Match only.

## 7. Manual browser / iPhone checks (after step 5)

1. Shadowing: record a sentence → "Saving recording…" → "Recording saved as
   practice"; Word Match appears. Record a 0.3 s take → "saved — too short to
   count as practice".
2. DevTools offline → record → "Not saved — …" with **Retry saving**; back
   online → Retry → saved (only one row in `shadowing_attempts` for that take).
3. Evaluate → score shown; reload → the sentence's Evaluation tab shows the
   saved score and Word Match ("Saved results for this sentence") without a new
   evaluation (Network: no `/api/practice/evaluate`).
   Evaluate the same take from two tabs at once → one tab gets the score, the
   other shows "Evaluating…" and then the same score, via `GET` reads only
   (one Azure call; `409 evaluation_in_progress` in its Network tab).
4. Record again, don't evaluate, reload → the old score is labelled as from an
   earlier take.
5. Practice every remaining sentence by Shadowing (or mix with Dictation) →
   "Round complete" notice once; a reload doesn't show it again.
6. Start an evaluation, switch sentence/mode immediately → the result lands on
   the original sentence only.
7. Sign out and in as another account on the same tab → none of the first
   account's results are shown; sessionStorage has no
   `dictation.shadowing.v2.<first user>` keys.
8. iPhone Safari: record/playback/save/evaluate with Word Match "unsupported"
   (Safari speech recognition) — saving and Pronunciation still work.
9. Dictation regression: resume at the saved sentence, Restart, Check/ retry,
   completion celebration — unchanged.

## 8. Recovery

| Situation | Action |
|---|---|
| App problem after step 5 | Redeploy the previous (Phase 3) build. It is compatible with 038 present; saved Shadowing data stays. Open tabs of the Phase 4 build then get `404` (saving) / `400` (evaluate) and show them as not saved. |
| `evaluation_not_configured` in logs | Set `AZURE_RECOVERY_SIGNING_SECRET` (≥ 32 chars) and redeploy. Nothing was charged. |
| Secret leaked | Rotate it; only tokens from the last 10 minutes are lost (those results can be re-evaluated). |
| Evaluations stuck `pending` | None needed: a duplicate Evaluate within 120 s gets "in progress" and waits for the stored result; after 120 s the reads report it expired and a new Evaluate is admitted on the same take. `01_postflight.sql` §5 shows the count. |
| Quota store (Upstash) read failing | Evaluate answers `503 quota_unavailable` without calling Azure; practice saving and Word Match are unaffected. Fix Upstash; nothing to repair in the database. |
| `usage_accounting_failed` in logs | The score was stored (or a recovery token issued), but that call was not counted: the monthly counter is low by that call's seconds. No automatic repair; compare with Azure's usage metrics if it matters. Do not re-run increments by hand unless you know which ones failed. |
| 038 failed to apply | Nothing partial remains (one transaction). Fix and rerun `db push`; the Phase 3 app keeps working meanwhile. |
| Need to disable Phase 4 evaluation only | Remove `AZURE_SPEECH_KEY` (Pronunciation hides as "not set up"), keep saving/Word Match. |

Dropping 038's objects is never required for recovery and would lose stored
results; the Phase 3 cutover is never rolled back.

Limitations of in-page state: the recording audio, the per-take save state
and any recovery token live only in the page's memory (never in storage).
After a reload, closing the tab or signing out, an unsaved score can no longer
be saved and its audio is gone — record the sentence again. A token also
expires after `AZURE_RECOVERY_TOKEN_TTL_SEC` (600 s). A wait for an evaluation
running elsewhere is cancelled on reload/unmount; the stored result (if any)
appears from the round restore the next time the page loads.

## 9. Verification performed (local) and what remains

All results below are from the working tree = `3d38124` + the uncommitted
evaluation-wait cancellation and comment/documentation changes. Azure was
always mocked (no quota spent); no test touched the user's Supabase project.

**Real PostgreSQL** — disposable PostgreSQL 17.9 (`embedded-postgres` + the
Supabase shim, see PHASE3_RUNBOOK.md §9; `LOCALDB_ADMIN_URL` pointing at the
local instance), Phase 3 cutover run to `activated` first:

| Suite | Tests | Covers |
|---|---|---|
| `integration/phase4-shadowing` | 16 | practice credit without evaluation, too-short takes, idempotent retry/conflict, cross-user/video/segment/revision rejections, server-resolved reference text, combined coverage, concurrent final-sentence completion (Dictation + Shadowing), independent sequences, stale results, safe expiry, provider failure, recovery idempotency/supersession, Word Match, round restore with three chronological pointers, late take after restart, permissions |
| `integration/phase4-review-fixes` | 7 | two concurrent begins for one attempt (lock wait observed, exactly one admitted, duplicate changes nothing); another attempt and another user admitted while that lock is held; failed/expired replacement + old-seq rejection; completed never re-admitted; audio-duration admission (mismatch / > 21 s / 0 refused); full-result idempotency vs conflict (detail, engine version, late failure); the revoked 035 writers under real roles |
| `integration/phase4-upgrade-and-scripts` | 3 | 037 (activated, populated) → 038: no row changed, Phase 3 app calls still work; `00_preflight.sql` / `01_postflight.sql` as written (13 function rows, 9 definer/invoker rows) |
| Phase 3 real-PG suites | 51 | authoritative 16, review-fixes 15, cutover rehearsal 11, recovery 4, scoring parity 3, migrations-apply 1, operator scripts 1 (run on its 001–037 baseline with the 25-row matrix) |

**Unit/mock (Phase 4):** `practice-evaluate-attempt-scoped` 28,
`practice-attempt-route` 19, `evaluate-recovery-token` 11,
`practice-word-match-and-read-routes` 11, `wav-validation` 6,
`phase4-shadowing-client` 21, `phase4-review-client` 21 (outcome mapping;
polling: pre-aborted signal, abort during an in-flight read, abort during the
delay, answer after abort, settled completed/failed, deadline and read-failure
bounds, GET-only; per-wait cancellation on unmount, scope change, recording
removal, replacement, Strict Mode; cancelled results change nothing).

**Whole-repository runs:**

| Command | Result |
|---|---|
| `npx tsc --noEmit -p .` | pass |
| `npm run lint` | 0 errors, 3 warnings (pre-existing: two in `page.tsx` on untouched lines, one in `SentenceWordInput.tsx`) |
| `npx jest` with `LOCALDB_ADMIN_URL` | 115 suites passed, 4 skipped; 1271 tests passed, 113 skipped, 0 failed |
| `npx jest` without it | 105 suites passed, 14 skipped; 1194 passed, 190 skipped (the 77 real-PG tests above skip cleanly), 0 failed |
| `npm run build` | pass (incl. its TypeScript step) |

The 4 suites skipped in both runs (`phase1-schema`, `phase2-functions`,
`postphase2-privileges`, `transcript-revision-publish`; 113 tests) need a real
Supabase HTTP stack (`PHASE1_IT_*` / `TRANSCRIPT_IT_*`) and were **not run**.
Jest also printed "a worker process has failed to exit gracefully" in both
runs; no test failed, and the source was not identified.

**Not verified:** real Supabase HTTP (PostgREST error shapes for the new
functions, GoTrue), real Azure responses through the new route, the Vercel
environment, 038 on the user's project (not applied), and real browsers/iPhone
(§7 is manual).
