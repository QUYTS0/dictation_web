---
name: dictalearn-studio-ui
description: The DictaLearn Studio (Calm Indigo) design system for this app — Tailwind tokens, fonts, surface and component recipes, motion and accessibility rules. Use it before creating or restyling any page, card, dialog or control. It replaces the old frosted-glass style.
---

# DictaLearn Studio UI (Calm Indigo)

The app's visual language since the dashboard redesign (`.claude/dashboard-redesign-plan.md`,
decision D4). All tokens live in `src/app/globals.css` (`@theme`). The Dashboard
(`src/app/dashboard/**`) and the shell (`src/components/AppHeader.tsx`, `AppFooter.tsx`) are the
reference implementation: copy from them.

## 1. Philosophy

- **Calm, solid surfaces.** White cards with a thin `line` border and a barely-there shadow, on
  a light `page` background. Depth comes from hierarchy and spacing, not blur.
- **One dark moment.** The navy hero (Dashboard) is the only dark surface on a page.
- **Indigo means action.** `primary-*` for primary buttons, active nav and focus.
  `success` (teal) = done or met; `reward` (amber) = streak, XP, "today"; `danger` = errors and
  demotion. Use the signals sparingly.
- **Numbers in mono.** Counts, XP, minutes and scores use `font-mono tabular-nums`.

## 2. Tokens

| Token | Hex | Use |
| --- | --- | --- |
| `page` | #F6F7FB | Page background (`bg-page`, set on `<body>`) |
| `surface` | #F1F3FA | Secondary surfaces: insets, hovers, tab tracks, empty states |
| `line` | #DDE3EF | Borders, dividers, progress tracks |
| `ink` | #172033 | Primary text and headings |
| `muted` | #6F7891 | Secondary text, labels, captions (on light surfaces only) |
| `hero` / `hero-2` | #151B35 / #25285C | The navy hero, modal backdrop tint, dark chips |
| `success` | #2FAE9B | Done, met, promotion zone |
| `reward` | #EFB044 | Streak flame, today, the hero CTA |
| `danger` | #DC6B70 | Errors, destructive actions, demotion zone |
| `primary-50…900` | #EEF0FF … #5B5CE2 (600) … #2C2E78 | Brand indigo; `primary-600` is the default action color |

Rules: use the token classes (`text-ink`, `border-line`, `bg-surface` …). Don't use raw hex,
`slate-*` or `indigo-*` on light surfaces. On the navy hero, text is `text-white`,
`text-slate-200`–`text-slate-400` (light slate is the documented exception there).

## 3. Typography

- `font-sans` = Plus Jakarta Sans and `font-mono` = JetBrains Mono, both self-hosted via
  `next/font` in `src/app/layout.tsx` with the `vietnamese` subset (learner text is often
  Vietnamese).
- Page title: `text-2xl font-extrabold tracking-tight text-ink` (hero: `sm:text-3xl text-white`).
- Section micro-label: `text-xs font-bold uppercase tracking-wider text-ink`, usually with a 16px
  lucide icon in `text-primary-600`.
- Body: `text-sm text-ink`; supporting: `text-xs leading-relaxed text-muted`.
- Big metric: `font-mono text-3xl font-bold tracking-tight tabular-nums text-ink`.

## 4. Surface recipes

```tsx
// Card (the default container)
<section className="rounded-2xl border border-line bg-white p-5 shadow-xs">…</section>

// Inset / secondary block inside a card
<div className="rounded-xl bg-surface p-3">…</div>

// Loading placeholder (same footprint as the card it replaces)
<div aria-busy="true" aria-label="Loading …" className="min-h-[180px] animate-pulse rounded-2xl border border-line bg-white" />

// The navy hero — use the shared style, don't re-invent the gradient
import { HERO_SURFACE_STYLE } from "@/app/dashboard/components/DashboardHero";
<section className="relative overflow-hidden rounded-2xl p-6 text-white shadow-md md:p-8" style={HERO_SURFACE_STYLE}>
  <div className="rounded-xl border border-white/10 bg-white/[0.04] p-5">…</div> {/* inner panel */}
</section>
```

- **Sticky header** is the one translucent surface: `bg-white/95 backdrop-blur-md border-b border-line`.
- **Modals**: always `ModalDialog` (`src/components/ModalDialog.tsx`), which handles the backdrop
  (`bg-hero/60 backdrop-blur-sm`), the focus trap, Escape and focus return. Panel:
  `rounded-3xl border border-line bg-white p-6 shadow-2xl`.
- **Popovers**: `rounded-lg border border-line bg-white px-3 py-2 text-xs text-ink shadow-lg`
  (on the hero, the dark popover in `StreakPill`).
- **Page width**: `PAGE_WIDTH_CLASS.wide` + `PAGE_PADDING_CLASS.wide` (`src/lib/layout/pageWidth`).
- **Two-column rows**: `grid grid-cols-1 items-stretch gap-4 sm:gap-5 lg:grid-cols-12` with
  `lg:col-span-8` / `lg:col-span-4`, and `h-full` on both cards, so a row's cards share one height
  (no hole under the shorter one). Inside a stretched card, put the main action at the bottom
  with `mt-auto` or let the main content grow (`flex-1`). Keep `grid-cols-1`: without it the single
  phone column grows to its widest content and the whole page scrolls sideways. A card whose
  width varies uses container queries (`@container`, `@3xl:`).
- **Header** (`AppHeader`): below `lg` the nav tabs get their own full-width row under the brand
  (scrolling sideways on a phone); from `lg` they sit inline. Anything added to the header's
  right-hand group must still fit at 1024px and 1280px; check with the browser, not by eye.

