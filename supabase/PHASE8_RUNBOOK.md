# Phase 8 runbook — Retirement of the pre-cutover write path

**Status:** implemented and verified locally (route/client tests, the integrated practice page and
real PostgreSQL on a disposable local server). **Not deployed.** Per the user, `001`–`040` are
applied, Phase 3 is activated (the `fn_legacy_*` bridges were dropped by `fn_phase3_activate()`),
and the Phase 4–6 postflights passed.

Phase 7 stays retired: it was merged into Phase 1 (migration `030_practice_round_active_uniqueness.sql`).
Nothing was renumbered.

## 1. What changed

| Area | Before | After |
|---|---|---|
| `PRACTICE_WRITE_PATH` | Read by `src/lib/practice/writePath.ts`. `legacy` sent the three practice routes to the Phase 2 bridges. | **No longer read.** The module was deleted; the routes always use the authoritative functions. |
| `POST /api/session/save-progress` | Legacy branch → `fn_legacy_save_progress` (passed the client's `status`/`accuracy`/`totalAttempts`). | Only `fn_update_resume_position` / `fn_create_or_get_active_round`. Deprecated fields from old tabs are accepted and ignored; `status: "completed"` never completes a round. |
| `POST /api/session/restart` | Legacy branch → `fn_legacy_restart_round`. | Only `fn_restart_round`. |
| `POST /api/dictation/check` | Legacy branch → `ownsSession` + service-role `fn_legacy_record_dictation_attempt`. | Only `fn_record_dictation_attempt` with the caller's own client. |
| Practice client | Every checkpoint save sent `accuracy`, `totalAttempts` and `status` (`"completed"` at the end of the video). | Sends position and identity only. Completion stays server-owned. |
| Dead helpers | `legacyBridgeErrors.ts`, `ownsSession`, `selectAccuracy`, the old `listening_sessions` request/response types. | Removed. |

**Already retired before this pass:**
- the `fn_legacy_*` bridges themselves (dropped by Phase 3 activation);
- the old Listening session routes (Listening uses `/api/listening/sync` and `/progress` since Phase 5);
- direct table writes to `learning_sessions` / `attempt_logs` (revoked in Phase 3);
- client-trusted completion on the server (ignored since Phase 3).

## 2. SQL

**None.** No migration was added. The authoritative functions, write-gate protections, migrations,
audit logs, provenance and the Phase 3 operator/recovery scripts are unchanged.

## 3. Environment variables

- `PRACTICE_WRITE_PATH` is **ignored**. You may delete it from Vercel and `.env.local` at any time;
  leaving it set has no effect.
- **If an old `PRACTICE_WRITE_PATH=legacy` remains configured:** nothing changes. The app uses the
  authoritative functions regardless, so it can no longer select the dropped bridges. Before this
  release, that setting made every save, restart and recorded answer fail with PGRST202.
- No other variable changes.

## 4. Deployment

1. Deploy this codebase. Migration order doesn't matter: no SQL.
2. **Compatibility with open tabs.**
   - Old tabs still send `accuracy`/`totalAttempts`/`status`. The server accepts and ignores them,
     so their checkpoints keep saving and nothing is completed by the client.
   - The response contracts are unchanged.
3. Run the smoke checks (§5).

## 5. Manual smoke checks (desktop and iPhone)

- [ ] **Dictation:** answer a sentence → it's saved (reload keeps it); a network retry doesn't duplicate it; finishing every sentence shows the round as complete (server decision).
- [ ] **Resume:** leave mid-video, reopen → same sentence and position; no new round.
- [ ] **Mode switch / reload:** switch modes and reload a few times → still the same round (History shows no extra round).
- [ ] **Shadowing:** record a take, evaluate it, reload → the take and its result are still there.
- [ ] **Listening:** play a Listening-only video (no round), leave and come back → resumes at its checkpoint; still no round.
- [ ] **Restart:** "Practice again (new round)" → asks, creates a new round; the old round's report still opens from History.
- [ ] **Reports:** a completed round's report and a legacy ("Completed earlier (unverified)") round both open and show their labels.

## 6. Rollback

- **App:** rolling back to the Phase 6 build is safe as long as its environment leaves
  `PRACTICE_WRITE_PATH` unset or `authoritative`.
  - With `legacy`, the Phase 6 build would call the dropped bridges and fail (PGRST202).
- **Database:** nothing to roll back. Phase 3's activation is one-way by design: the bridges can't
  be restored, and the legacy write path can't be reopened. Historical data is untouched.

## 7. Retained on purpose (historical / compatibility)

- **Migrations and SQL:**
  - Migrations `001`–`040`, including `035`'s bridge definitions (applied history).
  - `supabase/phase3/*` operator, rehearsal and recovery scripts, and `PHASE3_RUNBOOK.md` (its
    `PRACTICE_WRITE_PATH` steps are marked historical).
  - The `app_write_gate` table and its checks, which the authoritative functions still use.
- **Upgrade tests:**
  - Real-Postgres tests that replay the original cutover (`phase3-*`), including the bridge
    drain/drop scenarios.
  - The Supabase-HTTP Phase 2 suite (skipped without `PHASE1_IT_*`).
- **Server code:**
  - `mapPracticeWriteMessage` still maps `legacy_writes_retired` to a retryable 503 (harmless).
  - `SaveProgressRequest` keeps the deprecated `accuracy`/`totalAttempts`/`status` fields
    (optional, documented as ignored) so old tabs type-check against the real contract.
- **Data and readers:**
  - `learning_sessions` keeps its name; the optional rename to `practice_rounds` was not done.
  - Provenance (`legacy_unverified`), legacy completion labels, and the readers of historical
    rounds/attempts.
  - The client session store's attempt counters, which feed the in-page session snapshot
    (a display concern, not a write).

## 8. Verification performed (local)

See the plan's Phase 8 status for the exact counts. Not verified: Supabase HTTP, a real browser,
iPhone, production.
