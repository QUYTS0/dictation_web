# Phase 4 runbook — Shadowing server-side persistence

Baseline (confirmed by the user): migrations `001`–`037` applied, Phase 3
cutover **activated** (`legacy_writes_retired = true`,
`authoritative_writes_active = true`, 25/25 permission checks, legacy bridges
removed), Vercel `PRACTICE_WRITE_PATH=authoritative`. Phase 4 never touches the
Phase 3 cutover: nothing here pauses writes, reopens a legacy path or rolls the
cutover back.

## 1. What ships

| Piece | Where |
|---|---|
| Migration `038_phase4_shadowing_persistence.sql` | additive: 4 nullable columns on `shadowing_attempts`, evaluation lifecycle + read functions |
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
   then sends `attemptId` + audio. The server: checks configuration → auth →
   `fn_begin_azure_evaluation` (ownership, relationships, reference text from
   the pinned segment, `seq + 1`, `pending`) → quota (by stored duration) →
   Azure → `fn_finish_azure_evaluation(attempt, user, seq)`.
5. **Persist**: applied only for the current seq while pending. A superseded
   response is shown as "replaced, not saved". A provider failure stores
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
| `fn_begin_azure_evaluation(uuid,uuid)` | SECURITY DEFINER, `search_path=public, pg_temp` | ✗ | ✗ | ✓ |
| `fn_finish_azure_evaluation(uuid,uuid,integer,text,numeric×5,jsonb,text,text)` | SECURITY DEFINER | ✗ | ✗ | ✓ |
| `fn_expire_azure_evaluation(uuid,uuid,integer)` | SECURITY DEFINER | ✗ | ✗ | ✓ |
| `fn_record_word_match(uuid,uuid,text,numeric,numeric,jsonb)` | SECURITY DEFINER | ✗ | ✗ | ✓ |
| `fn_get_shadowing_attempt(uuid)` | SECURITY INVOKER (owner RLS) | ✗ | ✓ | ✗ |
| `fn_shadowing_round_results(uuid)` | SECURITY INVOKER (owner RLS) | ✗ | ✓ | ✗ |
| `fn_shadowing_attempt_dto(shadowing_attempts,boolean)`, `fn_shadowing_eval_timeout_sec()` | helpers used by the reads | ✗ | ✓ | ✗ |

Every service-role function takes the user id the route verified with GoTrue
and re-checks `(attempt, user)` itself. No table grant changes: users keep
SELECT-only on `shadowing_attempts`, and `learning_sessions`/`attempt_logs`
stay SELECT-only for every app role. 035's `fn_persist_azure_result` /
`fn_persist_word_match_result` are left as they were (service_role, part of the
Phase 3 matrix) and are no longer called.

Evaluation rules: one successful Azure result per recording
(`azure_already_evaluated` → re-record for a new score); a failed or expired
evaluation can be retried on the same saved take; a pending request older than
120 s is reported as failed/`expired` by the reads and lazily written by
`GET /api/practice/attempt/[id]` — only for that exact seq, never a newer one;
a real result for the newest seq still replaces its own `expired` marker.
Unavailable provider metrics (e.g. prosody) stay NULL.

Trust boundaries (documented, unchanged in kind): practice validity is
duration-based and client-reported; Word Match's recognized text comes from
the browser's speech recognition (no server transcription is added) but its
scores are computed by the server; Azure scores come only from the server's own
provider call (or a token the server signed for that exact result).

HTTP errors: `409 stale_client_version` + `action: "reload_required"` (evaluate
without `attemptId`), `401` not signed in, `404 attempt_not_found` /
`round_not_found`, `409 attempt_not_evaluable | azure_already_evaluated |
reference_unavailable | attempt_relationship_invalid |
word_match_already_recorded | recovery_superseded`, `410
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
   `038` as the only pending migration). Compatible with the deployed Phase 3
   app: additive only, no grants or rows changed.
4. **Postflight** — `supabase/phase4/01_postflight.sql`: every `ok` true (4
   column rows, 12 function rows, 8 definer/invoker rows, table privileges).
5. **Deploy the Phase 4 app** and confirm 100% of instances are on the new
   build.
6. **Manual checks** (§7), then run `01_postflight.sql` §5 again: counts grow,
   `azure_overdue_pending` stays ~0.

Order constraints: the migration must precede the app (the new app without
038 → evaluation/restore `503 evaluation_unavailable`; saving takes still
works). The secret must be present when the app deploys, or Pronunciation
shows "not fully set up" (Word Match and practice credit are unaffected).

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
| Evaluations stuck `pending` | None needed: the reads report them expired after 120 s and a new Evaluate is allowed on the same take. `01_postflight.sql` §5 shows the count. |
| 038 failed to apply | Nothing partial remains (one transaction). Fix and rerun `db push`; the Phase 3 app keeps working meanwhile. |
| Need to disable Phase 4 evaluation only | Remove `AZURE_SPEECH_KEY` (Pronunciation hides as "not set up"), keep saving/Word Match. |

Dropping 038's objects is never required for recovery and would lose stored
results; the Phase 3 cutover is never rolled back.

## 9. Verification performed (local) and what remains

Executed on a disposable PostgreSQL 17.9 (`embedded-postgres` + the Supabase
shim, see PHASE3_RUNBOOK.md §9), Phase 3 cutover run to `activated` first:

| Suite | Tests | Covers |
|---|---|---|
| `integration/phase4-shadowing` | 16 | practice credit without evaluation, too-short takes, idempotent retry/conflict, cross-user/video/segment/revision rejections, server-resolved reference text, combined coverage, concurrent final-sentence completion (Dictation + Shadowing), independent sequences, stale results, safe expiry, provider failure, recovery idempotency/supersession, Word Match, round restore with three chronological pointers, late take after restart, permissions |
| `integration/phase4-upgrade-and-scripts` | 3 | 037 (activated, populated) → 038: no row changed, Phase 3 app calls still work; `00_preflight.sql`/`01_postflight.sql` as written |
| Phase 3 real-PG suites (rerun with 038 present) | 51 | unchanged, incl. the Phase 3 postflight's 25-row matrix |

Unit/mock (Azure always mocked, no quota spent): `practice-attempt-route` (19),
`practice-evaluate-attempt-scoped` (15), `evaluate-recovery-token` (10),
`practice-word-match-and-read-routes` (11), `phase4-shadowing-client` (21),
`auth-shadowing-cache` (3), `phase3-submission-client` (+3 Phase 4 cases).

**Not verified:** real Supabase HTTP (PostgREST error shapes for the new
functions, GoTrue), real Azure responses through the new route, the Vercel
environment, and real browsers/iPhone (§7 is manual).
