# Learning Reports P5 runbook — AI assessment, more explanations, recovery, quota admission

**Status (2026-10-05):** **044 is applied to Supabase and P4 is deployed, both user-confirmed.**
P5 app deployment and P5 browser verification remain **unknown**. The forward correction in
045 is prepared and tested locally only; it has not been applied remotely by this work.
No remote SQL, deployment, commit/push, Gemini/Azure call or environment configuration change
was performed during this correction. Earlier P5 verification used mocked routes/components,
disposable PostgreSQL 17.6 and a disposable Redis 5 Lua engine; see §11 for this correction's tests.

| | |
|---|---|
| Applied migration | `supabase/migrations/044_ai_assessments.sql` — leave unchanged |
| Forward correction | `supabase/migrations/045_assessment_finish_identity.sql` — 045 was the next free local number |
| Operator scripts (read-only) | `supabase/assessments_p5/01_postflight.sql`, `02_identity_postflight.sql`; `00_preflight.sql` is only for databases **before** 044 |
| Design | `.claude/learning-reports-review-plan.md` §7–§10, status §12.6 |
| Prerequisite | P4 — see §0 |

## 0. Prerequisites (production)

| Item | Evidence | State |
|---|---|---|
| `043_saved_explanations.sql` applied | user-reported | done |
| P4 postflight passed: 94 copyable legacy explanations with exactly one copy each; no inconsistent notes or duplicate legacy ids; capture trigger enabled; `preserved_after_legacy_delete = 0` (information only) | user-reported | done |
| **P4 app deployed** | user-confirmed, 2026-10-05 | **done** |
| **P4 browser checks** (`P4_EXPLANATIONS_RUNBOOK.md` §4) | — | **not recorded — required** |
| **044 applied to Supabase** | user-confirmed, 2026-10-05 | **done** |
| **045 applied to Supabase** | local tests only | **pending** |
| **P5 app deployed / browser checks** | — | **unknown / unknown** |

Record the outstanding P4 browser evidence before a future P5 app rollout. The additive 045
database correction can be applied independently of P5 app deployment.

**044 provenance.** It was untracked at the start of this correction. Its local function still
had the accepted-retry identity bug, and its table comment still incorrectly excluded every
application role from hash access; neither correction had been made locally. No 044 edits were
moved or reverted, and unrelated working-tree changes were preserved. The unchanged local file's
SHA-256 is `853c6ffa63e518ef41833ac037c5c2741479d61b4ce264426c234264d921d4ea`.
The upgrade tests use this original local 044, consistent with the supplied SQL. **The exact bytes
applied remotely cannot be established from Git or the user confirmation alone**, and no remote
query was made. This hash identifies the tested local baseline, not a verified remote checksum.
Do not edit/replay 044, repair migration history, reset the database or delete its tables. An
edited migration already recorded as applied is not reapplied by a later `db push`.

## 1. What ships

| Action | Behaviour |
|---|---|
| **Generate / Update / Regenerate assessment** (`POST /api/session/[id]/assessment`) | Produces the overview and, when targets are missing, the first missing explanation batch (≤ 35) in **one** admitted provider request. At most one more admitted request is used, only as a parse retry, so the label reads "Uses up to 2 AI requests". A compatible saved assessment (same learning-data fingerprint, prompt version and model) is **reused**: no admission, no provider call. *Update* is offered when the learning data changed; *Regenerate* when the saved one uses an older prompt or model. Neither ever runs automatically. |
| **Explain more** (`POST /api/session/[id]/explanations`, `intent: "missing"`) | Generates notes only, for the next ≤ 35 missing targets. The overview is never touched, and saved notes are never paid for again (the database re-checks this under the round lock). One batch per click; no automatic loop. |
| **Re-explain** (`intent: "reexplain"`, `sentences` required) | Explicit replacement for the selected sentences. Older notes stay stored and rank below the new ones by `seq`. |
| **Save** (`POST /api/session/[id]/assessment/recover`) | Stores a result that was generated but couldn't be saved. Runs the same finish RPCs as a direct save, with no provider call and no quota use. |
| Report GET | Read-only `ai` block: the accepted assessment, or the legacy fallback; freshness and version as separate facts; `generating`; target counts. |
| Stale tabs | `POST /api/session/[id]/explain-all` is kept as a compatibility adapter. It runs exactly the Generate pipeline and answers in the old response shape. |

