# Copilot Repository Instructions

This repository is a dictation web app built with Next.js, TypeScript, and Supabase.

## Project goals
- Help users practice English dictation from YouTube videos
- Provide a polished signed-in experience with a clear main workspace
- Track user progress, vocabulary, mistakes, and recent activity
- Keep the experience simple, modern, and production-oriented

## Engineering rules
- Preserve existing auth logic unless the task explicitly requires route changes
- Do not break Supabase environment variable usage
- Do not introduce unnecessary schema or API changes
- Reuse existing components before creating new ones
- Prefer small, focused components over large monolithic pages
- Keep code readable, modular, and strongly typed
- Avoid duplicated pages that serve nearly the same purpose
- Prefer improving information architecture before adding more UI complexity

## UI/UX rules
- For authenticated users, the main experience should feel like a polished AI SaaS workspace
- Primary actions must be visible without opening secondary menus
- Do not hide core navigation such as Dashboard inside the avatar dropdown
- The signed-in default page should clearly show:
  1. what the user can do now
  2. how the user is progressing
- Empty states should be clean, useful, and concise
- Prefer strong visual hierarchy, generous spacing, rounded cards, and clear CTAs

## Signed-in experience rules
- After sign-in, users should land on the main signed-in workspace by default
- The signed-in workspace should prominently include:
  - a YouTube URL input
  - a Start Dictation CTA
  - progress summary cards
  - quick resume or recent activity
  - recent mistakes
  - recent vocabulary
- Avoid splitting the signed-in experience into two weak pages if one stronger workspace page is better

## Navigation rules
- Avatar dropdown should contain account-related actions only
- Sign out belongs in the avatar dropdown
- Dashboard should be visible as part of the main signed-in layout or routing, not hidden as a secondary option
- Avoid having multiple top-level screens with overlapping purposes unless their roles are clearly distinct

## Code change workflow
When asked to make non-trivial changes:
1. Inspect current routes, auth flow, layout, and relevant components first
2. Summarize the current behavior
3. Propose an implementation plan
4. Implement with minimal breakage
5. Summarize changed files and behavior at the end

## Quality checks
After meaningful code changes, run or prepare for:
- npm run lint
- npm run build
- npm test -- --runInBand

If something cannot be verified locally, state that clearly.