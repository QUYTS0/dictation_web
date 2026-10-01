# Phase 9 runbook — Script Versions

**Status:** implemented and verified locally (route/component tests, the real practice page, and
real PostgreSQL on a disposable local server). **Nothing here is applied to the Supabase project or
deployed.** Per the user, `001`–`040` are applied and Phases 3–6 (and the Phase 8 retirement
release) are in place. Migration `041` is new.

## 1. What ships

| Area | What the user gets | Source |
|---|---|---|
| Script versions dialog | Settings → **Script** → "Script versions" (signed-in only). Every version of the video's script, newest first. | `ScriptVersionsDialog` |
| Per version | Version number and date; source (YouTube captions / generated from audio / pasted or uploaded); status; sentence count. | `fn_transcript_versions` |
| Badges | **Current**, **Showing now** (the version on screen), **Used by your round N** (only the viewer's own rounds). | `fn_transcript_versions` |
| Estimated storage | Script text, sentences, translations, word highlights, files (always 0), and the total — labeled as an estimate of stored rows, not disk usage, and not what removing it would free. | `fn_refresh_transcript_size_estimate` |
| Why it's kept | A plain-language reason: current; being generated; a practice round uses it; saved answers or recordings use it; earlier (unverified) history; Listening progress uses it; saved words or bookmarks exist for the video. Otherwise "Kept until \<date\> (recently replaced)", or "Eligible for cleanup since \<date\> — cleanup is not enabled". | `fn_transcript_retention` |
| Preview | A read-only list of that version's sentences. It never changes the current version or any round. | `GET …/versions/[transcriptId]/preview` |
| Delete | **None, for anyone, including admins.** Deletion is disabled for every video at the database (§3). | — |

Already shipped earlier and reused:
- **Duplicate prevention (Phase 0):** regenerating identical content reuses the matching version
  instead of adding one.
- **Current version (Phase 0):** "current" is a flag, not "the highest number".
- **Publication order (Phase 0):** lock → verify → retire → promote.

## 2. Retention rules (plan §6.9)

**Protected** — never a cleanup candidate — while any of these hold:
- it is the current version, or is still being generated;
- any practice round pins it, whatever the round's status;
- any Dictation answer or Shadowing take references it, or a round pinned to it has earlier
  (unverified) history;
- Listening progress references it, including the pre-Phase-5 `listening_sessions` table;
- **indirect:** any saved word or bookmark exists for the video. Those rows carry no version id,
  so the protection covers the whole video.

Otherwise a 30-day grace period runs from when the version stopped being current (or from its
creation, if it never was). After that it is a **cleanup candidate** — a classification only.

## 3. Deletion: specified, unreachable in v1

`fn_delete_transcript_revision(uuid)` exists and is fully specified:
- the actor is `auth.uid()` and must be `is_admin`;
- the target row is locked `FOR UPDATE`, and every protection is re-checked under that lock;
- if anything protects the version, it refuses and changes nothing;
- otherwise the version is deleted, and its sentences, translations and highlights cascade.

**No role can execute it:** not `anon`, not `authenticated` (an admin's own client included), not
`service_role`.
- No route calls it, and no button exists.
- Why: saved-word and bookmark inserts take no lock shared with deletion (plan §6.9). Enabling
  deletion is a later, separate migration that adds the grant, the `DELETE` route and the button
  together, once the plan's future-enablement criteria are met.

## 4. Rollout

1. **Preflight (read-only):**
   ```sql
   select to_regprocedure('public.fn_video_library(integer,integer,text)') is not null as phase6_applied,   -- true
          to_regprocedure('public.fn_transcript_versions(text,text)') is not null as phase9_applied;         -- false
   ```
   `supabase migration list` should show `001`–`040` applied and `041` pending.
2. **Apply `041`:** `supabase db push`.
   - It adds 4 functions and 5 indexes and changes nothing existing. The index builds on
     `attempt_logs`, `shadowing_attempts`, `listening_progress`, `vocabulary_items` and `bookmarks`
     are ordinary (brief write locks on those tables).
   - The current app keeps working, since it calls none of the new functions.
3. **Postflight (read-only); every `ok` must be true:**
   ```sql
   with expected(sig, anon, authed, service) as (values
     ('public.fn_transcript_versions(text,text)', false, true, false),
     ('public.fn_transcript_retention(uuid)', false, false, false),
     ('public.fn_refresh_transcript_size_estimate(uuid)', false, false, false),
     ('public.fn_delete_transcript_revision(uuid)', false, false, false))   -- the v1 gate
   select sig,
          (has_function_privilege('anon', sig, 'EXECUTE') = anon
           and has_function_privilege('authenticated', sig, 'EXECUTE') = authed
           and has_function_privilege('service_role', sig, 'EXECUTE') = service) as ok
   from expected;
   select count(*) = 5 as ok from pg_indexes where schemaname = 'public' and indexname in
     ('attempt_logs_transcript_idx', 'shadowing_attempts_transcript_idx', 'listening_progress_transcript_idx',
      'vocabulary_items_video_idx', 'bookmarks_video_idx');
   ```
4. **Deploy the app.** Order: migration first. An app deployed without `041` shows "Couldn't load
   script versions" (HTTP 503 `script_versions_unavailable`). Practice is unaffected.
5. Run the §5 checks.

No environment-variable changes.

## 5. Manual desktop / iPhone checks

- [ ] Settings → Script → "Script versions" opens the dialog; on iPhone it's a bottom sheet that
  scrolls, and closes with ✕ (Escape on desktop).
- [ ] A video regenerated with different content shows two versions: the newest is **Current**,
  the older says "Kept — a practice round uses it" while your round uses it, and your round's row
  says "Used by your round N".
- [ ] Regenerating identical content does not add a version.
- [ ] "Preview version N" shows that version's sentences. Practice continues on the same version
  afterwards: no reload into another version, and no new round.
- [ ] No delete or clean-up button anywhere, also when signed in as an admin.
- [ ] Removing the video from your Library leaves its script versions intact (the dialog still
  lists them after adding it back).

## 6. Recovery and rollback

| Situation | Action |
|---|---|
| App deployed before `041` | Apply `041`; the dialog recovers on reopen. |
| Roll back the app | Safe: the previous app calls none of the new functions. |
| Remove `041` | Not needed for an app rollback. If ever required, drop the four functions and five indexes by hand. No data was changed apart from the size-estimate columns (`029`), which the previous app ignores. |

Known limitations (by design):
- Size estimates are refreshed when the dialog is opened (at most hourly per version), not at
  publication. A version being republished at that moment keeps its previous estimate until the
  next open.
- The saved-word/bookmark protection is per video, not per version (no version id on those rows).

## 7. Verification performed (local)

| Environment | Status |
|---|---|
| Real PostgreSQL 17.9 (disposable) | `phase9-script-versions.integration.test.ts`: **11 passed**. Covers listing order, badges and sizes; the grace period and cleanup-candidate classification; rounds of every status protecting their version (#56); every reference reason; per-viewer `yourRound`; lazy size refresh; no role can execute deletion, including an admin's own client (#74); refusals changing nothing (#46/#59); a successful privileged deletion cascading; a reference created after the read, and one racing the deletion (#47); publication vs. deletion in both orders (#58); Library removal leaving transcripts intact. |
| Route / component / page tests | Routes 7, dialog 6, real practice page opening the dialog 1. |
| Full suite, type-check, lint, build | See the final report for this pass. |
| Supabase HTTP, browser, iPhone | **Not verified.** |
| Applied / deployed | **No.** |
