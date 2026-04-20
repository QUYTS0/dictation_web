---
name: Gemini-like Dashboard Redesign
description: Use this skill when redesigning the signed-in dashboard/workspace, improving navigation, or making the app feel more like a polished modern AI product.
---

# Gemini-like Dashboard Redesign

Use this skill when the task involves:
- redesigning the signed-in homepage
- improving dashboard information architecture
- moving the main CTA to a more visible position
- removing primary navigation from the avatar dropdown
- merging a weak signed-in landing page and a weak dashboard into one stronger workspace
- making the UI feel more polished, modern, and AI-product-like

## Goal
Create a signed-in experience that immediately answers:
1. What can the user do right now?
2. How is the user progressing?

## Desired signed-in layout
For authenticated users, the default page should act as the main workspace.

Recommended structure:
1. Top hero/workspace area
   - YouTube URL input
   - Start Dictation button
   - short supporting text if useful
2. Progress summary row
   - completed videos
   - average accuracy
   - practice time
   - vocabulary count
3. Quick resume / recent session section
4. Recent mistakes section
5. Recent vocabulary section
6. Optional achievements or charts if real data exists

## Navigation rules
- Do not put Dashboard inside the avatar dropdown
- The avatar dropdown should contain account-related actions only
- Primary product destinations should be visible in the main layout or by default routing
- Avoid having a signed-in "home" page and a separate "dashboard" page if both serve the same purpose

## Visual style
Aim for:
- clean SaaS look
- soft elevation
- rounded cards
- generous spacing
- one obvious primary CTA
- minimal but warm product feel
- concise empty states
- premium rather than plain

## Refactor strategy
Before editing:
1. inspect current route flow
2. inspect auth redirect behavior
3. inspect navbar/header/avatar menu
4. inspect landing page and dashboard page
5. identify overlap and duplication

Then:
1. make the signed-in default route point to the main workspace
2. move the YouTube URL input to the top of the workspace
3. keep progress and recent data below
4. remove Dashboard from the avatar menu
5. simplify copy and strengthen hierarchy

## Deliverables
When using this skill, provide:
- current UX diagnosis
- implementation plan
- changed files
- summary of route changes
- summary of UI changes
- any follow-up cleanup suggestions