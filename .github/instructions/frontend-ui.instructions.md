---
applyTo: "src/**/*.ts,src/**/*.tsx"
---

# Frontend UI Instructions

This file applies to frontend and UI work in the app.

## Design direction
The product should feel like a polished modern AI app:
- clean and calm layout
- strong visual hierarchy
- soft shadows
- large rounded cards
- roomy spacing
- clear primary CTA
- desktop-first, but responsive
- more like a premium workspace than a plain admin dashboard

## Information architecture
For authenticated users:
- the default page should be the main dashboard/workspace
- the main dashboard/workspace must include a prominent YouTube URL input at the top
- the Start Dictation action must be obvious and easy to reach
- dashboard information should live below the input area, not on a disconnected page

Preferred signed-in structure:
1. hero/workspace section with YouTube URL input + CTA
2. progress summary cards
3. quick resume / recent session
4. recent mistakes
5. recent vocabulary
6. optional achievements or trends if data exists

## Navigation behavior
- Do not hide Dashboard inside the avatar dropdown
- The avatar dropdown should contain account-related items only
- Primary destinations must be visible in the main layout or directly reachable by route
- Avoid duplicate concepts like "Home" and "Dashboard" for signed-in users unless they have clearly different jobs

## Component guidance
- Reuse existing card, button, input, and layout primitives where possible
- Prefer extracting reusable sections instead of repeating large JSX blocks
- Keep section components focused and easy to scan
- Use meaningful empty states such as:
  - No recent sessions yet
  - No mistakes logged yet
  - No saved vocabulary yet

## Copy style
- Keep copy short and practical
- Avoid overly generic dashboard text
- Focus on what helps the user act now and understand progress
- Use labels that are clear for English learners

## Visual priorities
- The YouTube URL input is the primary action
- Progress is secondary but always visible
- Recent activity should be easier to scan than decorative UI
- Do not overload the page with too many equal-weight cards

## When refactoring
If the current UX splits one workflow across multiple weak pages:
- prefer merging them into one stronger signed-in workspace
- keep business logic intact
- improve layout and flow before adding new features