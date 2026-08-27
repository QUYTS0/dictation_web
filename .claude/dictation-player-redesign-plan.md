# Dictation player redesign — implementation plan

Source of truth for the direction: the approved Claude Design mockup at
https://claude.ai/code/artifact/0b80294d-1af0-4731-9dd3-48041e7f0e45
(10 artboards: Watch & Listen Default/Theater/Focus, Dictation Default/Theater/Focus,
Settings, Mode Switcher popup, Subtitle Visibility popup, Regenerate menu).

Scope: `src/app/dictation/[videoId]/`. Reworks the Dictation mode UI end to end;
Watch & Listen mode (`src/app/listening/[videoId]/`) and other pages are untouched
until Phase 3.

## Phase 1 — Structural reorg (DONE)

Goal: consolidate scattered controls into the mockup's information architecture,
with no visual reskin yet (still the light/indigo theme).

- `types.ts` / `constants.ts`: `RightPanelTab` narrowed to `"script" | "words" | "sentences"`
  (dropped `"saved"` / `"bookmarks"`); added `ShortcutEntry` and a `SHORTCUTS` list.
- `useLessonCapture.ts` / `helpers.ts`: removed the now-unused `SavedFilter` type,
  `savedFilter` state, `filteredSavedItems` and `getSavedFilterLabel` — replaced by
  per-tab filtering of `lessonSavedInCurrentVideo`.
- New: `components/SettingsDrawer.tsx` — desktop-only right-side drawer (video size,
  playback rate, auto-advance, practice mode, Audio/Zen mode, keyboard shortcuts list).
  Replaces the old always-visible desktop toolbar row; opened via a new header icon.
  Mobile keeps its existing quick-row + `MobileBottomSheet` untouched.
- New: `components/RightPanelTabs.tsx`, `ScriptTab.tsx`, `WordsTab.tsx`, `SentencesTab.tsx`
  — the right panel is now Script / Words / Sentences (Sentences folds in Bookmarks as a
  second section). Script tab blurs the *current* segment only, tap-to-reveal.
- `page.tsx`: wired the above in; removed the old Saved-tab filter chips and the
  separate Bookmarks tab.

## Phase 2 — Dark/amber theme + Default-layout decomposition (DONE)

Goal: reskin Dictation mode's Default layout to match the mockup's dark/amber theme,
and split page.tsx's monolithic JSX into reusable pieces Phase 3 can also use.

- New: `player-theme.css` — CSS custom properties (`--bg`, `--surface`, `--accent`, …)
  scoped under a `.player-dark-theme` class, so the rest of the app (light theme)
  is unaffected. Applied to the page root; `player-dark-theme` wraps everything
  under `src/app/dictation/[videoId]/`.
- New: `components/layouts/DefaultLayout.tsx` — owns the video block, the practicing
  input/answer area, hint panel, review-previous-sentence card, and the control bar.
  Built this way (props in, JSX out) specifically so Phase 3's Theater/Focus layouts
  can reuse `ControlBar`/`ReviewPreviousSentenceCard` instead of re-deriving them.
- New: `components/ControlBar.tsx` — re-themed control bar; added a Hint toggle button,
  a sentence index counter, a reset-attempt button, and the new subtitle-visibility
  ("Eye") popover trigger. `ComboStreak` moved into it.
- New: `components/ReviewPreviousSentenceCard.tsx` — extracted from inline JSX, re-themed.
- New: `components/SubtitleVisibilityPopup.tsx` + `useSubtitleVisibilityPreference.ts` —
  Original/Translation × Show/Blur/Hide, persisted to localStorage. Wired so "Original"
  controls the letter-shape hint mask overlay in Dictation mode.
- Re-themed in place (dark tokens): page root/header/mobile toolbar, `MobileBottomSheet`,
  `SettingsDrawer`, the whole right panel stack (`RightPanelTabs`, `ScriptTab`, `WordsTab`,
  `SentencesTab`, `LessonSavedItemsList`, `BookmarksList`), `ComboStreak`, `ControlButton`,
  `ComparedSentenceText`, `HintDisplay` (dictation-only, safe to retheme), the
  loading/processing/failed/ready-to-start/session-complete states, and the
  script-selection popover / phrase tooltip / undo toast.