**Input.** The input is built on the server only, from the owned round's stored attempts and
`fn_round_report` (pinned script).
- It uses the report's canonical metrics: latest-answer correctness; correctness across valid
  answers, labelled separately; currently incorrect, corrected and distinct-ever-incorrect counts;
  eligible sentences; history completeness. First try and best run are included only when the
  history supports them. `learning_sessions.accuracy` is never sent.
- Evidence ids are `S<n>`. Each item is one of: currently incorrect, corrected, correct evidence
  (positive, capped at 12) or unavailable.
- Up to `AI_INPUT_CHAR_BUDGET` characters of evidence are sent individually; the rest goes in as
  counts only. The UI shows the split ("Gemini saw X sentences individually and Y only as counts").
- Learner and transcript text are JSON-encoded. A system instruction marks them as untrusted and
  forbids claims about listening, attention, grammar mastery or pronunciation.

**Output validation.**
- Unknown target ids are dropped, and repeated ids keep only their first occurrence.
- Empty explanations don't count.
- A strength must cite correct or corrected evidence.
- A "duplicate" note survives only when it points at an explanation in the same request; the two
  are stored atomically.
- An unusable overview is abandoned: it never overwrites the saved one.
- Truncation (`finishReason = MAX_TOKENS`) is reported as incomplete coverage.

**P4 minor/duplicate gap, closed in 044.** `attempt_explanations.note_kind` is one of
`explanation`, `minor` or `duplicate`, with `ref_attempt_id` for duplicates. A non-empty minor or
duplicate note is stored honestly and counts as covered. An empty one is never stored.

## 2. Limits (stated, not hidden)

- **Not exactly-once.**
  - A lease lasts 120 s. A worker slower than that can overlap a later generation; the older result
    then gets `superseded`, and an older explanation batch is kept as history.
  - Timeouts and ambiguous provider outcomes stay spent; nothing is refunded.
  - A lost admission reply is also spent: retrying the same id returns `duplicate`, which never
    authorises a provider call.
- **Recovery** works only within 24 h, from the same browser session (sessionStorage), while the
  signing secret is unchanged. After that the result is lost, and the quota was still used.
- **Application quota, not the provider's.** The application counts by calendar day in
  `GEMINI_QUOTA_TZ` (default UTC), labelled "shared app limit · resets 00:00 <tz>". Google's own
  limits and reset time are an operator check (§7) and are not claimed to match.
- **The old app after rollback** can read the mirrored legacy assessment. It cannot save over a
  round whose new-format assessment was accepted (§6).

## 3. Configuration (operator; nothing was changed here)

| Variable | Required | Meaning |
|---|---|---|
| `GEMINI_API_KEY` | yes | Unchanged. |
| `GEMINI_MODEL` | no | Unchanged (default `gemini-3.6-flash`). Changing it makes saved assessments show "earlier assessment version — Regenerate". Nothing regenerates automatically. |
| **`AI_RECOVERY_SIGNING_SECRET`** | **yes (new)** | ≥ 32 random characters, server-only, distinct from `AZURE_RECOVERY_SIGNING_SECRET`. Without it, the AI actions answer 503 **before** any database or quota work. Rotating it makes recovery tokens already issued fail as invalid. |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | **yes in production** | When they are missing or failing, new Gemini calls fail closed (503) in production. Reports and saved results keep working. |
| `GEMINI_RPM_LIMIT`, `GEMINI_RPD_LIMIT` | no | Shared application limits (defaults 5 and 20). |
| `GEMINI_USER_RPD_LIMIT` | no | Per-user daily limit. Unset means no separate limit (it equals the shared one). |
| `GEMINI_QUOTA_TZ` | no | IANA time zone for the calendar-day keys (default `UTC`). |
| `GEMINI_QUOTA_ENV` | no | Key prefix separating environments (default `VERCEL_ENV`, then `NODE_ENV`). Set distinct values for preview and production when they share one Redis. |
| `GEMINI_QUOTA_FAIL_OPEN` | no | `true` lets local development call Gemini without Redis (unmetered). **Ignored in production.** |
| `AI_INPUT_CHAR_BUDGET`, `AI_TOKENS_PER_EXPLANATION` | no | Input evidence budget (default 60 000 characters) and the per-note output estimate (default 180 tokens; the batch is never larger than 35). |

**P5 Redis keys** (P5 code no longer uses `gemini-quota:rpm|rpd`; live P4 servers still do):