## 5. Component recipes

| Component | Classes |
| --- | --- |
| Primary button | `rounded-xl bg-primary-600 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-50` |
| Secondary button | `rounded-lg border border-line bg-primary-50 px-3 py-1.5 text-xs font-semibold text-primary-600 hover:bg-primary-100` |
| Quiet button / link | `text-xs font-semibold text-primary-600 hover:text-primary-700` |
| Hero CTA (amber) | `rounded-lg border border-reward/40 bg-reward px-3 py-2.5 text-sm font-semibold text-hero` |
| Icon button | `rounded-lg p-1.5 text-muted hover:bg-surface hover:text-ink` + `aria-label` |
| Input | `rounded-lg border border-line px-3 py-2 text-sm text-ink placeholder:text-muted focus:border-primary-500 focus:ring-2 focus:ring-primary-500/30` |
| Progress bar | track `h-1.5 w-full overflow-hidden rounded-full bg-line`, fill `animate-progress-fill h-full rounded-full bg-primary-600` (`bg-success` when met) with an inline `width`; mark the bar `aria-hidden` and give the number as text |
| Segmented tabs | track `flex gap-1 rounded-lg bg-surface p-1 text-xs font-semibold`; tab `role="tab"`, selected `bg-white text-ink shadow-xs` |
| Status chip | `rounded-full px-2 py-0.5 text-[11px] font-semibold` + a tinted pair (`bg-success/10 text-success`, `bg-primary-50 text-primary-700`, `bg-surface text-muted`) |
| Ranked row | `flex items-center gap-2.5 rounded-xl border px-2.5 py-2`; the viewer's row `border-primary-500/40 bg-primary-50` |
| Toast | `useToast()` (`src/components/ToastProvider.tsx`); `tone: "error"` for failures |

## 6. Motion

Motion confirms that something just changed or appeared. It is never decoration.

- **Rules:** animate only on a change or when something first appears. Taps and toggles take
  150–400 ms; fills and counters up to 700 ms. Use an ease-out. **Nothing loops forever.** Under
  `prefers-reduced-motion`, nothing moves (values still update).
- **On appear** (CSS classes in `globals.css`, inside `prefers-reduced-motion: no-preference`):
  `animate-progress-fill` (bars with an inline `width`: fill from empty, slide on change),
  `animate-bar-grow` (vertical chart bars), `animate-ring-fill` (the goal ring's arc),
  `animate-card-turn` (a flashcard face turning in after a flip), `animate-xp-gain` (the
  "+N XP" float; hidden under reduced motion). Add new ones the same way.
- **On change, from code:** `playOnce(el, keyframes, options)` from `src/lib/motion.ts` (Web
  Animations API) with `POP_IN` or `BUMP`. It does nothing under reduced motion or in jsdom.
  Examples: the goal ring's check when the goal is met, the header flame when the streak grows,
  the kudos heart.
- **Numbers:** `useCountUp(value)` (`src/hooks/useCountUp.ts`) counts to each new value. The first
  value shows as is. Keep the real value in the accessible name.
- Play "it happened" moments only when they happen while the page is open, or the first time
  they're seen (remember that per user in `localStorage`, like `dictalearn:streak-seen:<user>`).
  Never replay them on every visit.
- Hover on cards changes the border (`hover:border-primary-500/40`), not a big lift. Color
  changes use `transition-colors`.
- Celebrations use `ConfettiBurst`, which renders nothing under reduced motion. Always pair it
  with a toast so nothing is lost.

## 7. Accessibility

- Real `<button>` / `<a>` elements with accessible names that carry the information; icons are
  `aria-hidden`.
- Popovers and disclosures: `aria-expanded` / `aria-controls`; open on hover, focus and tap;
  Escape and a tap outside close them. A phone tap fires `mouseenter` and then `click`, so hover
  must open a *temporary* state and click must *pin* it (see `StreakPill`, `WeeklyTrack`); a
  plain click toggle closes what the tap just opened.
- Touch screens: hide keyboard-only hints with `pointer-coarse:hidden` (and say "Tap" there).
  Every page must work from 320px wide with no sideways scrolling.
- Lists of ranked items are `<ol>`; tabs use `role="tablist"` / `tab` / `tabpanel`.
- Contrast: `text-muted` only on `white` / `surface` / `page`. On `hero`, use white or light slate.

## Anti-patterns (don't)

- Frosted glass: `bg-white/40`, `border-white/60`, `backdrop-blur-xl` cards, blurred
  background blobs. Phase 8 removed it from the Dashboard, My Learning, Vocabulary, Bookmarks
  and History. It still remains in the signed-out landing page (`src/app/page.tsx`), the
  results page (`src/app/results/[sessionId]/page.tsx`), `src/components/report/AiAssessmentSection.tsx`
  and `src/components/StatusCard.tsx`. Move those to the card recipe when you next touch them;
  don't copy from them.
- Raw colors on light surfaces: `text-slate-500`, `bg-indigo-50`, `#f4f7ff`. Use the tokens.
- `dark:` variants. There is no dark theme yet; don't half-build one.
- Staggered entrance animations on lists, or `hover:-translate-y-1` lifts on dense grids.
- Endless decorative loops (glows, breathing, flickering). The old "today" ember and header-flame
  flicker were removed for this reason. `animate-pulse` is for loading placeholders only.
- Fake data: zeros for unavailable metrics, XP in Learning performance, praise or advice in
  diagnostics copy.