### Known deviations / open items from Phase 2
1. `StatusCard`, `VocabularySaveButton`, `UserButton`, `VocabularyEditForm` were left
   light-styled on purpose — they're shared with `/listening`, `/results`, `/vocabulary`,
   which aren't dark-themed yet. Retheming them would leak the dark style onto those
   pages. Small visual seams: a light card during transcript loading/processing, a
   light inline edit form when editing a saved word, a light avatar button in the header.
2. No browser automation available in this environment — verified via `npm run lint`,
   `npm run build` (typecheck), `npm test`, and an HTTP smoke test of the route.
   Visual/interaction correctness has not been clicked through by Claude.

### Mockup-fidelity pass (after Phase 2, same session)

The user flagged that Dictation Default didn't match the mockup closely enough. Re-extracted
the exact current mockup source (`Dictation.dc.html`) from the saved artifact snapshot and
diffed it against the live code. Fixes made:

- Input row restyled: dropped the heavy `border-2` box for a borderless/transparent look at
  rest (border and background only appear on focus/success/error), matching the mockup's
  transparent input section. The underlying mechanic (freeform `<input>` + optional
  letter-shape mask overlay) was intentionally kept — the mockup's per-word-underline
  visual was read as a static-mockup illustration of "an input exists here," not a spec to
  change dictation from free-typing to single-word fill-in-blank.
- Added the missing inline Vietnamese translation line under the input, gated by the
  Subtitle Visibility popover's "Translation" setting (Show/Blur/Hide) — this control was a
  known gap from Phase 2. `useScriptTranslation` gained a `wantTranslation` param so the
  Default layout can trigger the (single, cached, per-video) translation fetch independently
  of the Script tab's own toggle.
