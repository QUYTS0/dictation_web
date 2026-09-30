# Phase 5 runbook — Listening coverage, checkpoints and activity pulses

Baseline: migrations `001`–`038` applied, Phase 3 cutover activated, Phase 4
live. Phase 5 changes no table definition, row or existing grant and never
touches the Phase 3 cutover or the Phase 4 evaluation lifecycle.

**Status:** implemented locally, uncommitted. `039` has **not** been applied
to the user's project and the app has **not** been deployed (the repository
shows `039` as an untracked, never-committed file; nothing here can confirm
the remote state beyond that).

## 1. What ships

| Piece | Where |
|---|---|
| Migration `039_phase5_listening_activity.sql` | `fn_sync_study_activity` (the routes' single, atomic entry point), internal `fn_apply_study_flush`, `fn_flush_study_activity` kept (same signature/grants, now a wrapper), index `activity_flush_log(flush_batch_id)` |
| `POST /api/listening/sync` | Listening coverage + checkpoint flush (raw media-time intervals, replays included) |
| `POST /api/study-session/activity` | engaged wall-clock intervals (estimated active practice time) |
| `GET /api/listening/progress?videoId=&transcriptId=` | the caller's coverage and checkpoint for one revision |
| Removed | `/api/listening-session/resume`, `/api/listening-session/save-progress` (no caller since before Phase 1) |
| Client | `ListeningIntervalTracker`, `practiceFlushCoordinator` (app-level), `NavigationFlushObserver` (in `Providers`), `useListeningCoverage`, `useActivityPulse`, `usePracticeActivitySources`, player BUFFERING handling, a coverage line in Listening mode |
| Operator SQL | `supabase/phase5/00_preflight.sql`, `01_postflight.sql` (both read-only) |

Numbering: Phase 5 takes `039`. The Script Versions deletion migration the
plan had reserved as `039` (never created) takes the next free number when
Phase 9 is built — creating a lower number after a higher one is applied would
make `supabase db push` refuse without `--include-all`.

## 2. Batches and study-session attribution

What is fixed, and when:

| Thing | Fixed when | By |
|---|---|---|
| user, video, revision, **round** | an observation is recorded | the page (`FlushIdentity`); observations with different identities never share a batch |
| payload + `flushBatchId` | the buffer is sealed (a flush is requested) | the coordinator; a sealed batch is immutable — later observations form the next batch |
| study session | the database transaction | `fn_sync_study_activity`; the client never names a session |

`fn_sync_study_activity`, in one transaction under the `(user, video)`
advisory lock every round-lifecycle function uses:

1. **Replay first, no side effects.** A `flushBatchId` this user already
   recorded is answered from the session it was recorded under
   (`processed: false`, `attribution: "replay"`); a different payload under
   the same id is refused (`409 flush_batch_id_reused_with_different_payload`).
   A retry therefore cannot escape deduplication by reaching another session —
   after a lost response, a Restart, a session rollover or any delay — and the
   additive counters are applied once.
2. **Otherwise, attribution by the round the data was observed under**
   (relationship-checked: the round must be the caller's, for this video):

   | Observed round vs. now | Age of newest observation | Result |
   |---|---|---|
   | still the video's current round (or no round, and none exists) | ≤ 30 min | `current`: the ordinary session rule (reuse the open session, or close an expired one and open the next) |
   | superseded — abandoned, another round is now active, or observed round-less while a round now exists | any | `late` |
   | current | > 30 min | `late` |

   **Late data** goes to the most recent session of *that* round. It is never
   rerouted to a new round's session; it does not reopen the session, close
   any other, change its round, or move `last_activity_at` / `ended_at`. If
   that round never had a session the batch is refused
   (`409 late_activity_without_session`) and dropped.

   The age is a client-side *difference* (`observedAgeSec` = send time −
   observation time), so a skewed client clock does not affect it; it is not
   part of the batch fingerprint.

Listening coverage itself is per (user, video, revision) — not per round or
session — so late data still counts toward coverage; only the session
counters follow the rule above. A batch observed under revision A is always
credited to revision A, also after the script is regenerated.

Pending data is only ever sent while its own account is signed in; switching
accounts or signing out drops it (sign-out first flushes, bounded to 2.5 s).

## 3. Listening coverage and checkpoint

Three independent values:

| Value | Meaning | Where |
|---|---|---|
| `covered_intervals` / `covered_sec` / `coverage_ratio` | **unique** media time listened, against the union of the revision's valid sentences (gaps and empty sentences excluded); only grows | `listening_progress` |
| `last_position_sec` | **checkpoint** — resume convenience; last-writer-wins; moves backward when the listener goes back; never feeds coverage | `listening_progress` |
| `listening_observed_sec` / `listening_newly_covered_sec` | replay-inclusive observed time / unique time newly credited, per study session | `study_sessions` |

- The player reports its position every 200 ms **while PLAYING** plus every
  state change. Nothing is sampled while paused or buffering.
- `ListeningIntervalTracker`: rate-aware continuity (`expected = last +
  elapsed × rate`); a deviation above 2 s is a seek — the skipped span is
  never credited; a wall-clock gap above 5 s (suspended tab) starts a new
  interval. Replays are sent as observed (never merged client-side).
- The checkpoint sent with a batch is the last playhead **sampled while
  playing since the previous hand-over** — otherwise none. Opening Listening,
  re-entering it, or leaving without playing sends nothing, so a saved
  checkpoint is never overwritten by the player's default `0` or by a stale
  position. A real return to the beginning is a real (small, non-null)
  checkpoint.
- The server response reports the checkpoint actually stored and the coverage
  denominator; the cached progress is patched from it (any in-flight read of
  that query is cancelled first, so an older read can't overwrite the patch).
- `coverage_ratio ≥ 0.90` ⇒ listened through (timestamp kept). Before a
  transcript exists raw time is kept and carried into the first revision once.
- **Ordering.** Within one tab batches are sent strictly in order, one at a
  time, and a failed batch is retried before newer ones — so the checkpoint
  converges to the newest. An exact retry of an already-recorded batch
  changes nothing (it cannot roll the checkpoint back). Across tabs/devices
  genuinely different batches are last-writer-wins by arrival — accepted for
  a resume convenience; coverage is a set union and is order-independent.
- `GET /api/listening/progress` returns the stored checkpoint. **Using it to
  resume Listening, and showing Listening on Dashboard/Library/History, is
  Phase 6** — not part of Phase 5.

## 4. Activity pulses (engaged wall-clock time)

Produced **only** by the practice page (`useActivityPulse`), and only from
qualifying learning events:

| Mode | Qualifying event |
|---|---|
| Dictation | keys/edits in the answer field itself, opening the hint panel or changing its level, a submission, sentence playback ticks |
| Shadowing | once a second while a recording is actually running; sentence playback ticks |
| Listening | playback ticks (PLAYING only — never paused/buffering) |

Not events: mounting or re-rendering the page, timers, polling, fetching
saved results, cache refreshes, keys/clicks elsewhere on the page (tabs,
settings, vocabulary, notes). Dashboard, History and every other page mount
no pulse producer at all.

Model (`EngagementClock`, epoch seconds — a different axis from media time):
- the first event after idle credits a 15 s look-back; an idle gap is never
  bridged;
- engagement lasts until 45 s after the last event (the plan's engagement
  window), then nothing more is credited;
- a timer that fires more than 15 s late (sleep / frozen tab) credits only up
  to the last observed event — the gap is not filled in;
- hiding the tab hands over and ends engagement; hidden time with no events
  earns nothing (playback that continues while hidden still counts);
- one clock per page: a mode or round change never credits the same second
  twice. 10 s of playback at 2× is 10 s of activity and 20 s of media.

This is an engagement estimate, not attention. Server bounds for activity
intervals: numbers only, `end > start`, not older than 24 h, at most 10 min
ahead of the server clock, ≤ 900 s each, ≤ 1000 per batch. A client clock
more than 10 minutes fast gets its pulses refused (dropped).
`activity_intervals` stay exact (true-overlap merge) for Phase 6's
cross-session union; no account-wide report is computed in Phase 5.

## 5. Flush coordinator

- A retryable failure (network, 5xx, 408, 429) keeps the batch and resends
  the same id and payload on the next trigger; a 4xx refusal drops it.
- A trigger that arrives while a send is in flight waits for it instead of
  concluding "nothing pending".
- Route changes (`NavigationFlushObserver`: links, Back/Forward), tab hide
  and sign-out flush with `keepalive`; the Dashboard is invalidated only
  after the write succeeded. `keepalive` lets the browser finish sending a
  request after the page is gone — it is **not** a delivery guarantee on tab
  close (the browser may still drop it), and nothing runs client-side after
  the document is destroyed.
- The unsent queue is memory-only and keeps at most 300 s of Listening media
  time: when more accumulates under sustained failure, the oldest batches are
  dropped. This bounds the queue, **not** the loss — during a prolonged
  outage everything beyond the newest 300 s is lost, and a reload or tab close
  loses whatever was still unsent.

## 6. Contracts and permissions

| Function | Kind | anon | authenticated | service_role |
|---|---|---|---|---|
| `fn_sync_study_activity(text,uuid,text,uuid,jsonb,uuid,numeric,text,numeric)` | SECURITY DEFINER, `search_path=public, pg_temp` | ✗ | ✓ | ✗ |
| `fn_flush_study_activity(text,uuid,uuid,text,jsonb,uuid,numeric,text)` | SECURITY DEFINER (035's signature; the app no longer calls it) | ✗ | ✓ | ✗ |
| `fn_get_or_create_study_session(text,uuid)` | SECURITY DEFINER (035, unchanged) | ✗ | ✓ | ✗ |
| `fn_apply_study_flush(uuid,text,uuid,uuid,text,jsonb,uuid,numeric,text,boolean)` | SECURITY DEFINER, internal | ✗ | ✗ | ✗ |

`listening_progress`, `study_sessions`, `activity_flush_log`: SELECT-only,
owner RLS (unchanged). Both routes use the caller's own JWT and make exactly
one RPC.

HTTP: `401` not signed in; `400 invalid_payload` (shape, bounds, > 1000
intervals); `409 study_session_mismatch | transcript_not_found_for_video |
flush_batch_id_reused_with_different_payload | round_mismatch |
late_activity_without_session`; `503 activity_unavailable` (039 missing,
retryable); `500` otherwise (retryable).

## 7. Rollout (in this order)

1. **Preflight** — `supabase/phase5/00_preflight.sql`: `phase4_applied`
   true; `get_session_granted`/`flush_granted` true, `flush_anon` false;
   `phase5_applied` false; note the row counts.
2. **Apply 039** — `supabase db push` (`supabase migration list` should show
   `039` as the only pending migration). Safe with the currently deployed app,
   which calls none of these functions.
3. **Postflight** — `supabase/phase5/01_postflight.sql`: every `ok` true (3
   function rows, 4 permission rows, table-privilege rows) and
   `batch_index_present` true.
4. **Deploy the Phase 5 app.**
5. **Manual checks** (§8), then run `01_postflight.sql` §4 again: rows grow,
   `invalid_ratios` = 0.

The migration must precede the app: the Phase 5 app on a database without
039 gets `503 activity_unavailable` for every sync (batches are retried, up
to the queue bound, until 039 is applied).

## 8. Manual browser / iPhone checks

1. Listening mode, signed in: play ~20 s → "Listened to N% of the script"
   increases (Network: `POST /api/listening/sync` about every 15 s of playback).
2. Pause → a sync is sent. Seek forward 60 s and play 5 s → the percentage
   grows by about 5 s worth, not 65 s.
3. Replay a part you already heard → percentage unchanged; seek back and play
   → `GET /api/listening/progress` shows the lower `lastPositionSec`.
4. Open a lesson in Listening mode and leave without playing → no sync; the
   stored `lastPositionSec` is unchanged.
5. Play, then click to Dashboard → a sync (keepalive) is sent.
6. Offline (DevTools), play 30 s, back online, pause → the buffered sync is
   sent once; the session's observed time is not doubled.
7. Play 10 s, press Restart immediately → the sync for the old round answers
   `attribution: "late"` (or `current` if it arrived first); the new round's
   session is not credited with it.
8. Sign out while playing → sync sent before sign-out; sign in as another
   account → the first account's coverage is not shown or credited.
9. Dictation: type in the answer field → `POST /api/study-session/activity`
   about every 20 s while active. Leave the page idle for 2 minutes → no
   further activity requests after the first minute. Click around the tabs
   without typing → none.
10. Shadowing: record → activity requests while recording, none after.
11. Dashboard / History open for a minute → no activity or sync requests.
12. iPhone Safari: Listening playback, pause/resume, tab switch, lock screen.

## 9. Recovery

| Situation | Action |
|---|---|
| App problem after deploy | Redeploy the previous build. 039 is compatible with it (that build calls none of these functions). Recorded coverage stays. |
| 039 failed to apply | Nothing partial (one transaction). Fix and rerun `db push`. |
| `503 activity_unavailable` in logs | 039 not applied — apply it. Queued batches are resent automatically while the page stays open. |
| `409 late_activity_without_session` | Expected and rare: data observed under a round that was replaced before any of its activity reached the server (at most one flush window). It is dropped by design, not rerouted. |
| Coverage looks wrong for a video | Check `listening_progress` for that revision: `covered_intervals`, `transcript_covered_sec`; coverage only counts the revision's valid sentences. |

## 10. Verification performed (local) and what remains

Real PostgreSQL (disposable 17.9 + Supabase shim; production state first),
`integration/phase5-listening` — **22 tests**:
- Coverage: the denominator excludes gaps and empty sentences; replays add
  observed time but no coverage; the 90 % threshold; pre-transcript time is
  carried forward.
- Activity: the intervals accepted and refused (12 malformed / out-of-range
  cases).
- Isolation and grants under real roles, including that no role can call the
  internal function.
- Attribution:
  - a lost-response retry is a no-op answered from the same session;
  - the same retry after Restart still finds its own session;
  - an unsent old batch after Restart goes to the old round's closed session,
    untouched, and the new round's session is unaffected;
  - late data for a round with no session is refused, and nothing is written;
  - a session expiring between attempts: a retry stays in it, a delayed batch
    is late, fresh activity opens the next session;
  - the same id with a different payload is a conflict, also after Restart;
  - two tabs syncing concurrently: a lock wait was observed, and each batch is
    applied once in one session;
  - round and revision relationship checks;
  - revision A stays A after the script is regenerated;
  - another account reusing a batch id changes nothing of this account's.
- Checkpoint:
  - saved with the flush, moves backward, and coverage never shrinks;
  - a batch without a checkpoint keeps the stored one, and the response
    reports the stored value;
  - an old processed batch retried after a newer save does not roll it back;
  - independent per revision and per account, and readable by its owner only.
- Activity through the entry point: deduplicated by batch id; late data never
  re-dates a session.
- Rollout rehearsal: the preflight runs as written; a real activity pulse is
  refused before 039 and accepted after; no row changes; the postflight is
  all ok.

Unit/DOM (fetch/Supabase mocked, fake timers):
- `listening-tracker` (18)
- `practice-flush-coordinator` (15)
- `listening-sync-route` (19)
- `listening-flush-lifecycle` (11)
- `activity-pulse` (11)

Whole repo, final code:
- `tsc` passes.
- Lint: 0 errors, 3 warnings (existing, on lines this change didn't touch).
- `npm run build` passes and lists the three new routes.
- Jest with the local database: 1396 passed, 113 skipped, 0 failed.
- Jest without it: 1297 passed, 212 skipped.
- The 113 skipped tests are the Supabase-HTTP suites, which were not run.

**Not verified:** real Supabase HTTP (PostgREST error shapes for
`fn_sync_study_activity`), a real YouTube player in a browser/iPhone (§8),
`keepalive` delivery on real navigation/tab close.

**Not in Phase 5 (Phase 6):** resuming Listening at the saved checkpoint;
Dashboard/Library/History reading `listening_progress` and
`activity_intervals` (the Dashboard still reads the legacy
`listening_sessions` table, which nothing has written since before Phase 1);
the account-wide cross-session union of activity time; day-bucketing by the
client timezone (sent and fingerprinted, not stored).
