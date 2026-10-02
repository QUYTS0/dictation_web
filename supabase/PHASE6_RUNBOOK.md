# Phase 6 runbook — Library, Dashboard, History, Listening resume and whole-round reports

**Status:** implemented and verified locally: unit/route/component tests, plus real PostgreSQL on a
disposable local server. **Nothing here has been applied to the Supabase project or deployed.**
Per the user, migrations `001`–`039` are applied and Phase 5's postflight passed. Phase 5
browser/iPhone validation has not been confirmed yet. Migration `040` is new and **not applied
anywhere shared**. The pre-rollout correction pass (local-day streaks, removed videos stay
removed on a mode switch, page-level report-layout tests) edited `040` **in place**. That was
safe only because, per this session's evidence, `040` was never applied anywhere (the user's
last report says it is not applied remotely). If any environment already has the earlier `040`,
don't re-run it there: ship these changes as a new forward migration instead (§9).

Operator SQL lives in `supabase/phase6/`. It sits outside `migrations/`, so `supabase db push`
never runs it.

---

## 1. What ships

| Area | What the user gets | Source of truth |
|---|---|---|
| Library | One card per video, paginated (12 per page, "Load more"), sorted by last activity then video id. Filters: All / In progress / Completed / Not started / Listening. Remove from library. | `fn_video_library`: `user_videos` LEFT JOIN rounds, Listening, sessions |
| Add Video | One URL field, no mode choice. Opens the practice page, which picks the mode. Repeating Add never duplicates the card and never moves `added_at`. | `POST /api/video/resolve` → `fn_library_add_video(explicit)` |
| Continue Learning | Up to 3 videos with real unfinished work: an active round with practice, or Listening in progress (Listening-only included). | `fn_video_library(filter='continue')` |
| Dashboard metrics | Separate tiles: completed videos (+ earlier unverified), in progress, listened through, estimated active practice, sentence accuracy, pronunciation; learning streak on local calendar days. | `fn_dashboard_summary`, `fn_activity_days` |
| History | **One entry per video with learning history** (changed after Phase 6 — migration `042`). Its rounds, the selected round's report and the study sessions are inside the card. The Mistakes view is unchanged. | `fn_history_videos`, `fn_history_video_rounds`, `fn_history_video_sessions` (`042`); `fn_round_report` |
| Round report | Whole-round results. Shown in the practice page (main content) and on `/results/[roundId]`, using the same component and the same query. | `fn_round_report` via `GET /api/session/[id]/report` |
| Listening resume | Listening starts at its own saved checkpoint for the revision on screen. | `listening_progress.last_position_sec` (Phase 5) |
| Last mode | A mode switch is saved and used on the next plain reopen, on any device. It never puts a removed video back in the Library. | `fn_set_video_last_mode`, `fn_video_last_mode` |

Already shipped earlier and reused:
- `fn_restart_round` ("Practice again": abandons the round, force-closes the study session, creates the next round).
- The nullable `session` in the resume response.
- Listening progress and sync.
- The app-wide flush coordinator.

## 2. Entities (kept distinct)

- **Membership** (`user_videos`): the video is in the user's Library. A convenience anchor only.
  Scores, completion and coverage never come from it. `last_mode` is its only field the app reads.
- **Practice round** (`learning_sessions`): pinned to one transcript revision; may span many
  study sessions.
- **Study session** (`study_sessions`): one sitting; may involve several modes; `round_id`
  nullable (Listening-only).
- **Attempt**: one Dictation answer (`attempt_logs`) or one Shadowing take (`shadowing_attempts`).

## 3. Metric definitions

### Dashboard (`fn_dashboard_summary`, account-wide)