- `ReviewPreviousSentenceCard`: sub-panels now sit side-by-side (`flex`) matching the
  mockup, not stacked; opacity values tightened to the mockup's exact 0.08/0.25;
  `ComparedSentenceText` restyled so the differing word in the "Correct sentence" panel gets
  a green highlight (it's the correct word, not an error) and the wrong word in "Your
  answer" is red + strikethrough (no background pill) — matching the mockup exactly instead
  of the app's earlier red/amber/purple diff-token palette.
- Control bar: dropped the Bookmark button (not in the mockup; bookmark access already
  exists via the header and the Sentences tab) and added a Mode-switch button
  (`ModeSwitcher.tsx` popover — Watch & Listen links to `/listening/[videoId]`, Dictation is
  marked active, Shadowing is shown but disabled/"Coming soon" since it has no real feature
  behind it anywhere in the app). Screenshot was intentionally left out (no clear
  implementation path, user's call).
- Header rebuilt to match the mockup's icon set as real functionality, replacing the old
  "Listening mode" text link (now redundant with the Mode-switch popover): Download
  (exports the transcript as a `.txt` file), Bookmark (toggles the current segment,
  moved out of the control bar), Settings (unchanged), Fullscreen (Fullscreen API toggle),
  Split-view (toggles the existing `showLearningPanel` panel-collapse state). All four new
  icons are desktop-only (`hidden sm:flex`), consistent with the existing Settings icon's
  precedent — mobile keeps its own compact toolbar and wasn't touched.

New in this pass: `components/ModeSwitcher.tsx`.

### Responsive fill pass (after the above, same session)

User reported the layout stayed small with large dead/black areas on bigger monitors
(1920×1080, 2560×1440 screenshots) instead of filling the viewport like the mockup does.
Root causes and fixes:

- `<main>` was capped at `max-w-7xl` (1280px) — raised to `max-w-[1800px]` so the layout
  can actually use wide screens.
- The video's height was capped at a flat `max-h-[320px]` (`sm:` and up) — tuned for
  small laptop screens, way too small on a 1440p/4K monitor. Changed to viewport-relative
  caps (`sm:max-h-[68vh]` default, `sm:max-h-[80vh]` Zen Mode) so it scales with the
  window instead of staying pinned small.
- The left column (`motion.div` wrapping video+DefaultLayout+the status-message card)
  wasn't reliably stretching to the full available height — likely Framer Motion's
  `layout` prop measuring/freezing a content-driven height rather than letting flexbox's
  default stretch apply. Gave it an explicit `lg:h-full` alongside its existing
  `lg:flex-1` so it has a definite height basis regardless.
- Restructured which of the two stacked sections (DefaultLayout vs. the loading/ready/
  session-complete status card) grows to fill that column, keyed off a new `isPracticing`
  flag: while practicing, DefaultLayout grows (`lg:flex-1 lg:min-h-0`) and the status card
  shrinks to content; otherwise it's the reverse (original behavior, unchanged for those
  states). Previously both used a flat `lg:flex-1`, which meant an ALWAYS-empty status
  card was silently claiming (and visibly showing as a blank surface-colored box under)
  all the leftover space during practicing — a real bug, now fixed.
- `DefaultLayout`'s root changed from a `<>` Fragment to `<div className="flex min-h-0
  flex-1 flex-col">`, and the control bar's wrapper changed from `mt-4` to `mt-auto
  pt-4` — mirroring the mockup's own `margin-top:auto` technique, so the control bar
  (and whatever sits directly above it) is pushed flush to the bottom of the now-taller
  column instead of leaving a gap below it, with a 16px minimum via `pt-4` even when
  there's no slack to consume.

### Layout-density pass (after the above, same session)

User sent 2560×1440 and 1920×1080 screenshots plus a 12-point spec asking for a
denser, edge-to-edge desktop layout — `<main>` was still leaving large black
gutters on both sides, and the review card/toolbar had a big gap between them.

- `<main>`'s `max-w-[1800px]` cap (added in the earlier responsive-fill pass)
  was itself the main source of the gutters reported this round — removed
  entirely so the layout is fluid to any viewport width, as requested
  ("fix automatically with any screen size").
- Video sizing itself was left untouched: `w-full aspect-video max-h-[Nvh]`
  already derives height from width (not the other way around), so widening
  `<main>` makes the video wider automatically with no distortion risk —
  confirmed this arithmetic before touching anything, no need for a
  letterbox/flex-1 rebuild.
- `DefaultLayout`: the control bar's wrapper changed from `mt-auto pt-4` (which
  deliberately pushed it to the bottom of the column, from the prior pass) to
  a fixed `mt-3` — now sits directly below the review card as requested,
  instead of leaving a big gap. Other internal gaps tightened from `mt-4` to
  `mt-3`/`mt-2` throughout (progress bar, input row, correction panel, hint
  panel, review card).
- Removed the input row's "Check" button (idle state) and its separate Hint
  (lightbulb) button — submission still works via Enter or auto-advance
  on an exact match; Hint is already reachable from the control bar's center
  cluster, so the input-row copy was redundant. Idle state now shows a
  subtle non-interactive "Press Enter ↵" hint once the user has typed
  something, instead of a clickable Check button.
- Did NOT rebuild the input as a per-word blank/token component (the spec's
  "type + space moves to next word") — the existing free-type `<input>`
  already behaves this way character-by-character (space is just a normal
  character), and Easy mode's word-shape mask overlay already renders
  per-word blanks that fill in as you type. Re-architecting the input into
  discrete per-word fields would be a much larger, riskier change to a
  core interaction; flagged as a follow-up rather than guessed at.
- Control bar's right cluster (streak, subtitle-visibility, volume,
  mode-switch) was left as-is rather than fabricating "remaining attempts" /
  "reveal answer" buttons the spec asked for — neither concept exists
  anywhere in the app's data model (no per-sentence attempt cap, no distinct
  reveal-answer action outside of cycling Hint to its final level), so
  inventing UI for them would be non-functional. Flagged for the user rather
  than guessed at.
- Right panel ("Lesson panel"): removed the redundant "Lesson panel" heading
  row; its collapse button now sits inline with the Script/Words/Sentences
  tabs (`RightPanelTabs` gained an `onCollapse` prop). Reduced padding
  throughout (tab row `p-1`/`mt-3`→`mt-2`, content `p-4`→`p-3`,
  `gap-4`→`gap-3`, script cards `p-4`→`p-2.5`).
- `ScriptTab`: removed the separate "Show/Hide translation" toggle — each
  script entry now always shows its Vietnamese translation (translation data
  was already being fetched independently via `wantTranslation`, so this
  was a display-only gate, not a fetch change); "Regenerate translation" is
  now always visible instead of conditional on that toggle. Added a
  timestamp (`m:ss`, new `formatSegmentTimestamp` helper in `helpers.ts`)
  next to each entry's "Sentence #N" label. Active-segment highlight
  (amber/accent border + soft background) was already in place from Phase 2,
  unchanged.

### Fine-tuning pass (after the above, same session)

User sent an in-practice screenshot with 7 specific fixes after the layout-density
pass above:

- The bottom-of-page status card (`bg-[var(--surface)] ... rounded-3xl p-4`,
  meant for loading/processing/failed/ready/session-complete messages) was
  rendering as an empty rounded box while practicing, since none of its
  conditional blocks matched but the card itself wasn't gated — it only had
  content for the Zen-mode exit button in that state. Now the whole block
  (and its `py-3` outer padding) is skipped unless `!isPracticing ||
  isZenMode`.
- Control bar's wrapper went back to `mt-auto pt-3` (pinned to the bottom of
  `DefaultLayout`'s flex column) per this round's explicit ask to keep it
  "fixed at the bottom" — this reverses the prior pass's `mt-3`, but is safe
  now because the video is also shorter (see below), so the recovered gap is
  small instead of the large dead-space this same mechanism caused two
  passes ago.
- Video max-height reduced: default `sm:max-h-[68vh]` → `sm:max-h-[52vh]`,
  Zen `sm:max-h-[80vh]` → `sm:max-h-[72vh]` — frees enough vertical room
  for the review-previous-sentence card to render fully above the (now
  pinned) control bar instead of being clipped by the column's
  `overflow-hidden`.
- Right column top-alignment: the mobile-only quick-settings row (a
  `motion.div` inside `AnimatePresence`, previously always present in the
  DOM with `sm:hidden` only on its *inner* content) was still consuming a
  `gap-2` slot at desktop widths even though empty, and the left column's
  `pt-2` had no equivalent on the right panel — together a ~16px top offset
  between the video frame and the lesson panel. Fixed by adding `lg:hidden`
  to the row's own wrapper (removing its flex-gap slot at `lg:`, not just
  hiding its content) and `lg:pt-0` on the left column's top-level wrapper.
- Right panel width trimmed `360px` → `320px` to give the left column more
  room (`<main>`'s left side is `flex-1`, so it absorbs the difference).
- `VIDEO_SIZE_MODE_CLASS.standard` changed from a flat `max-w-4xl` (896px)
  to `max-w-[94%]` — with `<main>`'s width cap removed in the prior pass,
  a fixed 896px cap on the video was producing dramatic letterboxing on
  wide monitors (the actual bug behind "video has too much empty black
  space around it"); a percentage cap scales with the frame at any screen
  size instead of clamping to a fixed pixel value. `large` mode (`max-w-none`)
  unchanged.
- Inline Vietnamese translation (below the input) bumped `text-sm` → `text-base`
  for readability, per explicit ask.

### Input-feedback consolidation pass (after the above, same session)

User asked to drop the standalone progress bar and "Correction Needed" block,
move feedback into the input itself, and reclaim the vertical space so the
review card stays visible above the (bottom-pinned) control bar.

- Removed `ProgressBar` from `DefaultLayout` entirely (import + usage) — no
  replacement element left in its place.
- `ControlBar` gained an `accuracy: number` prop; the counter now reads
  `"4 / 66 · Accuracy 47%"` instead of just `"4 / 66"`.
- Removed the "Correction Needed" card (the `AnimatePresence` block that
  showed the expected sentence with wrong words masked as `***`).
- New in-input feedback: after a wrong submission, the input's own text
  turns transparent (like the existing Easy-mode word-shape mask already
  did) and a new overlay renders the **user's own typed words**, colored
  red for anything not `status: "correct"` and the normal text color
  otherwise. Built via the same `buildComparedTokens()` helper the review
  card already uses (its `userTokens` output is exactly "the user's words,
  each tagged correct/wrong/extra" — no new diffing logic needed). The
  overlay reuses the existing `maskOverlayRef` rather than adding a new
  ref/prop, since it's mutually exclusive with the Easy-mode mask
  (`showMask` is now gated off whenever `showErrorDiff` is true).
- Removed the "Try Again" button (the error state's only handler,
  `onDismissCheckResult`, is now redundant since typing already clears
  `checkResult` on every keystroke via the existing `handleWorkspaceInputChange`
  — removed the prop end-to-end: `DefaultLayout`'s signature and the
  `page.tsx` call site).
- Removed the "Press Enter ↵" idle hint added in the prior pass (explicitly
  asked to remove it this round).
- Input box padding tightened `p-6` → `p-4`, reserved right-side space
  `pr-32 sm:pr-28` → `pr-16 sm:pr-14` (no longer needs to fit a Check/Try
  Again button, only the small checking-spinner/success-check indicator) —
  applied identically across the real `<input>` and both overlay divs so
  the three stay pixel-aligned.

### Review-card, centering & control-bar-overflow pass (after the above, same session)

- `ReviewPreviousSentenceCard`: stripped the outer card entirely (background,
  border, rounded frame, "Review previous sentence" title, `#N` badge) —
  now just the two "Correct sentence"/"Your answer" mini-cards in a bare
  `flex gap-2.5` row (same-height via flexbox's default `align-items:
  stretch`, no extra alignment code needed). `reviewTextContainerRef`/
  `handleReviewMouseUp` moved onto that row directly since the wrapper
  they were on is gone — the review card's use of `useLessonCapture`'s
  selection-to-save DOM query pattern still works unchanged.
- Answer input text is now centered: switched the input and both overlays
  (Easy-mode word-shape mask, error-diff overlay) from asymmetric
  `p-4 pr-16 sm:pr-14` to symmetric `px-16 sm:px-14 py-4` + `text-center` —
  symmetric padding is what makes `text-align:center` land on the box's
  true visual center rather than being skewed by the space reserved for
  the checking-spinner/success-check indicator on the right.
- **Found and fixed the actual root cause of icons overflowing the control
  bar**: both `ControlButton` and `ComboStreak` rendered a caption label
  (e.g. "Hint", "Streak") in a `flex-col` layout — always present in the
  DOM, only `opacity-0` (not `display:none`) below the `sm:` hover reveal.
  Since opacity doesn't remove an element from layout, every button's
  column was taller than the control bar's fixed `h-14`, pushing icons
  outside the bar's rounded frame at every viewport width. Fixed by
  taking the label fully out of flow (`absolute top-full`, shown only
  `sm:group-hover:block`) in both components, and switched the bar's own
  height from fixed `h-14` to `min-h-14` as a second safety net. Button
  size trimmed `w-11 h-11` → `w-10 h-10` at the base breakpoint (unchanged
  at `sm:`).
- `ControlBar`'s root changed from `flex justify-between` to CSS grid
  `grid-cols-[1fr_auto_1fr]` with `justify-self-start/center/end` on the
  three clusters — guarantees the center playback/nav cluster stays
  visually centered regardless of how wide the left (counter+accuracy) or
  right (streak/visibility/volume/mode) clusters are, which plain
  `justify-between` doesn't. Left cluster gained `min-w-0 truncate` and an
  abbreviated `sm:hidden` counter format (`"4/66 · 47%"`) vs. the full
  `sm:`+ format (`"4 / 66 · Accuracy 47%"`) so the longer label doesn't
  force overflow on narrow viewports.
- Right lesson panel width changed from a fixed `320px` to
  `clamp(340px,24vw,400px)`; the left column gained `lg:min-w-0` (it only
  had `lg:min-h-0` before) so it can actually shrink to make room instead
  of forcing horizontal overflow now that the panel can grow up to 400px.

## Phase 3 — Watch & Listen mode + Theater/Focus layouts (NOT STARTED)

Goal: bring the remaining 7 mockup artboards to life.

- Build Watch & Listen mode's Default layout (`src/app/listening/[videoId]/`, or a
  shared component if the two modes converge) — same dark theme, plain (non-interactive)
  subtitle line instead of the fill-in-blank input.
- Build Theater layout for both modes — video widens, input/subtitle + translation
  overlay on the video near the bottom, control bar below.
- Build Focus layout for both modes — video shrinks to a floating mini-player, the
  input/subtitle + translation become large and centered.
- Build the Mode Switcher popup (Watch & Listen / Shadowing / Dictation) — note
  "Shadowing" mode doesn't exist in the current app; scope/behavior needs confirming
  with the user before building it.
- Decide and implement Regenerate Script / Regenerate Translation button placement —
  the mockup's proposed answer (a panel-header "⋯" menu, mocked in
  `RegenerateMenu.dc.html`) was never explicitly confirmed by the user.
- Reuse `ControlBar` and `ReviewPreviousSentenceCard` from Phase 2 rather than
  rebuilding them per layout.
