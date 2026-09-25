# Vocabulary Learning Statistics & Navigation Caching — Implementation Plan

Plan only — no application code, migrations, or dependencies were touched to produce this document. Findings below were re-verified against the current repository (not assumed from the prior audit).

## 1. Confirmed current behavior (re-verified against current code)

All prior-audit findings listed by the user were re-checked directly in the repo and are confirmed still accurate as of this session:

- `src/app/vocabulary/page.tsx:300-301` — `const hasNote = Boolean(item.note && item.note.trim().length > 0); const mastery = hasNote ? 100 : 60;`
- `src/app/vocabulary/page.tsx:203-206` — `masteredCount` = count of items with a nonempty `note`.
- `src/app/vocabulary/page.tsx:256` — "Total Words" = `items.length`.
- `supabase/migrations/003_vocabulary_srs.sql` — real SM-2-style fields: `next_review_at timestamptz not null default now()`, `interval_days numeric not null default 0`, `ease_factor numeric not null default 2.5`, `repetitions integer not null default 0`, `last_reviewed_at timestamptz` (nullable, **no default** — stays `null` until the first graded review, for both new and pre-existing/legacy rows).
- `src/app/api/vocabulary/review/route.ts:88-100` (`POST`) updates all five fields on every valid grade, including `last_reviewed_at: now.toISOString()` **unconditionally**, even for grade `"again"`. `src/lib/utils/srs.ts:42-45` confirms `"again"` resets `repetitions` to `0` and `interval_days` to `0` — so a failed review looks identical, on `repetitions` alone, to a never-reviewed item. `last_reviewed_at` is the only field that tells them apart.
- `src/app/vocabulary/page.tsx` never reads `next_review_at`/`interval_days`/`ease_factor`/`repetitions`/`last_reviewed_at`.
- `src/components/Providers.tsx:7-18` — root-level `QueryClient` (`staleTime: 60_000`, `retry: 1`, v5 defaults otherwise: `gcTime` 5 min, `refetchOnMount`/`refetchOnWindowFocus`/`refetchOnReconnect` all `true`), mounted above the router in `src/app/layout.tsx:29`, so it survives every page unmount for the tab's lifetime. `@tanstack/react-query` resolved version: `5.99.0` (`package-lock.json`).
- `src/app/dashboard/page.tsx:182-203` is the only page using `useQuery` (`["dashboard-summary", userId]`, `["dashboard-error-patterns", userId]`).
- `src/app/vocabulary/page.tsx:85-110`, `src/app/bookmarks/page.tsx:17-35`, `src/app/history/page.tsx:69-104` all use plain `useState`/`useEffect(() => {...}, [user])` with no cache — full reset on every remount.
- `src/app/history/page.tsx:82-104` independently `fetch("/api/dashboard/summary")` instead of reusing Dashboard's `["dashboard-summary", userId]` query.
- Vocabulary/Bookmarks search text, History's `videoFilter`/`errorTypeFilter`/date filters/pagination offset are all local `useState`, lost on navigation.
- Vocabulary's "Filter" button (`page.tsx:280-286`) has no `onClick` — a non-functional stub.

New findings from this pass, load-bearing for the design below:

- **`GET /api/vocabulary` (`src/app/api/vocabulary/route.ts:48-64`) has no `.limit()`/`.range()`** — it relies on PostgREST returning every row. PostgREST/Supabase projects commonly cap unbounded selects at a configurable `db-max-rows` (often 1000, sometimes unset). No `supabase/config.toml` or other in-repo setting overrides this, so the cap (if any) lives only in the hosted project's dashboard settings and **cannot be confirmed from the repository**. At the user's reported scale (254 rows) this is very unlikely to bite today, but "Total Words" already silently inherits this risk, and any new aggregate must not inherit it. See §3 and §12.
- **`GET /api/vocabulary/review` (`src/app/api/vocabulary/review/route.ts:9-38`) caps its queue at `REVIEW_BATCH_SIZE = 20`** (`.limit(20)`). It cannot be used to derive an accurate "due" count — a dedicated count query is required.
- Word vs. phrase is **not a stored column**. It's inferred consistently from whitespace: `!/\s/.test(item.term.trim())` (`src/app/api/vocabulary/pronounce/route.ts:131`), and, more completely, `inferSavedItemType(item: VocabularyItem): "word"|"phrase"|"sentence"` in `src/app/dictation/[videoId]/helpers.ts:262-267` (checks whitespace, plus a "term equals sentence_context" case for `"sentence"`). This function already operates on the exact `VocabularyItem` shape the Vocabulary Bank fetches — it's directly reusable, just filed in a route-scoped module today.
- `src/app/api/history/mistakes/route.ts:18-113` is a genuinely well-built paginated endpoint (`offset`/`limit`, `count: "exact"`, `hasMore`) — a good match for TanStack Query's `useInfiniteQuery`.
- `src/context/auth.tsx:66-70` (`signOut`) does not clear the query cache. `AuthProvider` renders inside `QueryClientProvider` (`Providers.tsx:20-23`), so `useQueryClient()` is available there.
- The app already has an established convention for page-local, remount-surviving UI state: `sessionStorage`/`localStorage` used throughout `src/app/dictation/[videoId]/*` (e.g. `sessionPersistence.ts`, `useInputModePreference.ts`, `useAutoAdvancePreference.ts`) with a consistent `typeof window !== "undefined"` guard. No page in the app currently uses `useSearchParams`/URL-driven state — this would be a new (but framework-idiomatic) pattern.
- Vocabulary writes happen from **three** places, not one: `src/components/VocabularySaveButton.tsx:26-53` (`POST`, dashboard/history-adjacent save), `src/app/dictation/[videoId]/useLessonCapture.ts` — `saveLessonCaptureAtSegment` (`POST`, line 282-330+), `updateLessonCapture` (`PATCH`, line 469-522+), `finalizeDelete`/`requestDeleteLessonCapture` (`DELETE`, line ~410-450), plus the Vocabulary Bank page's own `handleUpdate`/`handleDelete`, plus `/vocabulary/review`'s `handleGrade` (`POST /api/vocabulary/review`). Any of these can make the Vocabulary Bank's cached data stale from a different page.
- No test in the repo covers `src/app/vocabulary/page.tsx`'s stats or mastery logic (confirmed again: `vocabularyPanel.test.tsx` tests the unrelated dictation-page `WordsTab`, not this page).