| Key | TTL |
|---|---|
| `gemini:<env>:rpm:<epochMinute>` | 120 s |
| `gemini:<env>:rpd:<YYYY-MM-DD>` | 2 d |
| `gemini:<env>:urpd:<userId>:<YYYY-MM-DD>` | 2 d |
| `gemini:<env>:adm:<type>:<operationId>:<attempt>` | 2 d |

### 3.1 Quota transition and rollback accounting (operator procedure)

There is **no counter migration, dual read/write or shared admission bridge** between P4 and P5.
P4 uses `gemini-quota:rpm` (60 s from the first increment) and `gemini-quota:rpd` (86 400 s from
the first increment). P5 uses epoch-minute RPM buckets and calendar-day RPD keys in
`GEMINI_QUOTA_TZ`; the 2-day TTL is retention, **not** the daily reset. These windows differ.

- Existing P4 consumption is not included in a newly empty P5 namespace. The P5 display may
  show zero even though the provider has already been used. This does not reset provider quota.
- Mixed P4/P5 **server instances** spend from independent counters. A stale browser served by
  P5 uses the P5 adapter and admission, but a request reaching a P4 server still uses P4 quota.
  P5's atomic admission cannot enforce a combined cap across the two implementations.
- Before app cutover, pause new Gemini work on **all** reachable old deployments/aliases and
  let in-flight requests finish, including explanation and translation requests. Record old
  usage/TTL and actual provider usage. Resume only after old writers are drained and either
  (a) a confirmed provider reset and a fresh P5 application window, or (b) an operator-approved
  temporary cap bounded by the provider's remaining budget. If remaining usage is uncertain,
  keep new Gemini work paused until it is known; do not assume waiting for a P4 key to expire
  equals the provider reset. A temporary cap is an operator configuration decision, not an
  automatic feature; account for the parse retry as a separate request.
- Keep `GEMINI_QUOTA_ENV` and `GEMINI_QUOTA_TZ` stable through the day. Changing either may
  select fresh counters. Separate preview/production namespaces isolate app accounting but
  still share provider capacity if they use the same provider project; plan the aggregate budget.
- App rollback switches back to the old keys, which exclude P5 usage and may have expired.
  Drain P5 writers and reassess the remaining provider budget before resuming P4 Gemini calls.
  Keep both key sets until normal TTL expiry; deleting/resetting keys does not refund usage.
  Rollback also restores P4's older quota implementation and its failure behavior.

045 changes no quota code, counters, keys, grants or environment settings. All transition actions
above are documented operator work, **not performed by this local correction**.

## 4. Permissions and invariants (checked by `01_postflight.sql`)

| Object | anon | authenticated | service_role |
|---|---|---|---|
| `round_assessments` | — | SELECT own rows (RLS) | SELECT |
| `assessment_generations` | — | SELECT own rows, **columns only**: round_id, generation, fingerprint, prompt_version, model, state, lease_expires_at, created_at, finished_at (never `token_hash` or `payload_hash`) | SELECT entire table, **including hashes** |
| `fn_assessment_begin / _finish / _abandon` | — | — | EXECUTE |
| `fn_explanations_finish` (replaced, same signature) | — | — | EXECUTE |
| `fn_persist_session_assessment` (replaced, same signature) | — | — | EXECUTE |
| `fn_assessment_legacy_mirror` | — | — | — |

No application role can INSERT, UPDATE or DELETE these tables; writes happen only inside the
SECURITY DEFINER RPCs, all with `search_path = public, pg_temp`.

**Per-round lock.** Every AI writer, the legacy writer included, first locks the round row with
`FOR NO KEY UPDATE`. It then locks, in this order only: `round_assessments`, then
`assessment_generations`, then `explanation_operations`.

**Invariants**
- The accepted generation's row is `accepted`, with the same payload hash.
- Owners are consistent across the tables.
- The legacy column equals `fn_assessment_legacy_mirror(accepted_payload)` for every round with an
  accepted assessment.
- No generation is numbered above `latest_started_generation`.
- Every duplicate note points at an explanation saved by the same operation.
- P4 capture is still enabled.
- Finish checks ownership and token before identity. `fingerprint`, `prompt_version` and `model`
  must match the requested generation's **own** row using `IS DISTINCT FROM` (NULL also fails).
  Only then can an identical accepted retry return `already_accepted`, or changed payload/meta
  return `conflict`. A historical accepted retry never rewrites a newer result or legacy mirror.

## 5. Forward rollout after applied 044 (045 prepared, not performed)

