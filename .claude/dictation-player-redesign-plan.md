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