## 2. Recommended product decisions

1. Replace the note-based "Mastery %" (progress bar) and "Mastered" count with a **three-state learning status** — New / Learning / Due — derived entirely from the existing SRS columns. No new schema.
2. Personal notes stay fully editable but stop influencing anything learning-related.
3. Vocabulary Bank's aggregate header becomes **Total / New / Learning / Due**, all server-computed (exact counts), independent of any row cap on the card-list fetch and independent of search/filter.
4. "Start review session" shows how many items are actually reviewable right now (`New + Due`), so it's never silently empty-looking when only New items are waiting.
5. Wire Vocabulary, Bookmarks, Dashboard, and History's list data through the existing root `QueryClient`, matching Dashboard's already-working pattern — no new library.
6. History stops duplicating Dashboard's summary fetch; both call one shared hook/query definition.
7. Preserve search/filter/pagination/scroll per page across nav-tab navigation, scoped per signed-in user, using `sessionStorage` as the source of truth (mirrored into the URL for shareability/back-forward) — chosen over URL-only because the nav tabs link to bare paths (see §6).
8. Turn the dead Filter button into a working Type (All/Word/Phrase) + Status (All/New/Learning/Due) filter, since both are backed by real, already-fetched data — no invented categories.
9. Keep visual design intact: swap the existing progress-bar element for a same-slot status pill/badge; keep the existing stat-card layout, just with different labels/numbers.

## 3. Learning-status rules and statistics definitions

### 3.1 Status predicate (single source of truth)

```
last_reviewed_at IS NULL                                → "new"
last_reviewed_at IS NOT NULL AND next_review_at <= now() → "due"
last_reviewed_at IS NOT NULL AND next_review_at >  now() → "learning"
```

Precedence is top-to-bottom and mutually exclusive/exhaustive over all rows. Rationale, tied to the schema as it exists today:

