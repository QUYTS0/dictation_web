# Learning Reports P4 runbook — Saved explanations

**Status:** implemented and verified locally (route and component tests with mocked Supabase and
Gemini, plus real PostgreSQL 17 on a disposable local server). **Nothing here is applied to the
Supabase project, deployed, or committed. No Gemini call was made.**

- Migration: `supabase/migrations/043_saved_explanations.sql` (next free number after `042`).
- Operator scripts: `supabase/explanations_p4/00_preflight.sql`, `01_postflight.sql` (read-only).
- Design: `.claude/learning-reports-review-plan.md` §6 and §12.5.

P5 (assessment generations, new quota, recovery endpoint, Explain-more UI) is **not** part of
this release.

## 1. What ships

| Area | Behaviour | Source |
|---|---|---|
| Storage | New explanations go to `attempt_explanations`, which no pre-P4 code references. `ai_feedback` becomes legacy input only. | 043 |
| Legacy capture | Every `ai_feedback` row is copied on insert (trigger) and once at migration time (backfill). Copies keep the original `created_at` and survive deletion of the source row; there is no FK from the copy to `ai_feedback`. | 043 |
| Operations | `explanation_operations`: one row per provider operation. `seq` is allocated at **begin** under the per-round lock; the token hash is kept for the operation's life. | 043 |
| Writers | `explain-all` and `/api/ai/explain`: begin → quota → provider (outside any transaction) → finish, or abandon. Neither deletes nor inserts `ai_feedback` any more. | routes |
| Reuse | A mistake with a saved note (its own, or the same mistake in another sentence of the same round under the same matching rule) is never paid for again. The database re-checks this under the lock at begin. | 043, `explanationIdentity.ts` |
| Report | Reads `attempt_explanations` (owner RLS). Labels: "Same mistake as sentence N", "Explanation of an earlier answer to this sentence", "Earlier mistake (now corrected or answered again)", "· earlier explanation" for legacy copies. If the notes can't be loaded, the rest of the report still shows. | report route, `AIFeedbackCard` |
| Unsaved output | Shown with "Not saved — this explanation will disappear when you reload." Never presented as saved. | results page |
| Overview | Unchanged until P5 (still `learning_sessions.ai_assessment` via `fn_persist_session_assessment`). When no explanation is needed, the overview runs as one assessment-only request. | explain-all |

### 1.1 Reuse identity (`p1`)

`sha256("p1|<mode>|<byte length of normalized reference>|<normalized reference>|<normalized answer>")`,
normalized with the attempt's own `match_mode` (`fn_normalize_dictation_text` / `normalizeText`,
which are parity-tested):
- `exact` keeps case and punctuation, so a case-only and a punctuation-only mistake never share a note;
- `relaxed` and `learning` are kept apart even though they normalize alike today;
- unknown (legacy `null`) mode → **no key**: that attempt shows only its own note (or, labelled, an
  earlier answer's note to the same sentence);
- scope: the same round (therefore the same user and pinned script). Never across rounds, users,
  videos, or sentence indexes.

The legacy relaxed grouping is still used for the overview prompt's pattern list only.

### 1.2 Writer RPC results

| RPC | Results |
|---|---|
| `fn_explanations_begin(user, round, targets[], kind, intent, prompt_version, model)` | `started{operationId, token, seq, targets, covered}` · `reuse{covered}` (nothing left to explain; nothing created) · `in_progress{operationId}` (same live request) · `busy` (another live operation in the round) · `invalid_targets` · `invalid_request` · `not_found` |
| `fn_explanations_finish(user, round, operation, token, items)` | `saved{count, seq}` · `already_saved` (same token and canonical payload) · `conflict` (same token, different payload; stored rows unchanged) · `invalid_token` (always checked first, even after acceptance or lease expiry) · `invalid_state` (abandoned) · `invalid_payload{reason}` (`not_an_array`, `empty`, `too_large`, `malformed_item`, `duplicate_attempt`, `not_a_target`) · `not_found` |
| `fn_explanations_abandon(user, round, operation, token, reason)` | `abandoned` · `already_saved` · `invalid_token` · `not_found`. Never deletes a note. |

`intent`: `missing` (default) removes covered targets under the lock; `reexplain` is the explicit
replacement request (validated by both routes; no UI uses it yet). A response with no usable note is
**abandoned** (`no_usable_notes`) and reported as `none_usable`, never as saved.

## 2. Known limits (stated, not hidden)

- **Not exactly-once.** A lease lasts 120 s. A worker slower than that can overlap a later operation
  for the same targets; both may be paid, and the higher `seq` wins on display. A provider timeout
  is ambiguous: the provider may still have charged.
- **No recovery in P4.** Provider success followed by a failed finish loses that output (shown as
  not saved). The finish RPC is already token-checked and idempotent for P5's recovery endpoint.
- **Model-marked "duplicate"/"minor" items** are not stored (as before), so a later request may ask
  for them again.
- **Old-app display.** During a mixed deployment or after an app rollback, the old app reads only
  `ai_feedback`; it can't show notes created by the P4 app (they are kept and reappear on
  roll-forward).
