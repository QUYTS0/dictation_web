---
applyTo: "src/**/*.ts,src/**/*.tsx"
---

# Frontend UI Instructions

This file applies to frontend and UI work in the app. The visual language is the
**DictaLearn Studio (Calm Indigo)** design system. Its tokens, recipes and rules are in
`.github/skills/dictalearn-studio-ui/SKILL.md`. Read that skill before styling anything.
The product plan behind the current Dashboard is `.claude/dashboard-redesign-plan.md`.

## Design direction

- Calm and focused, not flashy: solid white cards on a light page, one deep-navy hero, indigo
  for action, teal (`success`) and amber (`reward`) as sparing signals.
- Strong hierarchy: one primary action per area, quiet supporting text.
- Desktop-first and responsive. Every layout must work on a phone.
- Use the design tokens (`bg-page`, `bg-surface`, `border-line`, `text-ink`, `text-muted`,
  `bg-hero`, `text-success`, `text-reward`, `text-danger`, `primary-*`), not raw slate/indigo or
  hex colors. Do **not** reintroduce the old frosted-glass style (`bg-white/40 backdrop-blur-xl
  border-white/60`, blurred background blobs).

## Signed-in information architecture

- `/dashboard` is the signed-in home. Primary destinations sit in the header nav:
  Dashboard, My Learning, Vocabulary, Bookmarks, History, Leaderboard.
- **Starting a new video** is always one step away, and every way in shares one form
  (`src/components/AddVideoForm.tsx`, one `/api/video/resolve` flow):
  1. the app's ONE **New video** dialog (`NewVideoDialogProvider` in `Providers.tsx`, opened with
     `useNewVideoDialog().open`; it keeps a half-typed link). The header's **New video** button
     opens it on every signed-in page, and so do the Dashboard hero's **Start a new video** (a
     quiet link while today's tasks are left, the amber button once nothing is) and the Today
     list's "N min to today's goal" when nothing is unfinished;
  2. the **first-run hero**, for a learner with nothing yet (no videos, sessions or words), with
     the field inline.
  Do not add another URL input or a second dialog; open the shared one.
- Dashboard order (`src/app/dashboard/page.tsx`). Keep it.
  1. Monday recap banner (first visit of a league week only)
  2. Hero: welcome, streak status, weekly consistency track, level bar | **Today list** (practice
     time toward the goal, then what is left today — minutes to the goal, sentences, words — then
     "All done for today ✓"), Start a new video
  3. Continue learning (resume + its sentences to look at again), and below it
  4. the Review deck, both 8 columns, with the League card running beside both (4 columns, two
     rows; it takes their height and lists as many whole rows as fit). With no Continue card it
     sits beside the deck only, as a plain card.
  5. Learning performance (3 cards)
  6. Needs attention (error diagnostics) | Achievements
  Each pair is roughly 8/4 columns on large screens, and the cards share the row's height.
  When the right-hand partner is unavailable (e.g. its migration isn't applied), the left card
  takes the row alone. Continue, League and the deck are one grid whose slots never move in the
  page, so a layout change never rebuilds a card. On a phone: Continue, League, deck.
- **Each task has one home.** Never show the same action in two cards:
  - start something new: the hero button;
  - resume a video and see its sentences to look at again ("Review sentences"): the Continue
    card;
  - review words ("Start review"): the review deck.
  The hero's Today list only says what's left today, and each row jumps to (and focuses) the
  card that owns the task. **One amber action at a time:** the first open Today row while
  something is left; "Start a new video" only once nothing is. There is no "Next up" card: it was removed because it always repeated
  one of these cards.

## Data honesty (non-negotiable)

- Metrics are canonical and separate: never blend, recompute or "improve" them in the UI
  (active time, sentence accuracy, pronunciation, video counts). Missing data is "—", never 0.
- If a read fails or returns 503 `learning_data_unavailable`, hide that part, or show a short
  "not available" line. Never show fake zeros.
- XP is the game layer only. It never appears inside Learning performance, and the daily goal
  earns none.
- Descriptive copy only for diagnostics: no praise, rankings or advice ("better", "worse",
  "should", "try", "because", "AI").
- Vocabulary copy never promises a review order or batch size; review links read exactly
  "Start review".
- Boards show names, initials, XP, streaks and kudos only: never an email, user id or photo.

## Navigation behavior

- Do not hide primary destinations inside the avatar dropdown.
- Every primary destination is reachable at every width. Below `lg` the header tabs get their
  own row (scrolling sideways on a phone); never hide the nav on small screens.
- The avatar dropdown holds account items only: email, **Profile & preferences**, Sign out.
- Avoid two top-level screens doing the same job.

## Component guidance

- Reuse before creating:
  - `ModalDialog` for every modal (focus trap, Escape, focus return)
  - `useToast()` for toasts
  - `ConfettiBurst` for celebrations (it renders nothing under reduced motion)
  - `AddVideoForm` for adding a video
  - `PAGE_WIDTH_CLASS` / `PAGE_PADDING_CLASS` for page width
- Shared Dashboard pieces live in `src/app/dashboard/components/`; league pieces in
  `src/components/league/`.
- Pure logic (week math, levels, celebrations, catalog copy) lives in `src/lib/**` and is
  unit-tested; components stay thin.
- Server rules (thresholds, XP, leagues) live in the database. TypeScript holds presentation
  only (names, icons, copy).
- Meaningful empty states: "No recent sessions yet", "No saved vocabulary yet", "Practice
  anything this week to join this week's Bronze league."

## Accessibility

- Every interactive element is a real `<button>` or `<a>`, with an accessible name that carries
  the information (e.g. "Mon, Nov 23: practiced, 22 min, +140 XP").
- Popovers open on hover, focus and tap. Escape closes them, and so does a tap outside.
- Respect `prefers-reduced-motion`: use the guarded motion classes in `globals.css` or
  `playOnce` (`src/lib/motion.ts`), and a toast instead of motion where it matters. Motion only
  on a change, never an endless loop (design skill §6).
- Text on `bg-hero` uses `text-white` / `text-slate-200`–`300`, never `text-muted`.

## Copy style

- Short and practical, for English learners. Sentence case for UI text; uppercase only for
  micro-labels.
- Times and dates in the viewer's locale and timezone (league reset: "Resets Mon 07:00").

## When refactoring

- Keep business logic intact; improve layout and flow before adding features.
- Keep the data-honesty rules above. Existing tests encode many of them; update a test only
  when the plan deliberately changes the behavior.
- After changes run `npm run lint`, `npm run build`, `npm test`.
