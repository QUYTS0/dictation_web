# Dashboard Redesign (DictaLearn Studio reference) — Implementation Plan

Plan only. No application code, migrations or dependencies were changed to produce it.

Reference source: `C:\Users\Tri.Nguyen\source\repos\dictalearn---gamified-english-listening-&-shadowing-studio` (Vite + React mock, all data from `src/data/mockData.ts`). Every reference section was read in full and compared against the current Dashboard (`src/app/dashboard/**`, `src/lib/dashboard/**`, `src/app/api/dashboard/**`) and the schema (`supabase/migrations/001`–`045`).

## 0. Confirmed decisions (2026-11-25)

| # | Topic | Decision |
|---|---|---|
| D1 | XP and levels | **Build**, as per-user XP **calculated from records already stored** (§3.3). The claim-bonus button and Weekly Quests are still left out. *(Revised: originally "leave out".)* |
| D2 | Leaderboard + badges | **Build both for real.** |
| D3 | Daily target and per-day minutes | **Build.** New per-day activity function, plus a goal **saved to the account**. |
| D4 | Restyle reach | **Full app-wide:** color tokens, AppHeader, **fonts** (Plus Jakarta Sans + JetBrains Mono). New card styles are used on the Dashboard; other pages keep their card styles for now (see Phase 8). |
| D5 | Leaderboard metric | **Weekly XP.** *(Revised: originally active minutes.)* |
| D6 | Leaderboard structure | **Tiered leagues with weekly promotion/demotion.** |
| D7 | Leaderboard identity | **Everyone included by default** under an auto-generated nickname, with an opt-out and an optional public name. |
| D8 | Vocabulary card | **Inline flashcard with real grading** through the existing review API (Again/Hard/Good/Easy). |
| D9 | Streak | **A day with only vocabulary review counts toward the streak.** Today it doesn't: `POST /api/vocabulary/review` only updates `vocabulary_items` in place, with no activity record and no review history. |
| D10 | Hero button | **"Start today's practice" starts a new video**: it opens a link box inside the hero (the same form as the header's New Video dialog). Resuming belongs to the Continue card, so the two buttons never do the same thing. |
| D11 | UI additions | Streak status line, first-run dashboard, fill-in-the-blank cards + keyboard shortcuts, weekly-track day details, resume point on the Continue card, celebrations. Details in §4.5. |

Defaults chosen in this plan (not asked; change them before implementation if you disagree):

- Daily goal defaults to **15 min** when unset; choices 10 / 15 / 20 / 30 / 45 / 60. The goal stays in **minutes**, as in the reference, and earns no XP (see §3.3, principle 2).
- XP rules v1 and the level curve as in §3.3. Levels are shown as "Level N" with no titles.
- League tiers: **Bronze → Silver → Gold → Platinum → Diamond → Master**. Groups of ≤ 30. **Top 3 promote, bottom 3 demote** (no demotion in groups under 10 members; no promotion from Master; no demotion from Bronze).
- League week = **Monday 00:00 UTC** (one global boundary). For a UTC+7 viewer that is Monday 07:00 local; the UI shows the local reset time.
- "All time" tab = **global** top 5 by total XP + your rank, from a snapshot refreshed at most hourly.
- Kudos: **built.** One per giver→receiver per week, same group only.
- Existing `users.display_name` is **not** reused as a public name (it was set before anything was public). Users opt in to a public name explicitly.
- Badges award **no XP** (keeps the two systems independent).
- The streak status line switches to its urgent wording from **18:00 local time**.
- The deck opens in **Fill the gap** mode by default; the learner's choice is remembered per browser.
- No sound effects (the reference's Web Audio synth and mute toggle are dropped).

## 1. Section-by-section mapping

Legend: ✅ data exists today · 🔨 built by this plan · ❌ dropped

| Reference section | Current equivalent | Data | Plan |
|---|---|---|---|
| **Navbar**: brand "Dicta**Learn** Studio" | `AppHeader` brand | ✅ | Restyle (solid white/blur, brand mark, "Studio" sub-label). |
| Navbar links (Dashboard, My Learning, Vocabulary Deck, Leaderboard, Weekly Quests) | Dashboard, My Learning, Vocabulary, Bookmarks, History | ✅/🔨 | Keep the current 5 routes, **add Leaderboard** (`/leaderboard`, new). Quests ❌. Text-only soft-indigo active pill. |
| Navbar "New Video" button + `AddVideoModal` | Inline "Add a video" disclosure, `dashboard/page.tsx:218-279` | ✅ | Move the add flow into a shared `AddVideoForm`, used by an `AddVideoDialog` opened from the header on **every** page and by the hero link box (D10). Same `/api/video/resolve` logic. Curated-talks list ❌ (no catalog). |
| Navbar streak pill + popover | Streak chip in welcome row | ✅ | Header pill on every page (lightweight `/api/streak`). Popover: today's goal status + next streak milestone (from achievements, Phase 6). **Streak shield ❌** (no streak freeze exists). |
| Navbar XP · Lvl pill | — | 🔨 (D1) | Real: "4,850 XP · Lvl 14" (hidden below `lg`, as in the reference). |
| Navbar sound toggle | — | ❌ | Dropped. |
| Avatar dropdown | `UserButton` | ✅ | Add **"Profile & preferences"** (public name, leaderboard visibility, daily goal). |
| **Hero** (navy): "Welcome back, {name}" | Welcome row, `page.tsx:189-201` | ✅ | Name = public name ?? email prefix (today: email prefix, `page.tsx:162`). Under it, the **streak status line** (§4.5.2). |
| Hero: Weekly Consistency Track Mon–Sun, ✓ per day, ember on today, **+XP** per day | — | 🔨 | ✓ = active that local day (same day set as the streak, which now includes vocabulary review, D9). Under each day: **XP earned that day**, as in the reference. Ember marker on today. "· N/7 active". Each day opens a **details popover** (§4.5.5). |
| Hero: Today's Daily Target 24/30 min + bar | — | 🔨 | Today's active minutes / goal (D3). Teal bar and a "Goal met today ✓" label when met. |
| Hero: Level N progress bar | — | 🔨 (D1) | Real: "Level 14 · 4,850 / 5,000 XP". |
| Hero: amber "Claim Daily Streak (+25 XP)" | — | 🔨 (D10) | Same amber button, labelled **"Start today's practice"**. It opens a link box inside the hero (§4.5.1). There is no claim action: XP is calculated, and the active-day bonus (+10 XP, §3.3) is automatic. |
| **Continue card** ("Pick up where you left off") | `ContinueLearningCard.tsx` | ✅ | Larger 5/12 thumbnail with play overlay, clickable title, CTA. Meta line = mode · Round N · last practiced (speaker/source/category ❌, not stored). Thumbnail badges: Round N + mode (duration ❌: `videos.duration_sec` exists but nothing writes it; CEFR ❌). Adds the **resume point** "Resume at sentence 13 of 58" (§4.5.6). |
| Continue: Round N progress, 3 bars | Single coverage bar | ✅ | **All three are real:** Dictation `round.progress.coveredSentences.dictation / requiredSentenceCount`, Shadowing `…shadowing / requiredSentenceCount`, Listening `listening.coverageRatio` / "Listened through". Rows hide when their data is null. |
| **Weekly Quests** (4 col) | `FocusCard` ("Next up") | ✅ | Next up takes this slot. Restyle only; `selectFocus` logic untouched. Not shown on the first-run dashboard (§4.5.3), which covers its "Add a video" case. |
| **Spaced Repetition Deck** (8 col) | `VocabularyCard.tsx` (count + chips) | ✅ | Inline flip card (D8) with two modes, **Fill the gap** and **Meaning** (§4.5.4). Meaning front = `canonical_form ?? term`, `phonetic`, pronounce button. Back (navy) = word, `part_of_speech`, `definition ?? translation`, example = `sentence_context` (the real sentence from the video), pronounce button. Grades Again/Hard/Good/Easy with the interval preview from `computeNextReview` (e.g. "Good · 3d"), plus **keyboard shortcuts**. Due-word chips select a card. "Start full review" → `/vocabulary/review`. **Mastery % ❌** (removed by the earlier vocabulary-stats plan); the existing New/Learning/Due status badge replaces it. |
| **Diamond League** (4 col) | — | 🔨 (D2, D5–D7) | `LeagueCard`: tier header, "Resets Mon 07:00", This week / All time tabs, top rows + your row with **weekly XP**, streak sub-line, kudos heart, promotion-zone footer. |
| **Learning Performance** (3 cards) | `ProgressSummary.tsx` | ✅ | Same three canonical numbers, each its own card. Active practice + video-count line (the reference copied this line from the current app) + **7-day minute bars** 🔨. Accuracy `correct/practiced` + bar. Pronunciation `/100` + scored sentences + bar. Tags "Top 15% consistency", "Flawless streak", "Native cadence" ❌ (no basis; the current "descriptive only" rule stands). XP never appears in this section. |
| **Needs Attention · Error Diagnostics** (8 col) | `NeedsAttentionCard.tsx` (bars only) | ✅ | Selectable frequency bars (existing data). Diagnostic panel: per-type description (new static copy), the **latest real mistake** of that type ("Your answer" vs "Correct"), and its **saved** AI explanation if one exists (`attempt_explanations.attempt_id → attempt_logs`, `043_saved_explanations.sql:83`; read-only, never calls Gemini). CTA "Practice weak points" → **"Review {type} mistakes"** → `/history?errorType={type}` (works today: `usePersistedViewState` reads URL params, `src/hooks/usePersistedViewState.ts:63`). |
| **Badge Trophy Case** (4 col) + `BadgeDetailModal` | — | 🔨 (D2) | `AchievementsCase`: 6 tracks in a 3×2 grid, each showing its highest unlocked tier, progress to the next tier, and a stored unlock date. The reference's per-badge XP value ❌. |
| Toast | — | 🔨 | Small toast provider for level-ups, achievement unlocks, league outcome at week start, and daily goal met, plus the **celebrations** in §4.5.7. |
| Footer | — | ✅ | `AppFooter`: "DictaLearn · English listening, dictation & shadowing studio" · Streak · League (#rank). |
| `PracticeModal`, `WordReviewModal` | `/dictation/[videoId]`, `/vocabulary/review` | ✅ | Not ported; the real pages already do this. (Per-action "+15 XP" toasts on the practice pages are a possible follow-up, not in this plan.) |
| Theme: 7 palettes + `ThemeContext` | Tailwind `@theme` primary scale | ✅ | Adopt **only** the "Approved DictaLearn (Calm Indigo)" palette as static tokens. No runtime theme switcher (the reference has no UI for one). |

## 2. Target layout

Returning learner:

```
AppHeader (sticky, every page)
[DictaLearn Studio]  Dashboard · My Learning · Vocabulary · Bookmarks · History · Leaderboard   [+ New video] [🔥 12 days] [⚡ 4,850 XP · Lvl 14] [avatar ▾]

(Mondays only) Last week: 1,240 XP · 96 min · 41 words reviewed · finished #2 → promoted to Gold   [×]

Hero — navy gradient, full width
┌ Welcome back, Tri ─────────────────────────────┬ TODAY'S TARGET        11 / 15 min ┐
│ Your 12-day streak ends at midnight. One       │ ███████████░░░░                   │
│ sentence or one word review keeps it going.    │ ● Level 14     4,850 / 5,000 XP   │
│ WEEKLY CONSISTENCY TRACK · 5/7 active          │ ▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔    │
│ Mon  Tue  Wed  Thu  Fri  Sat  Sun              │ [ Start today's practice ]        │
│  ✓────✓────✓────·────✓────✓────◉              │   ↓ (opens in place)              │
│ +85  +90  +110  —   +95  +140 +40              │ [ Paste a YouTube link…] [Start →]│
└────────────────────────────────────────────────┴───────────────────────────────────┘
Row 8/4:  Continue learning (thumbnail + 3 bars + "Resume at sentence 13 of 58")  |  Next up
Row 8/4:  Spaced repetition deck (Fill the gap / Meaning, grades, chips)          |  League card (weekly XP)
Full:     Learning performance — Active practice | Sentence accuracy | Pronunciation
Row 8/4:  Needs attention · error diagnostics                                     |  Achievements
AppFooter
```

First-run learner (§4.5.3):

```
┌ Welcome to DictaLearn ───────────────────────────────────────┐
│ [ Paste a YouTube link …                   ] [Start →]       │
│  ① Listen   →   ② Type what you hear   →   ③ Repeat aloud    │
└──────────────────────────────────────────────────────────────┘
(no other cards until the learner has data)
```

The existing rule stays: if Continue or Next up is absent, the other takes the row alone (`page.tsx:204-216`).

## 3. Backend

All new reads follow the existing convention: `SECURITY DEFINER`, rows scoped to `auth.uid()`, pinned `search_path`. Internal helpers that take a user id are callable by no application role (see the `040` header).

### 3.1 Migration 046 — vocabulary review log + streak (Phase 3)

Started early on purpose: XP and the streak can only use review history from the moment this log exists.

- `vocabulary_reviews(id uuid pk, user_id, item_id → vocabulary_items on delete set null, grade text check (grade in ('again','hard','good','easy')), reviewed_at timestamptz default now(), client_timezone text null, backfilled boolean not null default false)`. RLS: select own; no direct insert.
- `fn_record_vocabulary_review(p_item_id, p_grade, p_interval_days, p_ease_factor, p_repetitions, p_next_review_at, p_time_zone)`: updates the item's SRS fields **and** inserts the log row in one transaction. SRS values are still computed by `computeNextReview` in the route. The timezone is validated with `fn_valid_time_zone`; invalid → stored null (UTC fallback).
- `POST /api/vocabulary/review` switches to this RPC and accepts `timeZone` (`viewerTimeZone()`), sent by both `/vocabulary/review` and the dashboard deck.
- **Backfill:** one row per item with `last_reviewed_at is not null` (`backfilled = true`, timezone null). Only the latest review per item is known, so older reviews stay invisible.
- **Streak (D9):** `create or replace fn_activity_days` with `vocabulary_reviews` added as a fourth source. Local date from `client_timezone`; null → UTC date, also reported in `utcFallbackDays`. The return shape is unchanged, so `/api/streak`, the dashboard summary and the practice header pick it up with no code change and keep agreeing.

### 3.2 Migration 047 — profile and daily activity (Phase 4)

- `users` columns:
  - `daily_goal_minutes smallint null check (daily_goal_minutes in (10,15,20,30,45,60))`
  - `public_name text null check (char_length(btrim(public_name)) between 2 and 24)`
  - `leaderboard_hidden boolean not null default false`
- `fn_public_nickname(p_user_id uuid) returns text`: deterministic `'Learner ' || upper(substr(md5(p_user_id::text || ':league'), 1, 5))`. No column; stable and not derivable from the email. Internal only.
- `fn_update_my_profile(p_public_name text, p_daily_goal smallint, p_leaderboard_hidden boolean)`: validates and trims, then updates the caller's row. A direct update would also pass RLS (`users_self_update`, `001:153`), so the CHECK constraints are the backstop. *(As built: `fn_update_my_profile(p_patch jsonb)` plus `fn_my_profile()`; see Phase 4 in §5.)*
- `fn_daily_activity(p_time_zone text, p_from date, p_to date) returns jsonb`: `[{date, activeSec}]` per **local** day. Intervals from `study_sessions.activity_intervals` are merged (`fn_merge_intervals`), then clipped at each local midnight computed by the tz database (DST-safe; validated with `fn_valid_time_zone`). This is the same union rule as `fn_activity_union` (`040:347`), so **the sum of all days equals `activeTime.activeSec`** over the same span. The range is capped at 31 days.

### 3.3 Migration 048 — XP and levels (Phase 5)

Principles:

1. **XP is calculated from timestamped records that already exist** (plus `vocabulary_reviews`). Nothing awards XP inside the recording functions (`fn_record_dictation_attempt`, `fn_record_shadowing_attempt`, the Listening sync), so those heavily tested write paths stay untouched. Existing users get XP for past practice automatically, and the totals can't drift from the underlying records.
2. **XP never depends on a user setting.** That's why there is no "daily goal met" bonus: changing the goal would rewrite past XP. The active-day bonus replaces it.
3. **Every rule only pays the first occurrence**, so retries and "Again" loops earn nothing extra.
4. **Rules are versioned** (`XP_RULES_VERSION = 1`, in a comment and in the API response). Changing a rule changes historical totals, so changes should be announced.
5. **XP stays separate from the learning metrics.** Accuracy, pronunciation and active time remain their own numbers (§6.8). XP is the game layer only.

XP rules v1:

| Record (source) | XP | Dated at |
|---|---|---|
| First practice-valid Dictation answer to a sentence in a round (`attempt_logs`, `is_practice_valid`) | +10 | that attempt |
| First **correct** practice-valid answer to that sentence in that round | +5 | that attempt |
| First practice-valid Shadowing take of a sentence in a round (`shadowing_attempts`) | +10 | that take |
| First take of that sentence in that round with Azure pronunciation ≥ 80 | +5 | that take |
| Listening: newly covered time per study session (`study_sessions.listening_newly_covered_sec`), whole minutes | +1 / min | the session's start (the counter has no per-update timestamp, `039:302`) |
| First review of a vocabulary item per local day (`vocabulary_reviews`) | +3, **max 60 XP per day** | that review |
| Verified round completion (`provenance = 'current'`) | +50 | `completed_at` |
| Active day: any activity incl. vocabulary review (same day set as the streak) | +10 | first recorded event of that local day |

The 60 XP/day vocabulary cap matters because users can create vocabulary items themselves; without it, review XP could be inflated without limit.

Functions:

- `fn_xp_events(p_user_id uuid, p_time_zone text, p_from timestamptz, p_to timestamptz)`: internal; returns `(occurred_at, source, amount)` for the rules above.
- `fn_my_xp(p_time_zone text) returns jsonb`: `{ rulesVersion, totalXp, level, levelStartXp, nextLevelXp, todayXp, leagueWeekXp, days: [{date, xp, activity: {dictationSentences, shadowingTakes, wordsReviewed, listeningMin}}] (rolling 14 local days) }`. The `activity` counts are the number of XP events per source that day; they feed the day details popover (§4.5.5).
- **Level curve:** reaching level *L* needs `50·L·(L−1)` total XP (level 2 = 100, level 5 = 1,000, level 10 = 4,500, level 20 = 19,000). A 20-sentence Dictation session earns ≈ 300 XP, so level 10 takes about two to three weeks of daily practice.
- **Indexes:** check during implementation that `attempt_logs(session_id, segment_index, created_at)` and `shadowing_attempts(round_id, segment_index, created_at)` are covered; add them if not.

### 3.4 Migration 049 — achievements (Phase 6)

- `achievement_tiers(track text, tier smallint, threshold numeric, primary key(track, tier))`, seeded by the migration. This is the **single source** of thresholds. TypeScript holds only presentation (name, icon, copy).
- `user_achievements(user_id, track, tier, unlocked_at timestamptz default now(), primary key(user_id, track, tier))`. RLS: select own; **no** insert/update policy.
- `fn_sync_achievements(p_time_zone text) returns jsonb`: recomputes each metric **server-side**, inserts newly met tiers (`on conflict do nothing`), and returns `{tracks:[…], newlyUnlocked:[…]}`. It takes no client-supplied ids or values.
- `fn_longest_streak(days date[])` and `fn_streak_from_days(days date[], today date)`: SQL ports of `computeStreakFromDays` (`src/lib/utils/streak.ts`), with a parity test against the TypeScript version.

| Track (icon) | Metric (existing source) | Bronze / Silver / Gold / Diamond |
|---|---|---|
| Flame Keeper (flame) | longest streak ever (`fn_activity_days`, incl. vocabulary days) | 3 / 7 / 14 / 30 days |
| Precision Typist (target) | correct latest Dictation answers (`sentenceAccuracy.correct`) | 25 / 100 / 250 / 500 |
| Shadow Master (mic) | Azure-scored shadowing sentences (`shadowing.azure.evaluatedSentences`) | 10 / 50 / 150 / 400 |
| Lexicon (book) | saved vocabulary items | 25 / 100 / 250 / 500 |
| Immersion (headphones) | total active hours (`activeTime.activeSec`) | 1 / 5 / 20 / 50 h |
| League (trophy) | highest league tier reached (Phase 7 adds this row set) | Silver / Gold / Platinum / Diamond |

A tier stays unlocked once earned, even if the underlying count later drops (e.g. vocabulary deleted).

### 3.5 Migration 050 — leagues (Phase 7)

Tables:

- `user_league_state(user_id pk, tier smallint not null default 1 check (tier between 1 and 6), updated_at)`
- `league_weeks(week_start date pk, finalized_at timestamptz null)`
- `league_groups(id uuid pk, week_start date, tier smallint, created_at)`
- `league_members(id uuid pk, week_start date, group_id uuid, user_id uuid, joined_at, final_rank smallint null, final_xp integer null, outcome text null check (outcome in ('promoted','stayed','demoted')), unique(week_start, user_id))`
- `league_kudos(week_start, giver_id, receiver_id, created_at, primary key(week_start, giver_id, receiver_id), check (giver_id <> receiver_id))`
- `leaderboard_alltime(user_id pk, total_xp integer, refreshed_at)` (snapshot)

Rules:

1. **Week**: `[Monday 00:00 UTC, next Monday)`. Weekly XP = sum of `fn_xp_events` dated inside that window. Each member's events use their most recent recorded `activity_flush_log.client_timezone` (UTC fallback) for the rules that need a local day.
2. **Joining**: on a board read, a caller who is not hidden, has > 0 XP this week and is not yet a member joins the first group in their tier with < 30 members, or a new group. Before that, the card shows "Practice to join this week's {tier} league".
3. **Rollover (lazy, idempotent)**: every board read first finalizes any unfinalized past week under `pg_advisory_xact_lock`. For each group: rank by weekly XP desc, then `joined_at` asc; top 3 promote, bottom 3 demote (if group ≥ 10), others stay. Writes `final_rank`, `final_xp`, `outcome`, `user_league_state.tier`, then `finalized_at`. No cron is needed. Upgrade path: a `pg_cron` job calling the same function, if read-time cost grows.
4. **Rows returned** (`fn_league_board(p_scope text, p_time_zone text)`): rank, `member_key` (= `league_members.id`, opaque), display name (`public_name ?? nickname`), initials, weekly XP, streak, kudos received this week, "you gave kudos", and `isYou`. **Never** returns email, auth user id, or avatar URL. Other members' streaks use the same day rule in their most recent recorded timezone; the caller's own row shows the viewer-local streak from the summary.
5. **All time**: global top 5 by total XP + caller's rank from `leaderboard_alltime`. It is refreshed inside the read when older than 1 hour (advisory lock; one recompute at a time). Labelled "Updated hourly". Hidden users are excluded.
6. **Kudos** (`fn_league_give_kudos(p_member_key uuid)`): receiver must be in the caller's current group, not self, once per pair per week.
7. **Hidden users** are excluded from groups and boards. If a user hides mid-week, their membership row stays for rollover integrity but is filtered from every board.

### 3.6 API routes

| Route | Phase | Returns |
|---|---|---|
| `GET /api/dashboard/summary`, `GET /api/streak` (changed) | 2 | Add `streakActiveToday: boolean` to `ActivityStreak` (`days.has(today)` in `loadActivityStreak`, `src/lib/supabase/activityStreak.ts:33`; no SQL change). Feeds the streak status line. |
| `GET /api/dashboard/mistake-example?errorType=` | 3 | Latest incorrect `attempt_logs` row of that type: `{ expectedText, userText, videoTitle, createdAt, explanation \| null }`. Saved explanation only. |
| `POST /api/vocabulary/review` (changed) | 3 | Same response; accepts `timeZone`, writes through `fn_record_vocabulary_review`. |
| `GET /api/dashboard/week?tz=` | 4 | `{ today, weekStart, days: [{date, practiced, activeSec}] (rolling 14 days), goalMinutes, goalIsDefault }`. `practiced` comes from the same day set as the streak (extend `loadActivityStreak` to also return the recent day keys). |
| `GET/PATCH /api/profile` | 4 | `{ publicName, nickname, leaderboardHidden, dailyGoalMinutes }` |
| `GET /api/xp?tz=` | 5 | Output of `fn_my_xp` (header pill, hero level bar, per-day XP and day details, celebrations, Monday recap). |
| `GET /api/achievements?tz=` | 6 | Output of `fn_sync_achievements` |
| `GET /api/leaderboard?scope=week\|all&tz=` | 7 | `{ status: 'member'\|'not_joined'\|'hidden', tier, weekEndsAt, rows, you: {rank, weekXp, gapToPromotionXp, zone}, lastWeek: {outcome, finalRank, tier, xp} \| null }` |
| `POST /api/leaderboard/kudos` | 7 | `{ ok }` |

Query hooks go in `src/lib/queries/{dashboard,profile,xp,achievements,leaderboard}.ts`. Week, XP, leaderboard and achievements keys are added to `invalidateLearningViews` (`src/lib/queries/learningInvalidation.ts`), so practice refreshes them. Grading in the deck invalidates vocabulary stats, the review queue, streak, week and XP.

## 4. Frontend

### 4.1 Tokens and fonts (app-wide, Phase 1)

- `src/app/globals.css` `@theme`: remap the primary scale to the reference brand (`primary-50 #EEF0FF`, `primary-600 #5B5CE2`, `primary-700 #494BC4`, interpolated 100/500), and add `page #F6F7FB`, `surface #F1F3FA`, `line #DDE3EF`, `ink #172033`, `muted #6F7891`, `hero #151B35`, `hero-2 #25285C`, `success #2FAE9B`, `reward #EFB044`, `danger #DC6B70`. Body background → `page`.
- Fonts via `next/font/google` in `src/app/layout.tsx` (self-hosted at build), replacing the Inter `@import`: Plus Jakarta Sans (`--font-sans`) and JetBrains Mono (`--font-mono`). **Include the `vietnamese` subset.** Translations and learner text render Vietnamese. Confirm both families offer that subset when wiring; if one doesn't, use Noto Sans for translation text (already in `public/fonts`).
- Ember and flame keyframes ported from the reference `index.css`, wrapped in `@media (prefers-reduced-motion: no-preference)`.
- `themeColor` in `layout.tsx` → `#5B5CE2`.

### 4.2 Shared shell (Phase 1)

- `src/components/AppHeader.tsx`: restyle; add Leaderboard link (Phase 7 enables it), New Video button, streak pill and popover, XP pill slot (Phase 5 fills it). Move `useStreak` from `src/app/dictation/[videoId]/useStreak.ts` to `src/lib/queries/streak.ts` so the header and practice page share it.
- `src/components/AddVideoForm.tsx`: the logic from `page.tsx:81-125` (validation, `/api/video/resolve`, `invalidateLearningViews`, `router.push`), with a `variant` for light (dialog) and dark (hero) surfaces. Used by:
  - `src/components/AddVideoDialog.tsx`: the header's New Video button. Accessible dialog (focus trap, Esc, return focus).
  - the hero link box (§4.5.1) and the first-run hero (§4.5.3).
- `src/components/ProfileDialog.tsx` (Phase 4) from `UserButton`; `src/components/AppFooter.tsx`; `src/components/ToastProvider.tsx` mounted in `Providers.tsx`.
- Move `ConfettiBurst` from `src/app/dictation/[videoId]/components/ConfettiBurst.tsx` to `src/components/ConfettiBurst.tsx` and make it render nothing under `prefers-reduced-motion: reduce` (it doesn't check today). Used by the practice page and celebrations (§4.5.7).

### 4.3 Dashboard components (`src/app/dashboard/components/`)

| New / changed | Replaces | Notes |
|---|---|---|
| `DashboardHero.tsx`, `StreakStatusLine.tsx`, `WeeklyTrack.tsx`, `DayDetailsPopover.tsx`, `ActiveEmber.tsx` | welcome row | Mon–Sun of the viewer's local week; future days are empty dots. Per-day value = XP (Phase 5); minutes are shown until then. Hosts the hero link box. |
| `FirstRunHero.tsx` | — | §4.5.3. |
| `ContinueLearningCard.tsx` | same | 3 bars + resume point; keep test ids `continue-learning`, `continue-card-*`, `continue-coverage`, `continue-listening`. |
| `FocusCard.tsx` | same | Restyle only. Its "Add a video" CTA opens the **hero link box** (scrolls it into view and focuses the field), so the page has one form. *(Implemented in Phase 2; originally planned as opening `AddVideoDialog`.)* |
| `VocabularyDeck.tsx` | `VocabularyCard.tsx` | Queue from `GET /api/vocabulary/review` (20-item batch). The flip is a real `<button>`, and the back side is announced (`aria-live`). Grades advance optimistically and roll back with a toast on error. Empty state: saved count + recent chips + "View vocabulary". Keeps the dedup rule (`page.tsx:136`) for the header "Start full review" button. Modes and shortcuts in §4.5.4. |
| `LeagueCard.tsx` | — | States: member / not joined / hidden / loading / error. One-time notice (localStorage) for D7: "You appear as Learner 4F2A2. Change your name or hide yourself in Preferences." |
| `LearningPerformance.tsx` | `ProgressSummary.tsx` | Keep test ids `your-progress`, `progress-active`, `progress-accuracy`, `progress-pronunciation`, `progress-videos`. |
| `NeedsAttentionCard.tsx` | same | Selection state + example panel; keep `mostCommonMistakeLine`. Add `description` per type to `ERROR_TYPE_OPTIONS` (`src/lib/constants/errorTypes.ts`). Consider reusing `ComparedSentenceText` for the diff. |
| `AchievementsCase.tsx`, `AchievementDetailDialog.tsx` | — | |
| `CelebrationLayer.tsx`, `WeeklyRecapBanner.tsx` | — | §4.5.7. |

### 4.4 `/leaderboard` page (Phase 7)

Full group list (≤ 30) with weekly XP, tier ladder, promotion/demotion zones, last week's result, a privacy explanation and a link to Preferences.

### 4.5 Dashboard UI additions (D10, D11)

#### 4.5.1 Hero button: start a new video (D10) — Phase 2

- "Start today's practice" (amber, under the level bar) expands an inline link box **inside the hero panel**: `AddVideoForm` in its dark variant, autofocused. The button becomes the form's toggle (`aria-expanded`, `aria-controls`); Esc or a close button collapses it and returns focus to the button. Typed text survives collapsing, as the current disclosure does.
- Submitting resolves the video and opens it, exactly like the header dialog. Errors show inline under the field.
- The button is always available, also after the goal is met. "Goal met today ✓" is a label next to the target, not a button state.
- Division of work: hero button = **start something new**, Continue card = **resume**, Next up = **review**.

#### 4.5.2 Streak status line — Phase 2

One line under "Welcome back", chosen from the summary's `streakDays` and `streakActiveToday` and the viewer's local clock. Wording is honest about the rule: any activity keeps the streak, including one word review (D9).

| State | Line |
|---|---|
| Streak 0 | "Ready for today's practice?" |
| Active today | "12-day streak · today is done ✓" |
| Not active today, before 18:00 | "Keep your 12-day streak going today." |
| Not active today, from 18:00 | Phase 2: "Your 12-day streak ends at midnight. Any practice today keeps it going." Phase 3 (once word reviews count, D9): "… One sentence or one word review keeps it going." |
| Summary is from an earlier local day (page left open past midnight) | "Ready for today's practice?" (no claim until it refetches) |

It updates when the summary refetches (after practice or review); no timer is needed beyond re-evaluating the clock on window focus.

#### 4.5.3 First-run dashboard — Phase 2

- Shown when the learner has **nothing yet**: `libraryVideos === 0 && activeTime.sessionCount === 0 && vocabularyCount === 0`. A learner who removed all their videos but has history still gets the normal dashboard.
- `FirstRunHero`: heading, `AddVideoForm` (dark variant), and three steps: ① Listen → ② Type what you hear → ③ Repeat aloud. The field is **not** autofocused: on page load that would skip the heading for screen-reader users and pop the keyboard on phones.
- While the summary loads, the hero is a placeholder, so a brand-new learner never sees a premature "Welcome back".
- All other cards (Continue, Next up, deck, league, performance, diagnostics, achievements) are hidden until there's data. The header stays the same.
- This also satisfies the `.github/instructions/frontend-ui.instructions.md` rule about a prominent link input, at the moment it matters most.

#### 4.5.4 Fill the gap mode and keyboard shortcuts — Phase 3

- **Fill the gap** (default): the front shows the learner's own sentence (`sentence_context`) with the saved word blanked out. Match `term` case-insensitively on word boundaries; blank the **first** match. If `term` isn't found (e.g. an edited term), that card shows **Meaning** mode instead. There is no pronounce button on the front, since it would give the answer away; the back has one.
- **Meaning**: as in the reference (word + phonetic on the front).
- A small Fill the gap / Meaning toggle in the deck header, remembered per browser (localStorage).
- Back side (both modes): word, part of speech, definition (or translation), the full sentence with the word highlighted, and pronounce.
- **Shortcuts**: Space or Enter flips, 1–4 grade (Again/Hard/Good/Easy). On the dashboard they work only while focus is inside the deck, so they never hijack the page. On `/vocabulary/review` (which has none today) they work page-wide. Both ignore keys typed into inputs. Grade buttons show their number.
- `/vocabulary/review` gets the same two modes and shortcuts, sharing the card component.

#### 4.5.5 Weekly track day details — Phase 4 (minutes), Phase 5 (full)

- Each day marker is a button that opens a popover (hover on desktop, tap on touch, keyboard-reachable): "Tue 18 Nov · 22 min · 18 Dictation sentences · 6 Shadowing takes · 12 words reviewed · +140 XP".
- Phase 4 shows date + minutes + "Active". Phase 5 adds the per-source counts and XP from `fn_my_xp.days[].activity`.
- Zero values are left out; future days and inactive days have no popover.

#### 4.5.6 Resume point on the Continue card — Phase 2

- "Resume at sentence {round.currentSegmentIndex + 1}". Segment indexes are 0-based and shown +1, as Bookmarks does (`src/app/bookmarks/page.tsx:232`).
- **No total.** Checked in Phase 2: `required_sentence_count` counts only eligible sentences (`text_normalized <> ''`, `037:40`), while `currentSegmentIndex` indexes every segment, so "13 of 58" could be wrong.
- Hidden for Listening-only items (no round) and for an untouched round (index 0, nothing practiced).

#### 4.5.7 Celebrations — Phase 5 (Monday recap gains the league result in Phase 7)

- **Goal met / level up:** on the first dashboard visit after the goal is reached or a level is gained, play `ConfettiBurst` once and show a toast ("Daily goal met!" / "Level 15 reached"). Tracked per user in localStorage (last celebrated goal date, last celebrated level), so it fires once per browser. Nothing animates under reduced motion; the toast still appears.
- **Monday recap banner** (`WeeklyRecapBanner`): shown on the first visit of a new league week, above the hero, dismissible, once per week. Phase 5: "Last week: 1,240 XP · 96 min · 41 words reviewed". Phase 7 adds "· finished #2 → promoted to Gold" from `leaderboard.lastWeek`. Hidden if last week had no activity.

## 5. Phases

Each phase ends with `npm run lint`, `npm run build`, `npm test` green, and is shippable on its own.

| Phase | Scope | Backend | Size |
|---|---|---|---|
| **1. Visual foundation** ✅ *done 2026-11-25* | Tokens, fonts, AppHeader restyle, `AddVideoForm` + `AddVideoDialog`, streak pill, AppFooter (Dashboard, My Learning, History, Bookmarks, Results; not the fixed-viewport Vocabulary page), ToastProvider, `ConfettiBurst` move + reduced motion | none | M |
| **2. Dashboard re-layout (existing data)** ✅ *done 2026-11-25* | Hero (welcome + streak status line + link box; target, level and track not shown yet), first-run dashboard, Continue with 3 bars + resume point, Next up, Learning performance (no bars yet). **Interim order:** hero → Continue \| Next up → Learning performance → Vocabulary \| Needs attention (today's 7/5 pair, restyled). Phase 3 moves the deck above performance and diagnostics below it. | `streakActiveToday` (no SQL) | M |
| **3. Deck, diagnostics, review log** ✅ *done 2026-11-25 (046 not yet applied to Supabase)* | VocabularyDeck with inline grading, Fill the gap / Meaning modes and shortcuts (also on `/vocabulary/review`); Needs attention with example panel and History link; vocabulary reviews logged and counted in the streak (D9), and the streak line's urgent wording updated to mention word reviews; final section order. **As built:** the deck's link stays "Start review" and its copy never says "batch" (the existing rule: the review queue promises no order or batch size); the deck and diagnostics are full-width with container queries until their right-hand partners arrive; error-type descriptions match the real classifier (e.g. "wrong form" = same word count, any difference, including misspellings). Apply/verify steps: `supabase/DASHBOARD_REDESIGN_RUNBOOK.md`. | 046, `mistake-example` route, review route change | M–L |
| **4. Daily activity + goal** ✅ *done 2026-11-25 (046 and 047 not yet applied to Supabase)* | Weekly track ✓ and minutes, day popover (minutes), Today's target, 7-day bars, Profile dialog (goal). **As built:** `fn_update_my_profile` takes one `p_patch jsonb` (only the keys present change; null clears) instead of three positional params, so "unchanged" and "clear" can't be confused; the public-name CHECK also rejects `< > @ / \ :`, control characters and nickname-shaped names, since a direct PATCH (`users_self_update`) must hit the same rules. The day popover lives inside `WeeklyTrack.tsx` (no separate `DayDetailsPopover.tsx`) and opens on hover, focus or tap (tap/click pins it). The goal can also be changed from a slider icon next to Today's target (same `ProfileDialog`). `AddVideoDialog` and `ProfileDialog` share a new `ModalDialog` shell. If `/api/dashboard/week` fails (e.g. 047 not applied), the track, target and bars are left out, never shown as zeros. The week is refreshed after practice flushes, confirmed writes, word reviews and goal changes. | 047, `week` + `profile` routes | M |
| **5. XP and levels** ✅ *done 2026-11-25 (048 not yet applied to Supabase)* | XP pill, hero level bar, per-day XP on the weekly track, full day popover, goal/level celebrations, Monday recap (XP part). **As built:** the two local-day rules (vocabulary cap, active day) use ONE zone per learner, their most recently recorded browser timezone (`fn_xp_time_zone`, UTC if none), not the viewer's, so the total is the same in every view and on the Phase 7 board. `fn_my_xp`'s `p_time_zone` only dates `today`/`days`. `fn_xp_events(p_user_id, p_time_zone)` takes no window: firsts need the whole history, and callers filter. The level is derived in TypeScript from `totalXp` (`src/lib/xp/levels.ts`), not in SQL. `fn_my_xp` also returns `lastLeagueWeek {weekStart, xp, activeSec, wordsReviewed}` for the recap, and the per-day key is `shadowingSentences` (first take per sentence) instead of `shadowingTakes`. Vocabulary reviews past the 60 XP/day cap are listed as 0-XP events so `wordsReviewed` stays truthful. Legacy (unverified) answers earn sentence XP; only completion needs a verified round. The day popover leaves out Listening minutes (its XP is in the total). The recap is "claimed" on first show (localStorage), so it appears on the first visit of the week only. No new indexes were needed: `attempt_logs_round_segment_idx` and `shadowing_attempts_round_segment_idx` already cover the first-occurrence lookups. | 048, `xp` route | M |
| **6. Achievements** ✅ *done 2026-11-25 (049 not yet applied to Supabase)* | Trophy case, detail dialog, unlock toasts, streak-milestone popover. **As built:** `fn_sync_achievements()` takes no parameters (no metric needs the viewer's zone: the longest streak comes from `fn_activity_days`' per-record dates). Immersion thresholds are stored in hours. Five tracks in Phase 6; `achievement_tiers.track` already allows `league`, so Phase 7 only seeds its rows and adds its metric. Unlock toasts come from ONE app-wide `AchievementUnlockNotifier` (a query-cache subscriber in Providers), so each response's `newlyUnlocked` is announced once however many components read it; three or more are summed up in one toast. A lost race announces nothing (tested with two real connections). The header streak popover also shows today's goal status (plan §1), and both extras load only once it's opened. The trophy case counts tiers ("9/20 tiers"); tiles are a 2- or 3-column grid depending on width. `unlocked_at` is the first sync that saw the tier met, so existing learners' unlocks are dated at their first visit after 049. | 049, `achievements` route | M |
| **7. Leagues** | League card, `/leaderboard`, kudos, footer league, League achievement track, profile name/visibility, Monday recap league result | 050, `leaderboard` routes | XL |
| **8. Alignment** | Update `.github/instructions/frontend-ui.instructions.md` (it requires a prominent URL input at the top of the dashboard; the new design has it in the hero link box and the first-run hero, plus the header dialog) and `.github/skills/gemini-like-dashboard/SKILL.md` (frosted glass → new tokens), so Copilot stops steering back to the old design. Optionally migrate Library / Vocabulary / Bookmarks / History cards to the new card style. | none | S–M |

## 6. Tests

**Existing tests that will intentionally change:**

- `src/__tests__/dashboard-focus.test.tsx`: layout assertions (`max-w-3xl`, `lg:col-span-7/5` at ~206–243), the section order test (~250–258; "Add a video" leaves the page for the header and the hero link box), the welcome/streak test (~272).
- `src/__tests__/dashboard-library.test.tsx`: the add-video flow moves to `AddVideoForm` (hero link box and header dialog).
- `src/__tests__/app-header.test.tsx:41`: the nav list gains Leaderboard.
- Streak tests (`streak.test.ts`, `dashboard-summary-completed.test.ts`, the phase-6 activity-days integration tests): a vocabulary-only day now counts; `streakActiveToday` is added.
- Vocabulary review route tests: the route now calls `fn_record_vocabulary_review` and accepts `timeZone`.
- `src/__tests__/vocabulary-card.test.tsx` tests the **Vocabulary page's** card and is unaffected.

**New unit tests:**

- Hero link box: opens in place, autofocus, submit → navigate, inline error, Esc collapses and returns focus, typed text kept.
- Streak status line: all four states, the 18:00 switch, re-evaluation on focus.
- First-run dashboard: shown only when library, sessions and vocabulary are all empty; other cards hidden; history-only learner gets the normal dashboard.
- Fill the gap: blanking (case, word boundaries, first of several matches, punctuation next to the word), fallback to Meaning when not found, no audio on the front, mode remembered.
- Shortcuts: Space/Enter flip and 1–4 grade only with focus inside the deck; ignored in inputs; page-wide on `/vocabulary/review`.
- Day popover: content per phase, zero values left out, keyboard and touch reachable, none on inactive/future days.
- Resume point: 0-based index shown +1, hidden without a round, fallback without total.
- Celebrations: goal/level confetti fires once per value, nothing animates under reduced motion while the toast still shows, Monday recap once per week and hidden after an inactive week.
- Plus the earlier set: weekly-track derivation (local Mon–Sun, DST week, today marker), goal progress states, level math (`50·L·(L−1)` boundaries), `VocabularyDeck` (grade → POST with timezone, optimistic advance, rollback, empty state), diagnostics selection + example states, `AddVideoDialog` focus return, `LeagueCard` states and zones, `AchievementsCase` progress math, header pills, level-up toast.

**New integration tests** (localdb harness, like the existing `*.integration.test.ts`):

- `fn_record_vocabulary_review`: item update and log insert are atomic; invalid timezone → UTC fallback; backfill creates one flagged row per reviewed item.
- `fn_activity_days`: a vocabulary-only day counts; backfilled days are reported in `utcFallbackDays`.
- `fn_daily_activity`: sum of days = `activeTime.activeSec`; an interval crossing local midnight splits correctly; DST days; invalid tz rejected.
- **XP:** each rule pays only its first occurrence (retries, repeat takes, "Again" loops earn nothing); the 60 XP/day vocabulary cap; changing the daily goal does not change XP; the sum of daily XP equals the total; per-day `activity` counts match the events; weekly XP uses UTC week boundaries; legacy and abandoned rounds pay no completion XP.
- SQL streak helpers match `computeStreakFromDays`.
- `fn_sync_achievements`: idempotent, server-computed, no insert path for clients (direct insert denied by RLS).
- Leagues: join rules, rollover promotion/demotion including the small-group rule, idempotent under concurrent reads, kudos constraints (same group, once per week, not self), hidden users excluded, and **no email or auth id in any board response**.

## 7. Risks and notes

- **Privacy (D7):** existing users become visible under a pseudonym (weekly XP, streak) without having been asked. Mitigations in plan: pseudonymous by default, no emails or avatars, one-time notice, opt-out in Preferences. Consider also showing the notice on `/leaderboard`.
- **Public names:** length and charset checks only. No profanity or impersonation filter (out of scope; note for later).
- **XP rule changes rewrite history.** That's the cost of calculating XP instead of storing awards. Version the rules and announce changes; if stable totals become important later, add an award ledger written from these same rules.
- **XP calculation cost** runs on read (own totals, ≤ 30 league members, hourly all-time snapshot). Fine at the current scale; add a per-user daily XP cache if it grows.
- **Listening XP dating** uses the session start (no per-update timestamp). A session that crosses the Monday UTC boundary credits the whole session to the week it started in.
- **Vocabulary backfill** may suddenly lengthen some current streaks after Phase 3 ships (past review days start counting). That's truthful, but expect questions.
- **Vocabulary review time isn't measured:** a vocabulary-only day gets a streak ✓ and XP but 0 minutes toward the daily goal. Optional follow-up: activity tracking on the review page.
- **Fill the gap matching:** `term` normally appears in its own `sentence_context`, but edited terms won't; those cards fall back to Meaning mode rather than showing a broken blank.
- **Celebrations and the recap are tracked per browser** (localStorage), so a learner on two devices may see one twice. Acceptable for a one-time animation.
- **Lazy rollover and hourly snapshot** run inside user reads. Switch to `pg_cron` if board latency grows.
- **Join on read:** someone who practices but never opens the Dashboard or Leaderboard that week is not placed in a group. Optional follow-up: also join from `/api/study-session/activity`.
- **Font swap** changes text width everywhere, including the dictation player. Do a visual QA pass on the player, transcript and report pages in Phase 1. PDF export uses its own Noto Sans files and is unaffected.
- **Primary color remap** shifts every `primary-*` usage app-wide slightly toward the reference indigo. This is intended (D4).
