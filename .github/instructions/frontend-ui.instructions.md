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
- **Starting a new video** is always one step away, in three places that share one form
  (`src/components/AddVideoForm.tsx`, one `/api/video/resolve` flow):
  1. the header's **New video** button (`AddVideoDialog`, on every signed-in page),
  2. the Dashboard hero's **Start today's practice** button, which opens the link box inside the
     hero,
  3. the **first-run hero**, for a learner with nothing yet (no videos, sessions or words).
  Do not add a separate URL input at the top of the Dashboard; the hero already is that.
- Dashboard order (`src/app/dashboard/page.tsx`). Keep it.
  1. Monday recap banner (first visit of a league week only)
  2. Hero: welcome, streak status, weekly consistency track | Today's target, level bar,
     Start today's practice
  3. Continue learning (resume) | Next up (the Focus decision)
  4. Review deck | League card
  5. Learning performance (3 cards)
  6. Needs attention (error diagnostics) | Achievements
  Each pair is roughly 8/4 columns on large screens. When the right-hand partner is unavailable
  (e.g. its migration isn't applied), the left card takes the row alone.
- Division of work: hero button = start something **new**; Continue card = **resume**;
  Next up = what to **review** next. Never give two of them the same action.

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
- Respect `prefers-reduced-motion`: animations only under `motion-safe` or the existing guarded
  keyframes, and a toast instead of motion where it matters.
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