Apply the database correction first. P5 app rollout is a separate operator step whose current
status must be established, not assumed. The correction does not require a provider request.

1. **Review migration state and baseline, read-only, as project owner.** Confirm the recorded
   migration list is consistent with applied 044 and has no conflicting 045. If 044 was applied
   manually without a CLI history entry, do not use `db push` to replay it or repair history as
   part of this fix; use the SQL-editor route below. Run `01_postflight.sql` and save all results;
   every `ok` must be true. Do **not** use `00_preflight.sql`: its expected absence of 044 is now
   intentionally false. Capture the installed definition for comparison with the local baseline:

   ```sql
   select pg_get_functiondef(
     'public.fn_assessment_finish(uuid,uuid,integer,uuid,text,integer,text,jsonb,jsonb)'::regprocedure
   );
   select obj_description('public.assessment_generations'::regclass, 'pg_class');
   ```

   If the installed body has unrelated differences, review them before replacing it; this file
   replaces the whole function body. Save the preflight privilege and invariant outputs. For
   exact row comparisons on a quiet database, take private before/after snapshots of
   `round_assessments`, `assessment_generations`, `learning_sessions` and saved explanations,
   including timestamps and hashes. With active writers, unrelated legitimate writes can change
   these snapshots; coordinate a quiet window if exact comparisons are required.
2. **Apply only `supabase/migrations/045_assessment_finish_identity.sql`.** In the Supabase SQL
   editor, paste the complete file and run it as project owner, including its `begin`/`commit`.
   Alternatively, only when CLI migration history already records 044, review
   `supabase db push --dry-run` and proceed with `supabase db push` **only if 045 is the sole
   pending migration**. Do not use `--include-all`, migration repair, reset, rollback or replay
   of 044. Stop if the pending list differs. The new file replaces the same function signature
   and corrects the table comment in one transaction; existing data, owner and ACLs are retained.
3. **Postflight, read-only:** run `01_postflight.sql`, then `02_identity_postflight.sql`.
   Every `ok` must be true. Compare the grant matrix to the saved preflight: authenticated still
   has only its granted generation columns; service_role still reads hashes; only service_role
   executes the writers. Confirm zero owner/hash/mirror mismatches and P4 capture still enabled.
   The new script checks identity validation precedes accepted retries and verifies the corrected
   comment. It inspects source structure; behavioral regression evidence is the local upgrade
   test in §11. No live-generation token or provider call is needed for these checks.
4. **Establish P5 app status.** If rollout is still pending, record P4 browser evidence, review
   required configuration (§3) and execute the quota-transition procedure (§3.1) before deploying
   P5. If P5 is already deployed, record evidence and assess any mixed-server quota exposure.
   Do not infer deployment from 044 being present. Configuration/deployment are operator work.
5. Run both postflight scripts again after any app rollout, then checks without provider calls
   (§8) and browser checks (§9). The optional real-Gemini check (§10) requires a separate explicit
   decision to spend quota. Record actual results; until then deployment/browser status stays unknown.

## 6. Mixed versions and rollback

**During the deploy window**
- An old (P4) tab's "Get AI assessment" calls `explain-all`. On a P5 server this runs the P5
  pipeline, with the same admission and storage, so stale tabs can't bypass the quota.
- An old *server* instance still runs P4 code. Its legacy writer is refused only for rounds that
  already have an accepted new-format assessment; its explanation saves keep working, because the
  finish signature and ordinary item hashes are unchanged.
- Its quota counters remain independent of P5's; follow §3.1 before cutover or app rollback.
- A round becomes new-only at its first **accepted** generation, not at its first begin.

**Rollback (app only)**
- The tables, columns and functions stay. Keep both 044 and 045 applied; do not undo the identity fix.
- The old app reads `learning_sessions.ai_assessment`, which holds the mirror of the latest
  accepted assessment.
- **Limitation:** the old app can't save a new assessment for rounds whose new-format assessment
  was accepted. It shows the output, but the result is lost on reload. Other rounds behave as
  before.
- Restoring unconditional legacy writes would be a forward migration and an explicit operator
  choice. The postflight's `mirror_mismatch` would then be expected.
- Unsaved P5 results in browsers can no longer be recovered by the old app.

## 7. Operator decisions and checks

1. **Google's real limits and reset time** for the project and model: set `GEMINI_RPM_LIMIT` and
   `GEMINI_RPD_LIMIT` at or below them, and choose `GEMINI_QUOTA_TZ`. Not verified here.