| Metric | Formula |
|---|---|
| Completed videos | Distinct videos with a round `status='completed'` **and** `provenance='current'` (verified). |
| Earlier (unverified) | Distinct videos whose only completions are `legacy_unverified`. A video already counted as verified is never counted again (the earlier fix is preserved). |
| In progress | Distinct videos with an **active** round that has ≥1 valid Dictation or Shadowing attempt. May overlap Completed videos when a newer round is active. |
| Listened through | Distinct videos with any `listening_progress.listened_through`. Separate from practice completion. |
| Sentence accuracy | Latest valid Dictation answer per **(round, sentence)** (`created_at`, then `id`), across all rounds. Returned as correct/practiced, never an average of percentages. A latest answer from the unverified legacy history is excluded and counted in `excludedUnverified`. |
| Pronunciation (Azure) | Latest **successful** Azure result per (round, sentence), chronological (never "best"). Accuracy, completeness and pronunciation are word-count weighted; fluency and prosody are duration weighted. Missing scores are excluded, never zero. **No Word Match fallback.** |
| Word Match | Same, from saved Word Match results only. |
| Est. active practice | Length of the **union** of wall-clock activity intervals across **all** of the user's study sessions (overlapping tabs count once). Labeled an estimate, with "since \<first tracked activity\>". No time is invented before tracking existed. |
| Learning streak | Consecutive **local calendar days** with practice in any mode. Full rules below. The practice header (`/api/streak`) and the Dashboard (`/api/dashboard/summary`) call the same loader (`loadActivityStreak`) with the same browser timezone, so they always agree. Separate from a round's "Best run". |

### Learning streak — local days (`fn_activity_days` + `src/lib/utils/streak.ts`)

**Which day a practice counts for:**
1. **Activity batches.** Every qualifying event (answer input, hints, submissions, playing
   playback incl. Listening, recording) becomes engaged wall-clock time, which the coordinator
   seals into a batch. The batch carries the browser's IANA timezone, captured when it was
   sealed. On first receipt the database stores that timezone with the batch, plus every
   **local** date its intervals touch (`activity_flush_log.client_timezone / activity_dates /
   day_basis`).
   - Dates come from **when the activity happened** (the interval timestamps), not from when
     the batch arrived. A delayed batch keeps its own day.
   - PostgreSQL's tz database does the calendar math, so DST and 23/25-hour days are handled.
   - An interval running across local midnight counts on both dates. Idle time is never an
     interval, so it never creates a day.
   - A retry of a sealed batch is a replay: nothing is re-dated. A retry carrying a different
     timezone is a different payload and is refused. A later timezone never changes a stored
     batch.
2. **Dictation answers and Shadowing takes:** the local date in the timezone of the
   nearest-in-time dated batch of **their own study session**.
3. **Historical fallback (documented, labeled):** records without trustworthy local
   attribution keep their **UTC** date:
   - study sessions with no dated batch (all activity recorded before `040`);
   - answers/takes whose study session has no local batch (legacy answers, sessions before
     `040`);
   - batches sent without a valid timezone.

   A past timezone is never guessed, and old days are never re-bucketed. `fn_activity_days`
   returns `utcFallbackDays`. The API returns `streakIncludesUtcFallback` when the current
   streak rests on such a day.

**Timezone input.** Valid = a real IANA name known to the tz database (`fn_valid_time_zone`, and
`Intl` on the server routes): no `UTC+7`-style offsets, abbreviations or `localtime`.
- Missing or invalid on a batch → the batch is **kept** (practice is never discarded), dated in
  UTC and marked `utc_fallback`.
- Over 64 characters → refused, as before (Phase 5).

**Current streak.** "Today" is the viewer's local date in their **current** browser timezone,
sent as `?tz=` by both callers. Missing/invalid `tz` → UTC.
- Counting runs back by calendar date (not 24-hour steps) from today, or from yesterday when
  today has no practice yet.
- The first date without practice ends the streak. Several events on one date are one day.
- **A timezone change** affects only activity recorded afterwards and which date is "today";
  stored days are never re-bucketed.

**What is not practice:** opening the Dashboard, a report, History or the Library, and switching
modes — none of them records activity or a day.

### Library card state (`fn_video_library`)

The card's **round** is the active round if there is one, else the latest round (`started_at`, `id`).

| State | Condition |
|---|---|
| `in_progress` | Active round with valid practice. |
| `completed` | Any completed round (verified or legacy), and not in progress. |
| `listening` | Listening progress on the **current** revision. |
| `listening_prior_revision` | Listening history only under another revision. Never shown as "Not started". |
| `not_started` | None of the above. |

Other card fields:
- `hasCompletedRound` (verified) and `hasLegacyCompletion` are reported independently of `state`. A card can be in progress and "Completed before".
- Card progress is **practice coverage** (`covered/required sentences`, from `fn_round_progress`). Sentence accuracy is a separate line on completed cards, never a progress bar.

### History card (`fn_history_videos`, migration `042` — replaces the session-first list)