- `last_reviewed_at` is the **only** field that distinguishes "never touched" from "touched." `next_review_at` defaults to `now()` at insert time and is therefore always `<= now()` a moment later — it cannot be used to detect "new" (this is the exact trap the user flagged: don't treat the default as "due for a previously-learned item").
- `repetitions === 0` cannot mean "new" either, because grade `"again"` resets it to `0` too (`src/lib/utils/srs.ts:42-45`). Only `last_reviewed_at` survives a reset.
- Legacy rows (saved before migration `003_vocabulary_srs.sql`) got `last_reviewed_at = NULL` on backfill, identically to a genuinely new item — correct behavior, no special-casing needed ("never reviewed" is true for both).
- All five SRS columns are `timestamptz`/numeric with `not null` (except `last_reviewed_at`); no legacy-null handling is needed beyond the `last_reviewed_at IS NULL` branch itself. Defensive `?? epoch` handling for a theoretically-null `next_review_at` is a one-line guard, not a real scenario (`not null default now()`).
- Timestamps are `timestamptz` (UTC-stored, instant comparisons) — no timezone/calendar-day logic is involved; day-granularity scheduling makes client/server clock skew a non-issue.
- **No migration is needed.** The existing five columns are sufficient to derive all three states; there is nothing a new column would add that isn't already computable from `last_reviewed_at`/`next_review_at`.

**"Again" edge case, explicit:** grading an item "Again" sets `repetitions=0`, `interval_days=0`, `next_review_at=now()`, **and** `last_reviewed_at=now()`. Under the predicate above this evaluates to `due` (has been reviewed, and is due immediately) — correctly distinct from `new`, and correctly signaling "needs review again soon," not "back to square one."

**Keeping status current while a tab is open / on focus regain:** status is computed at render time from fetched timestamps, not cached as its own column, so it's automatically correct as soon as fresh data arrives. Fresh data arrives via the query's default `refetchOnWindowFocus: true` (inherited from `Providers.tsx`, must **not** be overridden the way `useDictationSession.ts:179` overrides it for its own unrelated reasons) — so returning to the tab after reviewing in another tab silently refreshes status/counts. No polling/interval needed; SRS granularity is in days, so no live-ticking clock is required either.

### 3.2 Statistics (server-side, exact counts — new `GET /api/vocabulary/stats`)

| Stat | Definition | Query shape |
|---|---|---|
| Total | count of all owned `vocabulary_items` rows | `select("id", { head: true, count: "exact" }).eq("user_id", user.id)` — same pattern already used for `vocabularyCount` in `src/app/api/dashboard/summary/route.ts:123` |
| New | `last_reviewed_at IS NULL` | add `.is("last_reviewed_at", null)` |
| Due | `last_reviewed_at IS NOT NULL AND next_review_at <= now()` | add `.not("last_reviewed_at", "is", null).lte("next_review_at", nowIso)` |
| Learning | `last_reviewed_at IS NOT NULL AND next_review_at > now()` | add `.not("last_reviewed_at", "is", null).gt("next_review_at", nowIso)` |

Run as `Promise.all([...])`, mirroring the existing parallel-query style in `src/app/api/dashboard/summary/route.ts:107-134`. Four lightweight `head:true` count queries, not four full-row fetches — this is what makes the stats correct regardless of the `GET /api/vocabulary` row-cap unknown (§1, §12): **Total/New/Learning/Due are decoupled from the card-list fetch entirely.**

**Why a new endpoint instead of extending `GET /api/vocabulary`'s response:** keeps the card list's loading/error state independent from the stats' loading/error state (cards can render while stats show a placeholder, and vice versa — required by §7), and keeps the list route's response shape unchanged for any other caller.

- **Scope:** whole owned collection, always — never affected by search text or the new Type/Status filter (matches current Total/Mastered intent; explicitly documented in the stat header's tooltip/label so it's unambiguous, per the user's "make that distinction consistent and clear").
- **Words and phrases:** both included — there's no DB-level type column to exclude by; the Type filter (§7) is purely a client-side view of the already-fetched list and never feeds back into these counts.
- **Consistency with per-card status:** the per-card badge (§3.1 predicate, evaluated client-side per `VocabularyItem` already in the fetched list) and the server-side counts (§3.2, same predicate expressed in SQL) must agree. Because these live in two languages (TS and SQL) they can't literally share code — implementation must keep them side-by-side with a comment cross-referencing the other, and a test (§11) that seeds fixtures spanning all three buckets and checks both paths agree.

### 3.3 Review entry point

"Start review session" badge count = `New + Due` (i.e., `next_review_at <= now()` regardless of `last_reviewed_at`) — this is **exactly** the review queue's existing admission filter (`src/app/api/vocabulary/review/route.ts:24`, `.lte("next_review_at", ...)`, unfiltered by `last_reviewed_at`), so `New + Due` is mathematically identical to "how many items the queue would admit," with no separate query and no change to the queue's own semantics (per the explicit instruction not to touch scheduling to make counts easier). Every `New` item's `next_review_at` is frozen at its insert-time value, which is always in the past relative to "now," so `New ⊆ {next_review_at <= now()}` always holds — the badge count is `newCount + dueCount`, nothing more to derive.

This directly resolves "if Due is zero but New is nonzero, the button must not look empty" — New items are already counted into the badge.

The 20-row cap on `GET /api/vocabulary/review` (`REVIEW_BATCH_SIZE`) stays a pure batch size for the review session itself; it never gates the badge count (§3.2's `Due`/`New` counts are uncapped `head:true` counts).

### 3.4 Editing the term — current behavior, explicitly preserved

`PATCH /api/vocabulary` (`src/app/api/vocabulary/route.ts:334-394`) already excludes all five SRS columns from its update payload — editing `term`/`sentenceContext`/`note`/`translation`/`phonetic`/`partOfSpeech`/`definition` (even when `termChanged` is true and phonetic/definition/canonical metadata/audio get nulled) **never touches** `next_review_at`/`interval_days`/`ease_factor`/`repetitions`/`last_reviewed_at`. This plan keeps that behavior unchanged — editing a term does not reset or otherwise affect learning status. Whether a heavily-edited term *should* reset progress is a separate product question, out of scope here (flagged in §12), not incidentally decided by this work.

## 4. Query-key / cache configuration table

All keys are scoped by `userId` (mirroring Dashboard's existing pattern) and gated `enabled: !!userId`. All reuse the root `QueryClient` from `Providers.tsx` — no new provider, no per-page `QueryClientProvider`.

| Data | Query key | Query fn → endpoint | Used by | staleTime / gcTime | Refetch |
|---|---|---|---|---|---|
| Vocabulary items | `["vocabulary-items", userId]` | `GET /api/vocabulary` → `{ items }` | Vocabulary Bank (cards, search, type/status filter) | 60s / 5min (defaults) | on mount, focus, reconnect (defaults) |
| Vocabulary stats | `["vocabulary-stats", userId]` | `GET /api/vocabulary/stats` (new) → `{ total, new, learning, due }` | Vocabulary Bank (stat header, review badge) | 60s / 5min | defaults |
| Bookmarks | `["bookmarks", userId]` | `GET /api/bookmarks` → `{ items }` | Bookmarks page | 60s / 5min | defaults |
| Dashboard summary | `["dashboard-summary", userId]` | `GET /api/dashboard/summary` → `DashboardData` | **Dashboard and History** (shared hook, §5) | 60s / 5min | defaults |
| Error patterns | `["dashboard-error-patterns", userId]` | `GET /api/dashboard/error-patterns` | Dashboard only | 60s / 5min | defaults |
| History mistakes | `["history-mistakes", userId, filters]` (filters = `{videoId, errorType, dateFrom, dateTo}`) | `GET /api/history/mistakes` → paginated | History (`useInfiniteQuery`, `pageParam` = offset, `getNextPageParam` from `hasMore`) | 60s / 5min | defaults; `placeholderData: keepPreviousData` so a filter change doesn't blank the list mid-refetch |

No query overrides `staleTime`/`gcTime` individually — the global 60s/5min defaults from `Providers.tsx` are reused everywhere for consistency; nothing in this work requires diverging from them.

**Initial-loading vs. background-refresh, uniformly:** every consumer distinguishes "no data yet" (`data === undefined`, i.e. v5's `status === "pending"`) from "refreshing in the background" (`isFetching === true` while `data` is already populated) — only the former renders a loading placeholder; the latter renders existing data with, at most, a small non-blocking indicator. This is the mechanism behind every "don't blank the page" requirement in §7.

## 5. Mutation-to-cache-update matrix

| Action | Call site | Cache effect |
|---|---|---|
| Save new item / re-save existing (dedupe) | `VocabularySaveButton.tsx:26-53` (`handleSave`) | On success: `queryClient.invalidateQueries({queryKey: ["vocabulary-items", userId]})` + `["vocabulary-stats", userId]` |
| Save new item from practice-page popover | `useLessonCapture.ts` `saveLessonCaptureAtSegment` (line 282+) | Same invalidation, added alongside its existing `setLearningItems` local-state update (that local state is unrelated/out of scope — untouched) |
| Edit term/note/translation/etc. | `useLessonCapture.ts` `updateLessonCapture` (line 469+) | Same invalidation (term-changed nulling of phonetic/definition/canonical/audio is server-side already; client just needs the Vocabulary Bank's cache to catch up) |
| Delete item | `useLessonCapture.ts` `finalizeDelete`/`requestDeleteLessonCapture` (~line 410-450) | Same invalidation |
| Edit item (Vocabulary Bank's own form) | `src/app/vocabulary/page.tsx` `handleUpdate` | Convert to `useMutation`; `onSuccess`: `queryClient.setQueryData(["vocabulary-items", userId], old => old.map(i => i.id === updated.id ? updated : i))` — direct cache write, same shape as today's `setItems(prev => prev.map(...))`. No `vocabulary-stats` invalidation needed (note/translation/etc. edits don't change status; term edits don't touch SRS fields either, §3.4) |
| Delete item (Vocabulary Bank's own button) | `src/app/vocabulary/page.tsx` `handleDelete` | Convert to `useMutation`; `onSuccess`: `setQueryData` filter out the id, **and** `invalidateQueries(["vocabulary-stats", userId])` (cheap exact-count refetch — simpler and safer than guessing which bucket the deleted item was in) |
| Complete a review grade | `src/app/vocabulary/review/page.tsx` `handleGrade` | On success: `invalidateQueries(["vocabulary-items", userId])` + `["vocabulary-stats", userId])`. This only needs to be correct **on next visit** to Vocabulary Bank (per the user's explicit "does not require the visible status label to change after every grade" — no need for the review page and Vocabulary Bank to be simultaneously open/synced in real time); plain invalidation (query refetches next time it's mounted/observed) satisfies this |
| Add/remove bookmark (own page) | `src/app/bookmarks/page.tsx` `handleDelete`, convert to `useMutation` | `setQueryData` filter out |
| Update bookmark note (own page) | `src/app/bookmarks/page.tsx` `handleUpdateNote`, convert to `useMutation` | `setQueryData` map-replace |
| Add/remove/update-note bookmark (dictation/listening pages) | `src/hooks/useBookmarks.ts` `toggleBookmark`, `deleteBookmark`, `updateBookmarkNote` | On success: `invalidateQueries(["bookmarks", userId])`, added alongside existing local-state updates (that hook's own `bookmarks` state stays as-is — it serves a different, per-video UI, out of scope) |
| Complete/progress a dictation or listening session | dictation/listening pages (session-save flow) | **No new invalidation added.** Out of scope for this release — Dashboard/History already refresh correctly on next visit via `staleTime`/`refetchOnMount`, which is the existing, working mechanism (see §1, "Dashboard already behaves well"); adding push-style invalidation here would expand scope into the large, sensitive dictation-session codepath for no reported problem |
| Export CSV | `GET /api/vocabulary/export` | Read-only, no cache interaction |

**Optimistic updates:** none proposed. Every current write already waits for the server response before updating UI (not optimistic today); this plan preserves that exactly, just relocating "update UI" from local `useState` to `queryClient.setQueryData`/`invalidateQueries`. No rollback logic is needed as a result. (Optimistic delete is a plausible future nicety, not required — noted in §12.)

**Avoiding over-invalidation:** every invalidation above is scoped to the one or two keys actually affected (`vocabulary-items`/`vocabulary-stats`, or `bookmarks`) — nothing invalidates Dashboard, History, or unrelated queries as a side effect.

## 6. View-state ownership and navigation behavior

**Chosen model:** `sessionStorage` is the canonical store for each page's search/filter/pagination-position values; the same values are mirrored into the URL query string via `router.replace(href, { scroll: false })` (no new history entries) purely for shareability and native Back/Forward support. This resolves the specific gap the user flagged: `AppHeader`'s nav links (`src/components/AppHeader.tsx:8-13`) are and remain bare paths (`/vocabulary`, `/bookmarks`, `/history`) — intentionally not modified to carry query strings, since that would couple a shared, generic nav component to each page's private state shape. Because `sessionStorage` is the source of truth, a bare-path click still restores the last state; the URL mirror exists only for the secondary cases (direct links, Back/Forward) below.

Namespacing: `sessionStorage` keys are `vocab:viewstate:{userId}`, `bookmarks:viewstate:{userId}`, `history:viewstate:{userId}` — scoped per signed-in user (see §8).

| Case | Behavior |
|---|---|
| Click a nav tab (bare path) | Load from `sessionStorage` for the current `userId`; if present, restore search/filter/pagination and reflect it into the URL via `router.replace`; if absent, defaults |
| Direct link / shared URL with explicit query params | URL wins over any stored value on that load, and immediately overwrites the stored value (so subsequent bare-path visits keep the newly-arrived state) |
| Change a filter/search value in the UI | Update local state → write-through to `sessionStorage` → `router.replace` the URL (debounced for text search, immediate for discrete filters) |
| Browser Back/Forward | Browser restores the URL; the page reads query params on that navigation and applies them (same code path as "direct link"), so Back/Forward is meaningfully different from a tab click only in that it always carries the exact prior URL, while a tab click relies on the `sessionStorage` fallback |
| Account change (sign out / different user signs in, same tab) | New `userId` ⇒ new `sessionStorage` key ⇒ no bleed-through; old user's key is left orphaned in `sessionStorage` (tab-scoped, low risk) but never read again unless that same user signs back in in the same tab (see §8 for the stricter cache-side isolation) |
| Full browser reload | Supported **within the same tab session** — `sessionStorage` survives a reload of the same tab, not a new tab or a closed-and-reopened browser. This is stated as the release's explicit scope; "survive closing the browser" is not attempted (`localStorage` would be needed for that, and isn't recommended here — filters are session-scoped UX, not a durable preference) |

**Not in scope:** open edit dialogs/unsaved drafts (explicitly excluded by the user); sort or display-mode controls (none exist today — not adding any solely to fill this inventory, per the explicit instruction).

**Filters covered:** Vocabulary search + new Type/Status filters (§7); Bookmarks search; History's `videoFilter`/`errorTypeFilter`/`dateFromFilter`/`dateToFilter` + current mistakes pagination offset (the offset is naturally owned by `useInfiniteQuery`'s internal page state, not `sessionStorage` — only the *filters* need persisting; re-opening the page re-fetches from offset 0 with the restored filters, which is the correct and simplest behavior, not "resume mid-scroll-list").

### Scroll restoration

New shared hook, e.g. `src/hooks/useScrollRestoration.ts`:

- Key: `` `scroll:{pathname}:{userId}` ``, `sessionStorage`-backed (per-page, per-user — never applied across pages, addressing the explicit "don't apply one page's position to another").
- Save: on scroll, throttled (e.g. via `requestAnimationFrame` or a short debounce — minimal, no new dependency), and on unmount.
- Restore: only after content is actually ready — gate on the page's query being `!isFetching && data !== undefined` (or, more simply, on the rendered list having its expected item count) — via `useLayoutEffect`, `window.scrollTo({ top: clamped, behavior: "auto" })` (never `"smooth"`, to avoid the "scroll-to-top then animated jump" failure mode called out explicitly).
- Clamp: `Math.min(savedY, document.body.scrollHeight - window.innerHeight)` so a shorter filtered/edited list never leaves a dangling scroll position.
- Explicitly does **not** apply when navigating *into* the page from an intentional deep link to a specific item (e.g., History's "Jump to this spot", Vocabulary's "Open source video" — those are navigations *away* to a different page, not into these list pages, so this caveat is naturally satisfied: nothing on these four pages deep-links to a scroll offset on another of these four pages).
- Adopted on Vocabulary, Bookmarks, History only (long, scrollable card/list pages). Not added to Dashboard — no reported problem there, and Dashboard is intentionally excluded to keep scope tight (a same-pattern follow-up is trivial later if wanted).

## 7. Loading, empty, refreshing, and error states

| State | Rule |
|---|---|
| First visit, no cached data | Show the existing loading copy ("Loading vocabulary…", "Loading bookmarks…", "Loading history…") — this is the one legitimate case for it, gated on `data === undefined`, not on `isFetching` |
| Return with valid cached data | Render immediately; no loading copy, no stat flash to zero |
| Cached data present but stale (past `staleTime`) | Render the stale data immediately; a background refetch runs silently (`isFetching` true, `data` unchanged) — no UI clearing |
| Background refetch fails | Previously loaded, still-usable data stays visible; surface a small inline "Couldn't refresh — retry" affordance (reuses each page's existing `error` messaging convention) rather than replacing content with an error page |
| Genuinely empty (0 rows) | Existing "No saved vocabulary yet." / "No bookmarks yet." / "No recent sessions yet." copy, unchanged |
| Filtered to empty (rows exist, filter/search yields 0) | **New**, distinct copy — "No results match your filters/search" — so it's never confused with a truly empty account (Vocabulary and Bookmarks currently conflate these into one message; History's mistakes panel already has the right distinction at `history/page.tsx:385-388`) |
| Stats (`vocabulary-stats`) unavailable while items list is fine, or vice versa | Each stat/list renders from its own query's state independently; an unavailable stat shows a placeholder (`—` or a skeleton), never a fabricated `0` |

Explicitly not done: keeping every page permanently mounted, or globally disabling refetch-on-focus/mount — neither is needed once each page has its own cache entry, and both were explicitly ruled out by the user.

## 8. Filter-button decision

Implement (don't remove) the Filter button, scoped to what the data actually supports:

- **Type:** All / Word / Phrase — via the relocated `inferSavedItemType` (moved from `src/app/dictation/[videoId]/helpers.ts` into `src/lib/utils/vocabulary.ts` so both the dictation page and Vocabulary Bank import one implementation; the dictation module re-exports or imports from the shared location to avoid a duplicate). "Sentence"-typed rows (the third value `inferSavedItemType` can return) are folded into "Phrase" for this filter's purposes, or exposed as a third option if the implementer finds real sentence-type rows in the data — decide during implementation by checking actual data, not assumed here.
- **Status:** All / New / Learning / Due — via the §3.1 predicate.
- **Combination with search:** AND semantics, same order as the existing dictation-page `filterVocabularyItems` (`src/app/dictation/[videoId]/helpers.ts:312-329`) — type/status filter first, then text search — for consistency with the one existing precedent in this codebase.
- **Reset:** a "Clear filters" affordance appears once any non-default filter/search is active; resets type → all, status → all, search → "".
- **Persistence:** participates in the §6 `sessionStorage`/URL mechanism, same as search.
- **Result count:** small "{n} of {total}" near the grid when a filter or search is active (cheap addition, consistent with the existing stat-badge styling).
- **Filtered-empty state:** per §7.
- Not added: grammatical phrase classification or any other advanced/invented category — only Word/Phrase (already inferable) and New/Learning/Due (already computable) are in scope.

## 9. Ordered implementation phases and dependencies

1. **Shared utilities** (no visible behavior change): relocate `inferSavedItemType`/`LessonItemType` into `src/lib/utils/vocabulary.ts`; add `getVocabularyLearningStatus(item, now)` there too. Update `src/app/dictation/[videoId]/helpers.ts` to import/re-export so existing imports (`vocabularyPanel.test.tsx`, `WordsTab.tsx`, `RightPanelTabs.tsx`) keep working unchanged. Add unit tests for the new predicate (edge cases from §3.1).
2. **Stats endpoint**: add `GET /api/vocabulary/stats` (§3.2). Add a route test.
3. **Vocabulary Bank UI truthfulness**: replace the mastery %/progress bar with a status pill; replace Total/Mastered header with Total/New/Learning/Due sourced from the stats endpoint; update the review-session link's badge (§3.3). *(Depends on 1–2.)*
4. **TanStack Query — Vocabulary**: add `src/lib/queries/vocabulary.ts` (keys + `useVocabularyItemsQuery`/`useVocabularyStatsQuery`); convert `page.tsx`'s fetch/edit/delete to query/mutation (§5); wire invalidation into `VocabularySaveButton.tsx`, `useLessonCapture.ts` (three call sites), and `/vocabulary/review`'s `handleGrade`. *(Depends on 2–3 for the shapes being cached.)*
5. **TanStack Query — Bookmarks**: `src/lib/queries/bookmarks.ts`; convert `bookmarks/page.tsx`; wire invalidation into `useBookmarks.ts`.
6. **TanStack Query — Dashboard/History shared summary + History mistakes**: extract `src/lib/queries/dashboard.ts` (`useDashboardSummaryQuery`, `useErrorPatternsQuery`); switch **both** `dashboard/page.tsx` and `history/page.tsx` to call it; add `src/lib/queries/historyMistakes.ts` (`useInfiniteQuery`) and switch `history/page.tsx`'s mistakes section to it.
7. **View-state + scroll restoration**: `src/hooks/usePersistedViewState.ts`, `src/hooks/useScrollRestoration.ts`; adopt on Vocabulary/Bookmarks/History.
8. **Filter button**: implement Type/Status filtering on Vocabulary Bank using phase 1's helpers and phase 7's persistence hook.
9. **Account isolation hardening**: `queryClient.clear()` in `src/context/auth.tsx` `signOut`; confirm every new query key includes `userId` and is `enabled: !!userId`; namespace all new `sessionStorage` keys by `userId`.
10. **Tests, lint, build**: see §11.

Phases 1–3 (truthful statistics) and 4–9 (caching/navigation) are logically independent halves and can ship as two separate PRs if a smaller review surface is preferred; together they are the smallest release that satisfies both stated goals.

## 10. Files to add or modify

**New:**
- `src/app/api/vocabulary/stats/route.ts`
- `src/lib/queries/vocabulary.ts`
- `src/lib/queries/bookmarks.ts`
- `src/lib/queries/dashboard.ts`
- `src/lib/queries/historyMistakes.ts`
- `src/hooks/usePersistedViewState.ts`
- `src/hooks/useScrollRestoration.ts`
- `src/__tests__/vocabulary-stats-route.test.ts`
- `src/__tests__/vocabularyLearningStatus.test.ts`
- `src/__tests__/vocabulary-page.test.tsx` (first render/interaction test for this page — none exists today)

**Modified:**
- `src/lib/utils/vocabulary.ts` — add `inferSavedItemType`(relocated)/`getVocabularyLearningStatus`
- `src/app/dictation/[videoId]/helpers.ts` — import/re-export relocated helper instead of defining it
- `src/app/vocabulary/page.tsx` — remove mastery calc; status pill; stats/items queries; edit/delete mutations; Type/Status filter UI; view-state + scroll restoration wiring
- `src/app/bookmarks/page.tsx` — query/mutations; view-state + scroll restoration
- `src/app/dashboard/page.tsx` — switch to `useDashboardSummaryQuery`/`useErrorPatternsQuery`
- `src/app/history/page.tsx` — switch to shared summary query; `useInfiniteQuery` for mistakes; view-state + scroll restoration
- `src/hooks/useBookmarks.ts` — invalidate `["bookmarks", userId]` on mutate
- `src/app/dictation/[videoId]/useLessonCapture.ts` — invalidate vocabulary keys in `saveLessonCaptureAtSegment`, `updateLessonCapture`, `finalizeDelete`
- `src/components/VocabularySaveButton.tsx` — invalidate vocabulary keys on save
- `src/app/vocabulary/review/page.tsx` — invalidate vocabulary keys on grade success
- `src/context/auth.tsx` — `queryClient.clear()` on `signOut`

**Explicitly not modified:** `src/components/AppHeader.tsx` (nav links stay bare paths — a deliberate decision, §6), `src/components/Providers.tsx` (global defaults are reused as-is, no per-query overrides needed), no `supabase/migrations/*` file (no schema change).

## 11. Tests and acceptance criteria

### Learning statistics
- New item, with and without a personal note, resolves to the same status (`new`) — proves note no longer drives status.
- Editing a note (add/remove/change) does not change status or counts.
- An item graded `"again"` (repetitions reset to 0) is classified `due`, not `new` — exercises the exact edge case called out in the brief.
- Boundary: `next_review_at` exactly equal to "now" classifies as `due` (`<=`), one second in the future as `learning`.
- Legacy row (`last_reviewed_at = null`, arbitrary `next_review_at`) classifies as `new`.
- `GET /api/vocabulary/stats` counts match a hand-seeded fixture spanning all three buckets, and match what the client-side predicate computes over the same fixture (cross-check test, §3.2).
- Completing a review grade changes the item's `next_review_at`/`last_reviewed_at` (existing `vocabulary-review-route.test.ts` coverage) **and**, after cache invalidation, a subsequent `vocabulary-items`/`vocabulary-stats` fetch reflects it.

### Navigation and data
- Warm-cache navigation (visit Vocabulary → Bookmarks → back to Vocabulary within 60s) shows no loading copy and no stat flash to zero.
- Data older than `staleTime` still renders immediately, with a background refetch that doesn't clear content.
- A background refetch that fails (mocked network error) leaves prior content visible plus a retry affordance.
- History's dashboard-summary section and Dashboard's, given the same mocked `userId`, resolve from one shared query (assert no duplicate `fetch` call in a test that mounts both against one `QueryClient`).
- Each mutation in §5's matrix updates exactly the cache entries listed (no unrelated query is invalidated).
- Search/filter/pagination state (Vocabulary, Bookmarks, History) survives a simulated nav-tab click (remount) via the `sessionStorage`-backed hook.
- Scroll position restores after data is ready, not before; clamps correctly against a shorter list.
- A direct link with explicit query params wins over a stored value; Back/Forward reflects the prior URL's params.
- Signing out clears the query cache; a second user signing in on the same tab never renders the first user's data (assert via a test that swaps `userId` mid-session).

### Commands (for implementation-time verification — not run as part of this plan)
- `npm run lint`
- `npm run build`
- `npm test`

External services (Azure TTS/Translator, Gemini) must stay mocked in all new/changed tests, per existing convention (`src/__tests__/azureTts.test.ts` etc.) — no quota-consuming calls.

### Browser acceptance sequence (manual, once implemented)
1. Open Vocabulary, wait for data to load (cold — confirm the loading state appears exactly once).
2. Apply a search term and a Type/Status filter; scroll partway down the grid.
3. Navigate to Bookmarks (nav tab click), then to History.
4. Return to Vocabulary via nav tab (bare path) — confirm: no loading flash, stats don't drop to zero, search/filter/scroll are all restored.
5. Complete a review grade on `/vocabulary/review` for one item; return to Vocabulary — confirm that item's status pill and the New/Learning/Due counts reflect the grade.
6. Repeat steps 1–4 through Dashboard in place of Bookmarks/History, and compare — Dashboard and the other three pages should now behave the same way.
7. Use the browser's Back button instead of a nav-tab click at step 4 — confirm URL-driven restoration also works.
8. Distinguish, via the Network tab: the initial cold load's requests vs. the warm-return's absence of a duplicate list/stats request vs. a legitimate background revalidation request that doesn't clear the UI.

This sequence was not executed in this session (plan-only, per the user's instruction) — it is the acceptance procedure for whoever implements and verifies the change.

## 12. Rollout considerations and remaining uncertainties

- **PostgREST row cap on `GET /api/vocabulary`:** not verifiable from the repo (no `supabase/config.toml` present; the setting lives in the hosted project's dashboard). Recommend checking it before/alongside implementation. Low practical risk at current data volumes (254 rows), and the new stats endpoint is deliberately designed to be immune to it regardless (§3.2); the card-list fetch itself is left unpaginated in this release (introducing list pagination is a larger, separate change not required by anything reported here).
- **Dashboard surfacing New/Due counts:** not requested, not added — an easy follow-up given `vocabulary-stats` already exists once this ships.
- **Optimistic UI:** not added (§5) — current UX already waits for server responses; revisit only if a future usability pass asks for it.
- **Term-edit resetting SRS progress:** current behavior (no reset) is preserved as-is (§3.4); whether it *should* reset is a distinct product decision, explicitly deferred.
- **`AppHeader` nav links staying bare vs. carrying remembered query strings:** chosen deliberately (§6) to avoid coupling a shared component to four pages' state shapes; reversible later without touching this release's data layer if the product wants shareable "resume where I left off" tab links instead of the `sessionStorage` fallback.
- **Splitting into two PRs** (stats truthfulness vs. navigation caching, per §9) is a rollout option, not a requirement — both together is the smallest release that satisfies both stated goals, and each half is independently safe to ship first if preferred.
- No migration is proposed anywhere in this plan (§3.1 explains why the existing SRS columns are sufficient); no new dependency is proposed (TanStack Query v5.99.0 is already installed and already proven on Dashboard).

---

**Plan location:** `.claude/vocabulary-stats-and-navigation-caching-plan.md`

**Decisions that need implementation sign-off before coding starts**, in order of impact:
1. Replacing "Mastery %"/"Mastered" with New/Learning/Due, defined purely from `last_reviewed_at`/`next_review_at` — no migration.
2. A new `GET /api/vocabulary/stats` endpoint for server-side exact counts, decoupled from the card-list fetch.
3. `sessionStorage`-as-canonical + URL-mirror for view-state, with `AppHeader` links deliberately left as bare paths.
4. Extracting Dashboard's summary query into a shared hook consumed by both Dashboard and History.
5. Implementing the Type/Status filter now (vs. removing the dead button) — recommended, since both filters are backed by data that already exists.