2. **Per-user daily limit**: whether to set `GEMINI_USER_RPD_LIMIT` (unset by default).
3. Whether separate environments share one Redis (then set `GEMINI_QUOTA_ENV`).
4. Raising the 35-target cap stays deferred until token-usage logs exist. Provider usage metadata
   is logged as counts only (`[gemini] … tokens=prompt/output`), never with learner text.

## 8. Checks without provider calls

- Open a report: the network panel shows only GETs (report, quota, vocabulary). No `/assessment`,
  `/explanations` or `/recover` POST.
- A round with only a legacy assessment shows "Earlier assessment (earlier format, freshness
  unknown)".
- `GET /api/ai/quota` returns `configured: true`, the shared counts, and `resetsAt`.
- Run `01_postflight.sql` and `02_identity_postflight.sql` again after a day of use.

## 9. Browser and iPhone checklist

- Desktop and iPhone widths: the AI block's buttons and cost lines wrap without horizontal scroll;
  the "Re-explain" checkboxes are reachable.
- "Practice changed…" and "Made with an earlier assessment version." appear as two different
  states.
- During a generation the last saved assessment stays visible with "Generating a new assessment…",
  and the page polls only GETs (bounded to about one minute).
- Simulate a save failure on a non-production deployment: "Not saved yet" with Save, one automatic
  retry, and the result survives a reload.
- Sign out, or switch account: no pending save or unsaved note from the previous account appears.
- Quota exhausted: the actions are disabled; saved results and explanations stay readable.

## 10. Optional real-Gemini end-to-end check (operator-run; uses quota; NOT executed here)

On a non-production deployment with a test account and a short round:
1. Generate assessment. Expect 1 request (2 with a parse retry), the overview, and "Explained N of M
   requested".
2. Reload. Expect the same assessment with "Based on your current answers", and no new request.
3. Answer one sentence again, then reload. Expect "Practice changed…", and Update is offered but
   not run.
4. Explain more once. Only missing targets are requested; the overview is unchanged.
5. Check the quota counter: it rose by exactly the number of requests shown.

## 11. Verification performed (local)

The correction was tested on a separate, disposable PostgreSQL 17.6 cluster listening only on
`127.0.0.1:55435`. The harness created and dropped only its randomly named test databases; it
did not connect to Supabase or an existing application database. The cluster was stopped after
verification. No environment variable was
changed: the test runner passes the local connection through Jest test globals.

```text
node scripts/localdb/test-p5-assessments.cjs postgresql://postgres@127.0.0.1:55435/postgres
```

Supply the URL of your own disposable local PostgreSQL server (15+ with ICU); non-local hosts
are refused. The server must already be running. **25/25 P5 PostgreSQL tests passed**, including:

- Original 001–044 applied first, with an assessment accepted and an explanation saved under 044.
- The same identity assertion fails on original 044 for changed/NULL fingerprint, prompt version
  and model: expected `invalid_identity`, observed `already_accepted` in all six cases. The suite
  logs these results and passes only if the old regression is actually reproduced.
- Apply 045 to that populated database: all six assertions pass. Whole stored rows (including
  timestamps, hashes, legacy mirror and saved explanations), function OIDs/owners/ACLs, table and
  column grants, and RLS policies match their before-upgrade snapshots exactly.
- Ownership/token precedence; matching and reordered-key retries; payload and metadata conflicts;
  started/expired identity checks; accepted historical retries after a newer begin and acceptance;
  no writes from rejected, conflicting, superseded or historical retry calls.
- Both real concurrent legacy-writer lock orders, supersession, late finish, note kinds,
  authenticated column/RLS enforcement and service-role hash access remain covered.
- Both postflight scripts pass after the upgrade. The 043 → 044 compatibility tests still pass.

Repository-wide checks for this correction: `npm run lint` passed (0 errors, 3 existing warnings);
`npm run build` passed; `npm test -- --runInBand` passed (134 suites / 1,567 tests passed;
24 integration suites / 326 tests skipped without their opt-in local services). The 25 P5
PostgreSQL tests above were run separately with the local service enabled. Redis integration
was not rerun for this SQL/documentation correction. On Windows these npm commands used
`npm.cmd` because the local PowerShell execution policy blocks `npm.ps1`.
Earlier P5 implementation evidence remains in `.claude/learning-reports-review-plan.md` §12.6;
it does not establish remote P5 deployment or browser status.