| Field | Meaning |
|---|---|
| Which videos | Videos with **actual learning history**: a study session, a recorded answer or take, a completed round (incl. earlier unverified ones) or Listening progress. Not videos that were only added, nor rounds created but never practiced. Library membership doesn't matter: a removed video keeps its card ("Not in your Library"), and reading History never re-adds it. |
| Order and pages | `lastActivityAt desc, videoId asc`, keyset-paged by video on the server. No video repeats or goes missing across pages. `lastActivityAt` = the latest session activity, answer, take, completion or Listening update. |
| Study sessions / rounds | Counts over **all** of the video's sessions and rounds. |
| Default round | The active round, else the latest. Its status and **its own** coverage (unique sentences of that round, never a sum of per-session counts). |
| Est. active (all sessions) | The union of the wall-clock intervals of every session of the video (overlap counted once). An estimate. |
| Listening | Coverage of the **current** revision ("on an earlier script version" otherwise). |
| Expanded | A round selector; the selected round named explicitly; its whole-round report (the shared component, the round's own pinned transcript and metrics); a collapsed "Study sessions" list for that round; a separate collapsed "Listening without a practice round"; and per-round counts of answers/takes that no session owns (labeled, never grouped). All loaded on demand, and none of it writes anything. |

### Study-session row (inside a round; `fn_history_video_sessions`, same fields as 040's `fn_history_sessions`)

| Field | Meaning |
|---|---|
| Dictation / Shadowing sentences | Distinct **eligible** sentences with valid practice attributed to this session. |
| In both / unique | Intersection / union of the two sets above. |
| New to the round | Sentences whose **first** valid practice in the round (either mode) belongs to this session. "First" is decided at read time by (`created_at`, Dictation before Shadowing, `id`). This is timestamp order with a stable tie-breaker, **not** commit order. |
| Est. active | Union of this session's own activity intervals. |
| Session span | `last_activity_at − started_at`. Bookkeeping only, labeled separately. |
| Listened to … of video | `listening_observed_sec`: replay-inclusive **media** seconds (not wall-clock at non-1× speeds). "Newly covered" is what the session added to coverage. |

Practice no session owns is labeled per round in the expanded card, never grouped into invented
sessions:
- answers from before study sessions existed (legacy rounds);
- late answers recorded with no open session.

### Whole-round report (`fn_round_report`)

**Scope:** `user + roundId + the round's pinned transcript`, across **all** study sessions of that
round. Rounds are never combined. Dictation facts use valid practice only, ordered by
(`created_at`, `id`).

| Metric | Definition |
|---|---|
| Sentence accuracy | Correct **latest** Dictation answers ÷ Dictation-practiced sentences (same rule as `fn_round_progress`). |
| First try | The first recorded answer per sentence was correct. Denominator: Dictation-practiced sentences. Hinted first answers are counted separately ("N with a hint"); a missing hint level stays "unknown", never "unassisted". |
| Answers submitted | Stored logical submissions; an idempotent transport retry is one row. |
| Still needs review | The latest answer is incorrect. |
| Corrected after mistakes | The latest answer is correct and an earlier recorded answer was incorrect. |
| Best run in this round | Longest run of consecutive correct answers over the whole round (a wrong answer ends a run). Secondary; labeled "not your daily streak". |
| Mixed rounds | A round completed with Dictation + Shadowing can have fewer Dictation-practiced sentences than required. Dictation figures use the Dictation denominator; coverage shows each mode separately. |
| Shadowing | The round's independent Azure and Word Match summaries (rules as on the Dashboard). |

**Availability.** `historyComplete` = the round is verified (`provenance='current'`) and has no
unverified legacy answers. When it is false:
- first-try results and best run are `null` and shown as "Not enough historical data";
- the earliest record is never presented as a proven first attempt, and no last-sitting count is substituted;
- latest answers are still reported as recorded.

**Root cause fixed.** The completion card mixed scopes. Sentence accuracy and "N attempts" came
from the whole round (seeded by the server), while best streak, "first try" (÷ `segments.length`)
and the mistakes list were page-local React state, so they reset at every visit.

The card is replaced by the report view. The page no longer reads those counters, and the hook no
longer returns them. Every figure now comes from `fn_round_report`.

## 4. Resume, modes and revisions

### Mode precedence

| Priority | Source | Notes |
|---|---|---|
| 1 | Explicit `?mode=` in the URL | A link or navigation that asks for a mode. |
| 2 | The server's `lastMode` | The last **explicit** switch, from `GET /api/session/resume`. Ignored if the user already switched on this page. |
| 3 | Per-video `localStorage` | Applied immediately; replaced by 2 when it arrives. |
| 4 | Dictation | Default. |

Library links carry no `?mode=` (so 2 decides). The exception is a Listening-only card with no
saved mode, which opens with `?mode=listening`.

A mode switch:
- calls `POST /api/videos/[videoId]/mode`;
- creates no round, practice credit or activity pulse;
- **never restores a removed video's Library card.** For a removed video the mode is saved on its
  removal marker (`user_video_removals.last_mode`) and still drives the next reopen
  (`fn_video_last_mode`, read by the resume route);
- always leaves the results / end-of-round view visibly (D17).

### Checkpoints

| Mode | Behavior |
|---|---|
| Listening | Resumes from `listening_progress.last_position_sec` for the revision **on screen** (`useListeningResume`). Applied once per (account, video, revision), with no autoplay. A backward checkpoint is honored. Skipped once the player has played or a newer target is armed. Listening never writes the round's checkpoint and never creates a round. |
| Dictation / Shadowing | Unchanged: round checkpoint (sentence + playhead). Switching from Listening to Dictation/Shadowing creates the round at the selected sentence, so answers are recorded. |
| Completed rounds | Reopen as completed with three choices: "View round results", "Review sentences" (same round, no write) and "Practice again (new round)". Only the last creates a round. |

### Revisions (deliberate choice)

- **The practice page shows one transcript for all modes:** the round's pinned revision if there is a round, else the current one. It never re-pins a round.
- **Listening accrues to the revision on screen.** The Library reports Listening against the **current** revision (plan rule). If a round is pinned to an older revision, the card shows "Previously listened (script updated)" (`listening_prior_revision`, `historyOnOtherRevision`), never "Not started".
- **One revision's timestamp is never applied to another.**

## 5. Cache and navigation

| Event | Invalidates / patches (all user-scoped) |
|---|---|
| Recorded Dictation answer | Dashboard, Library, History, this round's report, Mistakes / error patterns. |
| Shadowing save / completion | Dashboard, Library, History, this round's report. |
| Saved Azure or Word Match result | Dashboard, Library, History, this round's report. |
| Checkpoint save | Dashboard, Library, History. |
| Restart | The above, plus old and new round reports. |
| Listening sync | Patches `listening-progress`. Library when coverage or the checkpoint changed; Dashboard when listened-through flips. |
| Navigation / visibility / sign-out flush | Dashboard, Library and History, **after** the write succeeds — including a send already in flight (coordinator unchanged otherwise). |
| Add Video / remove / mode switch | Library (+ Dashboard). |

Keys:

| Key | Contents |
|---|---|
| `["video-library", userId, "list", filter]` | Library pages |
| `["video-library", userId, "continue"]` | Continue Learning |
| `["round-report", userId, roundId]` | Report for an explicit round, independent of the practice page's current round |
| `["history-sessions", userId, "videos"]` | History cards (video-first) |
| `["history-sessions", userId, "rounds", videoId]` | A History card's rounds (on expand) |
| `["history-sessions", userId, "sessions", videoId, roundId \| "none"]` | One round's sittings, or the round-less ones (on opening the section) |
| `["dashboard-summary", userId]` | Dashboard |
| `["listening-progress", userId, videoId, transcriptId]` | Listening progress for one revision |

Behavior:
- Content stays visible during a background refetch.
- Filters persist in `sessionStorage` per user (`video-library-viewstate:{userId}`, `history-sessions-viewstate:{userId}`), and scroll is restored.
- Sign-out clears the query cache (unchanged).

## 6. Security and permissions (migration `040`)

**App-callable functions:**
- `fn_library_add_video(text, boolean)`, `fn_library_remove_video(text)`, `fn_set_video_last_mode(text, text)`, `fn_video_last_mode(text)`
- `fn_video_library(integer, integer, text)`, `fn_dashboard_summary()`, `fn_activity_days()`
- `fn_history_sessions(integer, timestamptz, uuid, text)`, `fn_round_report(uuid)`, `fn_my_round_progress(uuid)`

These are `SECURITY DEFINER`, `search_path=public, pg_temp`, every row scoped to `auth.uid()`, and EXECUTE for `authenticated` only (anon, service_role and PUBLIC revoked).

**Ownership:**
- Another user's round → `round_not_found` (404).
- Removal and mode writes touch only the caller's rows.

**Internal, callable by no application role:**
- `fn_dictation_accuracy_summary`, `fn_shadowing_summary`, `fn_activity_union` (they take a user id);
- `fn_word_count`, `fn_valid_video_id`, `fn_lock_library_entry`, `fn_valid_time_zone`, `fn_local_activity_dates`;
- `fn_apply_study_flush` (Phase 5's internal flush body; `040` replaces it with the same signature
  and behavior plus the day attribution — replay-first dedup, late attribution and Listening
  checkpoints are unchanged);
- the operator functions `fn_phase6_reconcile_membership()` and `fn_phase6_membership_gap()`.

**New table `user_video_removals`** (removal markers, incl. `last_mode`): owner-SELECT RLS; app
writes only through the functions.

**Additive columns** on `activity_flush_log` (nullable; old rows stay NULL = recorded before local
dating): `client_timezone`, `activity_dates date[]`, `day_basis` (`local` | `utc_fallback`).

**Unchanged:**
- `learning_sessions` and `attempt_logs` keep the Phase 3 write model. No direct app writes were restored.
- Restart still uses `fn_restart_round`.
- No historical row is rewritten.

### Membership writes

For a video the user **deliberately removed** (a `user_video_removals` marker exists):

| Action | Membership | Notes |
|---|---|---|
| Add Video (`POST /api/video/resolve` → `fn_library_add_video(explicit=true)`) | **Restored** | The only writer that clears the marker. One card, with all of its rounds, reports and Listening history (none was ever deleted) and the mode saved while removed. `added_at` = the re-add time (a new membership). |
| Repeated Add | unchanged | Idempotent: no duplicate, `added_at` unchanged. |
| Mode switch (`fn_set_video_last_mode`) | stays removed | Mode saved on the marker. |
| Opening History, a report, the practice page | stays removed | Reads never write. |
| Dictation answer / Shadowing take / Listening sync | stays removed | Learning data is saved. The automatic first-use add (`explicit=false`) answers `suppressedByRemoval`. |
| Reconciliation (`02_reconcile_membership.sql`) | stays removed | Removed pairs are skipped and reported as `skippedRemoved`. |

For a video **never removed**, membership is still created automatically on genuine first use (a
video's first round, a fresh Listening sync). A mode switch on a video opened by link that was
never added also creates it, as before.

**Concurrency.** Every membership writer (add, remove, mode switch, automatic add) takes the same
per-(user, video) transaction lock (`fn_lock_library_entry`), so a removal and a racing write
serialize. A delayed mode switch, flush or background add that commits after a removal sees the
marker and respects it. The reconciliation holds a SHARE ROW EXCLUSIVE lock on `user_videos` and
`user_video_removals` while it runs, so app writes wait for it rather than race it.

"Remove from library" deletes only the caller's `user_videos` row (its `last_mode` moves to the
marker). Rounds, answers, recordings, reports, Listening progress, study sessions, transcripts and
other users' data are kept.

## 7. Rollout (in this order)

1. **Preflight:** run `supabase/phase6/00_preflight.sql` (read-only). Expect:
   - `phase3_stage='activated'`;
   - `phase4_applied`, `phase5_applied` and `phase5_batch_index` all true;
   - `phase6_applied=false`;
   - a `membership_gap` count — informational; **any value is valid, including 0**.
2. **Apply `040`:** `supabase migration list` should show `001`–`039` applied and `040` pending, then run `supabase db push`.
   - What `040` changes: adds functions, one table, four indexes and three nullable columns on
     `activity_flush_log`, and replaces the internal `fn_apply_study_flush` (same signature).
   - The Phase 5 app keeps working: it calls none of the new functions, and its activity flushes
     are dated locally from this point on.
3. **Postflight:** run `supabase/phase6/01_postflight.sql`. Expect:
   - 21 function rows and 19 permission rows, all `ok`;
   - exactly one `user_video_removals` grant (authenticated / SELECT), and RLS enabled;
   - 4 new-column rows;
   - `membership_gap` = the number of eligible missing memberships (removed videos excluded). It
     may be 0 or more before step 5.
   - The last section (day attribution) lists activity batches by `day_basis`: `NULL` (before
     `040`), and `local` / `utc_fallback` once new activity arrives.
4. **Deploy the Phase 6 app.** Migration first: the Phase 6 app on a database without `040` answers 503 `learning_data_unavailable` on the Dashboard, Library, History and report. Practice still works: the resume `progress` is null, and the membership writes fail quietly (logged, never blocking a save). No wrong numbers, but those pages don't work.
5. **Reconcile membership:** as `postgres`, run `supabase/phase6/02_reconcile_membership.sql` once, after the deploy, so no gap can reopen behind it.
   - `gap_before` may be 0 (nothing to do).
   - Expect `gap_after = 0`: no **eligible** missing membership remains. Videos the user removed
     are excluded and reported as `skippedRemoved`; they are never re-added.
   - It is idempotent, and it briefly blocks concurrent app membership writes while it runs.
6. **Postflight again**, then the §8 checklist.

No environment variable changes. `PRACTICE_WRITE_PATH` must be unset or `authoritative` for the
Phase 6 build. Since Phase 8 the app ignores this variable entirely (`PHASE8_RUNBOOK.md`).

### 7b. History grouped by video (migration `042`, after Phase 6 shipped)

`042` adds three read functions and changes nothing else: no table, row or existing function or
grant. `040`'s `fn_history_sessions` stays for already-open old tabs.

1. **Order:** `001`–`040` are applied. `041` (Script Versions, `PHASE9_RUNBOOK.md`) is in the repo
   and also pending. Migrations apply in number order, so `supabase db push` applies `041` and then
   `042`. Don't skip `041`: a lower number created after a higher one is applied would need
   `--include-all`.
2. **Postflight (read-only):** every `ok` must be true.
   ```sql
   with expected(sig) as (values
     ('public.fn_history_videos(integer,timestamptz,text)'),
     ('public.fn_history_video_rounds(text,integer)'),
     ('public.fn_history_video_sessions(text,uuid,boolean,integer,timestamptz,uuid)'))
   select sig, (not has_function_privilege('anon', sig, 'EXECUTE')
                and has_function_privilege('authenticated', sig, 'EXECUTE')
                and not has_function_privilege('service_role', sig, 'EXECUTE')) as ok
   from expected;
   ```
3. **Deploy the app** after the migration. An app deployed without `042` shows "Failed to load your
   history" (HTTP 503 `learning_data_unavailable`) on History only; everything else works.
4. Run the §8 History checks.

## 8. Manual desktop / iPhone checklist

1. **Dashboard, Library, Continue Learning**
   - [ ] Add a new video URL → the practice page opens (no mode choice); back on the Dashboard the card shows "Not started".
   - [ ] Add the same URL again → still one card, same "Added" date.
   - [ ] Listen to a video without practicing → the card shows "Listened N%" and appears in Continue Learning; no round is created (its History entry says "No practice round").
   - [ ] Finish a round, press "Practice again", answer one sentence → the card shows "In progress" and "Completed before"; the Dashboard counts it in both Completed and In progress.
   - [ ] Remove a video → the dialog says what is kept; the card disappears and stays gone after a reload; the round report link still opens from History; Add restores it with its history.
   - [ ] Remove a video, open it from History, switch modes and answer a sentence → back on the Dashboard the card is **still gone**. Add it again → one card, in the mode you switched to.
2. **Resume, modes and revisions**
   - [ ] Switch to Shadowing, then open the video on another device/browser with a plain link → it opens in Shadowing.
   - [ ] Listening: play to about 1:30, go to the Dashboard, come back → first Play starts at about 1:30. Seek back to 0:10, play a bit, reload → starts at about 0:10. Open and leave without playing → the checkpoint is unchanged.
   - [ ] Dictation/Shadowing still resume at their own sentence. Play/Space starts at the target; Replay starts at the sentence; Pause → Play continues; nothing autoplays while restoring.
3. **Round results**
   - [ ] Finish a round over two days (two sittings) → the results show the whole round (e.g. 110/110, all answers), a first-try count, a "Best run in this round" (not the daily streak), and "Still needs review" / "Corrected" lists; reload → identical numbers.
   - [ ] The video area and side panel are hidden; "Open script" shows the panel; "Back to practice" restores your previous panel layout; one scroll area (no nested scrolling around the lists); all actions are reachable on iPhone.
   - [ ] Start the video playing (YouTube's own button), then "View round results" → the audio stops (nothing plays while the player is hidden).
   - [ ] iPhone (Safari, portrait): the report is the only content under the header, with no horizontal scroll; "Back to practice", "Open script", "Continue in …", "Practice again" and every "Review sentence N" can be reached and tapped; "Open script" shows the panel below the report and the page still scrolls as one area.
   - [ ] "Review sentence N" selects that sentence (no autoplay, no new round); "Continue in Listening/Shadowing" switches visibly; "Practice again (new round)" asks first.
   - [ ] Open a completed round from the Library → "View round results", "Review sentences" or "Practice again" — nothing restarts on its own.
4. **History** (video-first, `042`)
   - [ ] A video practiced over several days and rounds is **one** card: last practiced, "N study sessions · M rounds", the current round's coverage, "View report" and "Continue".
   - [ ] "Rounds and sessions" → the selected round is named; choosing an older round shows **its** report (its own sentences and numbers); practicing from the card still continues the current round.
   - [ ] "Study sessions in round N" opens collapsed rows (modes, "Est. active" vs "span", sentences with "in both" and "new to the round", Listening as video time) — no repeated thumbnails or report links.
   - [ ] A Listening-only video shows "Listening only — no practice round", its round-less sittings in their own section, and no report link; opening it creates no round.
   - [ ] A video removed from the Library is still in History ("Not in your Library"), and stays out of the Library after viewing History.
   - [ ] Practice a sentence on an older video, come back → that video is now first, with the new counts.
   - [ ] "Load more" never repeats a video.
   - [ ] Mistakes still filter and load more.
5. **Accounts**
   - [ ] Sign out and in as another account → no previous Library, filters or reports appear.
6. **Learning streak (local days)**
   - [ ] With the device in Asia/Ho_Chi_Minh, practice shortly after local midnight → the header and the Dashboard show the same streak, and it includes today (not yesterday).
   - [ ] Practice before midnight and again after it → the streak grows by one day; the header and the Dashboard agree.
   - [ ] Leave a page open (idle) across midnight without practicing → no new day appears.

## 9. Recovery

| Situation | Action |
|---|---|
| App deployed before `040` | Apply `040` (§7 step 2). Nothing is written in the meantime; pages recover on refresh. |
| Roll back the app to Phase 5 | Safe with `040` applied: the Phase 5 app calls none of the new functions, and the resume and dashboard routes revert to their Phase 5 queries. Memberships and last modes written meanwhile stay (harmless). |
| Remove `040` | Not needed for an app rollback. If ever required, drop the new functions, `user_video_removals` and the three nullable `activity_flush_log` columns by hand, and restore 039's `fn_apply_study_flush` from `039_phase5_listening_activity.sql`. No historical row was changed. **Don't** delete `user_videos` rows (they include real memberships added by Phase 6). |
| An earlier `040` was already applied somewhere | Don't re-run the edited file there. Ship the correction as a new forward migration: the `ALTER`s, the replaced functions and the grants from this `040` are all `if not exists` / `create or replace`. |
| Reconciliation added an unwanted card | The user removes it (marker kept — re-running reconciliation will not bring it back). |

Limitations (by design, not bugs):
- Streak days recorded before `040`, and batches sent without a valid timezone, keep their UTC date
  (flagged `utcFallbackDays` / `streakIncludesUtcFallback`). A session that was open while `040`
  was applied contributes its later batches locally; its earlier activity counts only through its
  answers/takes.
- A video opened by direct link and only listened to is added to the Library by its first fresh
  Listening sync. A video the user removed comes back only by Add Video.
- The Library computes each user's cards live (fine at this app's scale, one query per page; no per-card requests).

## 10. Verification performed (local) and what remains

Numbers after the pre-rollout correction pass:

| Environment | Status |
|---|---|
| Type-check (`tsc`) | Pass. |
| Lint | 0 errors; the same 3 pre-existing warnings. |
| Production build | Pass. |
| Real PostgreSQL 17.9 (disposable, local) | **30 passed**: `phase6-library` 18 + `phase6-corrections` 12. Each suite starts from the production state and upgrades to 040: 001–038 with legacy history seeded **before** the real Phase 3 cutover, activated, then 039 — the corrections suite also records activity under 039 first. The operator scripts run as written: preflight → 040 → postflight (21 / 19 / 4 rows) → reconcile, then an idempotent re-run. All 12 correction tests fail against the pre-correction `040`. |
| Integrated practice page in report view (jsdom) | **7 passed** (`practice-report-layout.test.tsx`). The real `DictationPage`, `YouTubePlayer`, hooks, report and panels; only the YouTube IFrame API, auth, the network and unrelated chrome are faked. Caught one production defect: opening the report from "View round results" did not pause a playing video. Fixed. |
| Other component / route / hook tests | Phase 6 routes 12, Dashboard/Library 7, round report + layout hook 9, History 3, practice-page hooks 8, player resume 25, resume route 7, dashboard + streak routes 8, streak rules 13, coordinator 18 (incl. "a sealed batch keeps its timezone"), Listening route 20. |
| Full Jest with the local DB, `--runInBand` | **131 suites passed, 4 skipped; 1491 passed, 113 skipped, 0 failed.** The 113 skipped are the Supabase-HTTP suites (`PHASE1_IT_*` / `TRANSCRIPT_IT_*`), not run. |
| Full Jest with the local DB, parallel workers (default) | Same totals, except `transcriptPdf.test.ts` › "paginates a long transcript" **failed with the 5 s default timeout in 3 of 4 parallel runs**. That file is unchanged since its own commit, CPU-bound (PDF + fonts), passes alone and in-band, and its timeout was not raised. (The one parallel run made while `fn_valid_time_zone` was still slow also timed out four `phase6-corrections` tests — the cause, fixed below — and one `vocabulary-page.test.tsx` case, an unchanged file.) The parallel runs also print Jest's "a worker process has failed to exit gracefully" warning. It is intermittent, absent in-band, not reproducible from any Phase 6 suite (bisected), and `--detectOpenHandles` reports nothing. Likely source (unconfirmed): the uncleared `Promise.race` timers in the unchanged AI routes (`explain-all/route.ts:553`, `ai/explain/route.ts:130`). Not masked, not fixed here (out of scope). |
| Full Jest without a DB | 118 suites passed, 17 skipped; 1362 passed, 242 skipped (one earlier parallel run had the same `transcriptPdf` timeout). |
| Supabase HTTP (PostgREST/GoTrue) | **Not verified.** |
| Real browser / iPhone | **Not verified.** jsdom cannot establish CSS layout, breakpoints, scrolling or iPhone rendering. Run §8, especially items 3 and 6. |
| Applied to the user's project | **No.** |
| Deployed | **No.** |

Performance note: the first version of `fn_valid_time_zone` looked names up in
`pg_timezone_names` (~370 ms per call — it reads every tz file), which every activity flush would
have paid. It now checks the IANA name shape and does a cached `AT TIME ZONE` lookup (~0.3 ms).

Real-Postgres scenarios:
- **Library:** an added, unstarted video appears once; a repeated Add preserves `added_at` and progress; a Listening-only video has no round; a completed round and a newer active round coexist; legacy completion is separate (and not double-counted after a verified completion); coverage is never replaced by accuracy; overlapping activity in two sessions counts once; Revision A Listening is not attached to Revision B, and the round keeps its pin.
- **Removal:** removal preserves history and is not undone by a read, by reconciliation or by implicit writes; cross-user report access and removal are rejected; reads create no rounds; Restart preserves the old round's report.
- **Report:** a round over two sittings, with a transport retry, gives identical results on every read; a mixed-mode round uses the Dictation denominator; Azure never falls back to Word Match (missing is null); a legacy round reports first-try and best run as unavailable.
- **Dashboard and History:** Dashboard accuracy is latest-per-(round, sentence), not an average of percentages; last mode writes no round, session or activity; History is keyset-paginated, attributes first coverage once, and labels unattributed practice; permissions.
- **Local-day streaks (`phase6-corrections`):**
  - Vietnam 00:30 belongs to its local date; activity just before, just after and across local midnight; an interval ending exactly at midnight.
  - New York DST (25- and 23-hour days).
  - IANA validation.
  - A flush dated in its captured zone, not UTC; several events on one date = one day; answers/takes dated in their session's zone.
  - A delayed batch dated by when it happened; a retry after midnight is a no-op that keeps its dates; a changed zone on a retry is refused.
  - Idle time across midnight adds no day.
  - A missing or invalid zone keeps the batch (`utc_fallback`); over-long is refused.
  - Pre-040 activity keeps its UTC day (labeled) and is not re-bucketed.
  - Dashboard/report/History/Library reads and mode switches create no activity.
- **Membership after removal (`phase6-corrections`):**
  - Remove → History/report/practice reads → mode switch: the card stays removed and the mode persists on the marker.
  - Dictation, Shadowing and Listening after removal don't restore it; neither does reconciliation (the gap excludes it).
  - Explicit Add restores one card with its history and saved mode; repeated Add is idempotent.
  - A never-removed video joins on first use.
  - Removal racing a delayed mode switch, automatic add or reconciliation always wins, in both lock orders.
  - Markers and memberships are per account.