- **Catch-up after capture removal.** `fn_copy_legacy_ai_feedback()` can copy only rows that still
  exist. A row inserted *and deleted* while the trigger was disabled is gone for good.
- **Legacy rows that can't be copied** (no attempt, blank explanation, round without an owner) are
  kept in `ai_feedback` and listed by the postflight. They are never given an invented owner.

## 3. Rollout (prepared, not performed)

Migration first, app second. Each step must pass before the next.

1. **Preflight** (read-only, SQL editor as the project owner): run
   `supabase/explanations_p4/00_preflight.sql`. Every `ok` must be true (043 absent, prerequisites
   present). Keep the inventory (copyable / not copyable by reason, duplicates) with the rollout record.
2. **Apply** `043_saved_explanations.sql`. It runs in one transaction and takes
   `SHARE ROW EXCLUSIVE` on `ai_feedback` while installing capture and backfill: concurrent legacy
   INSERTs wait a moment and are then captured. The old app keeps working unchanged.
3. **Postflight** (read-only): run `01_postflight.sql`. Every `ok` must be true:
   RLS and policy; table grants (no app-role writes); function matrix (writers service-role only,
   helpers and catch-up not callable by any app role, definer and pinned `search_path`); capture
   trigger enabled; **every currently existing copyable legacy row has exactly one copy**; copies
   match their source (content, original timestamp, attempt → round → owner); every note belongs to
   its attempt's round and owner; no duplicate legacy ids.
   - **Do not compare total row counts.** Copies outlive deleted legacy rows, so the new table can
     legitimately hold more (`preserved_after_legacy_delete` is information, not a failure).
   - Review the "cannot be copied" list.
4. **Deploy the P4 app.** Then run the postflight again.
5. **Browser checks without paid calls** (§4).
6. **P5 starts only after** P4 is deployed and verified.

## 4. Manual checks (no Gemini calls)

Use a round that already has saved explanations (legacy rows were copied by step 2):
1. Open `/results/<roundId>` — saved notes show under their sentences; nothing is requested (no
   `explain-all` / `ai/explain` request in the network panel, only the report GET).
2. A repeated mistake in another sentence shows "Same mistake as sentence N" and jumps to it.
3. A corrected sentence shows its note labelled as an earlier mistake; legacy notes show
   "· earlier explanation".
4. Reload: the same notes, same labels.
5. Sign out and in as another account on the same URL: none of the first account's notes appear.
6. Desktop and iPhone widths: the labels wrap without horizontal scroll.

Do **not** press "Get AI assessment" / "Re-run assessment" for these checks: it still generates the
overview (a paid request) even when every explanation is already saved.

## 5. Rollback

- **App only:** redeploy the previous app. Data is safe:
  - the old app reads and writes `ai_feedback` as before; its writes are still captured;
  - notes created by the P4 app stay in `attempt_explanations` (not shown by the old app; shown
    again after roll-forward);
  - an old DELETE → failed INSERT can remove `ai_feedback` rows but never a stored copy.
- **Do not drop** `attempt_explanations`, `explanation_operations` or the trigger as part of a
  rollback. Removing the trigger would be a forward migration and an explicit operator choice;
  afterwards run `select fn_copy_legacy_ai_feedback();` as the owner (it copies only rows that
  still exist, §2).
- Migration 043 has no down-migration.

## 6. Verification performed (local)

See `.claude/learning-reports-review-plan.md` §12.5 for the exact commands and results.
