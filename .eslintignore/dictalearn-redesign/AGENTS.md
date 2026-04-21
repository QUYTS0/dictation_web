# Project UI/UX Guidelines: Frosted Glass Design System

You are working on the **DictaLearn** application. This project uses a very specific, highly polished "Frosted Glass" (Light Mode) and "Obsidian Glass" (Dark Mode) design system.

## MANDATORY INSTRUCTIONS FOR NEW COMPONENTS OR UI EDITS:

1. **Read the Design Blueprint**: Before writing any HTML or React components, you MUST read the `SKILL.md` file in the root directory. It contains the exact Tailwind CSS recipes for backgrounds, borders, blurs, typography, and micro-interactions.
2. **Never Use Flat Defaults**: Do not use standard solid colors (e.g., `bg-white` or `bg-slate-900`) for main content cards. You MUST use translucent fractionals (e.g., `bg-white/40`) combined with `backdrop-blur-xl` and defined edges (`border border-white/60`).
3. **Always Support Dark Mode**: Every component must use `dark:` Tailwind variants perfectly transitioning to the "Obsidian Glass" look.
4. **Interactive Tactility**: Every interactive element (buttons, cards, rows) must have a subtle hover animation (e.g., `hover:-translate-y-1 transition-all` or `group-hover` text color changes).
5. **Reference Golden Files**: If you are unsure how to construct a layout, read `src/components/Dashboard.tsx` or `src/components/Vocabulary.tsx` as perfect "Golden Examples" of how to apply this UI system in code.
