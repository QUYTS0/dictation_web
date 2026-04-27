---
name: frosted-glass-ui
description: Advanced UI/UX engineering principles for creating modern, translucent, glassmorphic SaaS interfaces with comprehensive light (Frosted Glass) and dark mode (Obsidian Glass) integration.
---

# Frosted Glass UI / Obsidian Glass UI

This skill document defines the design language, Tailwind CSS patterns, and animation principles required to build fluid, glassmorphic interfaces. This aesthetic pairs vibrant, solid underlays with semi-transparent, frosted panels to create depth, hierarchy, and a highly polished feel.

## 1. The Core Philosophy

*   **Depth through Translucency**: Instead of relying solely on drop shadows, depth is achieved by stacking semi-transparent surfaces with background blur (`backdrop-blur`) over a colorful or gradient background.
*   **Crisp Edges**: Glass panels must always have a subtle, bright border (a "specular highlight") to define edges against the blurred background.
*   **Tactile Feedback**: Every interactive element should respond to user input—usually with a subtle vertical lift (`hover:-translate-y-1`) and scale, backed by smooth transitions.
*   **Dual Identity**: "Frosted Glass" (Light) uses white translucency on light, cool-toned backgrounds. "Obsidian Glass" (Dark) uses dark slate translucency with very faint white borders on deep charcoal/navy backgrounds.

## 2. Color Palette & Typography

### Base Colors
*   **Primary/Accent**: Indigo (`indigo-500`, `indigo-600`). Used for primary actions, active navigation, and progress bars.
*   **Success**: Emerald (`emerald-500`).
*   **Warning/Streak**: Amber/Orange (`amber-500`, `orange-500`).
*   **Text (Light)**: `text-slate-900` (Headings), `text-slate-500` (Body), `text-slate-400` (Muted/Sub-labels).
*   **Text (Dark)**: `text-white` (Headings), `text-slate-300`/`text-slate-400` (Body).

### Typography Strategies
*   **Font Family**: Primary sans-serif (`font-sans`), highly legible (e.g., Inter).
*   **Micro-labels**: Use extreme contrast in size and weight for metadata (e.g., "Total Words", "Mastery").
    *   *Recipe*: `text-[10px] font-black uppercase tracking-[0.2em] text-slate-500`
*   **Headings**: Tight tracking (`tracking-tight`) with heavy weights (`font-bold`, `font-black`).

## 3. Glass Material Recipes (Tailwind)

### Panels & Cards
The foundation of the UI. Mix backgrounds, blurs, borders, and shadows.

**Light Mode (Frosted Glass)**
*   **Background**: `bg-white/40` to `bg-white/60` (depending on desired opacity).
*   **Blur**: `backdrop-blur-md` or `backdrop-blur-xl`.
*   **Border**: `border border-white/60` (critically important for the glass edge effect).
*   **Shadow**: `shadow-lg` or `shadow-xl`.

**Dark Mode (Obsidian Glass)**
*   **Background**: `dark:bg-slate-800/40` or `dark:bg-slate-900/40`.
*   **Border**: `dark:border-white/10` or `dark:border-white/5`.

**Combined Example**:
```html
<div className="bg-white/40 dark:bg-slate-800/40 backdrop-blur-xl border border-white/60 dark:border-white/10 shadow-xl rounded-3xl p-6">
  {/* Content */}
</div>
```

### Inset & Depressed Surfaces
Used for search bars, progress bar tracks, and inner content areas.
*   **Light**: `bg-white/30 border-white/40 shadow-inner` or `bg-slate-200/50`.
*   **Dark**: `dark:bg-slate-900/40 dark:border-white/5 dark:bg-slate-700/50`.

## 4. Component Patterns

### Badges & Tiny Tags
Used for displaying states, types (e.g., "Noun"), or quick stats. Do not use generic solid colors. Over-saturate the text, wash out the background.
*   **Recipe**: `text-xs font-bold text-emerald-600 bg-emerald-100/50 border border-emerald-200/50 px-2 py-0.5 rounded-md`
*   **Dark Mode**: `dark:text-emerald-400 dark:bg-emerald-500/10 dark:border-emerald-500/20`

### Interactive Progress Bars
Progress bars shouldn't just be flat colors; they should glow or have depth.
*   **Track**: `bg-slate-200/50 dark:bg-slate-700 rounded-full overflow-hidden shadow-inner flex`
*   **Fill**: `bg-gradient-to-r from-indigo-400 to-indigo-600 rounded-full dark:shadow-[0_0_8px_rgba(79,70,229,0.4)]`

### Forms & Inputs
Inputs should blend into the glass until focused.
*   **Wrapper**: `relative bg-white/40 dark:bg-slate-900/40 backdrop-blur-xl border border-white/60 dark:border-white/10 rounded-2xl shadow-sm focus-within:ring-2 focus-within:ring-indigo-500/30 transition-all`
*   **Input Element**: `bg-transparent outline-none text-slate-800 dark:text-white placeholder:text-slate-400`

## 5. Animation & Interactions

1.  **Staggered In-App Entrances (`motion/react`)**:
    Always load grids or lists with a slight vertical rise and opacity fade, staggered by index.
    ```jsx
    <motion.div 
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.05 }}
    >
    ```
2.  **Hover States (Lift & Glow)**:
    Cards should lift off the canvas slightly.
    `hover:-translate-y-1 transition-all duration-300`
3.  **Group Hovers**:
    Target inner elements when the parent card is hovered.
    Wrapper: `group`
    Title text: `group-hover:text-indigo-600 transition-colors`
    Play Button inner icon: `group-hover:scale-110 transition-transform`

## 6. Advanced Features: Zen Mode

When implementing "Focus" or "Zen" modes that hide standard UI to highlight specific content:
*   Use standard React state to trigger layout shifts.
*   **Masking**: Hide headers, footers, and sidebars conditionally or animate them out via `AnimatePresence`.
*   **Overlay**: Introduce a subtle, fixed background masking layer (`fixed inset-0 z-0 bg-slate-900/50 backdrop-blur-sm`).
*   **Centering**: Shift main content using Flexbox layout alterations (`justify-center items-center`) combined with scale animations (`scale-105`).

## Golden Rules / Anti-Patterns
*   **DO NOT** use opaque flat white (`bg-white`) or flat dark (`bg-slate-900`) for primary cards. You destroy the glass illusion. Always use fractional opacities (e.g., `/40`).
*   **DO NOT** forget the translucent white/transparent border on glass panels. Without the border, it just looks like a reduced-opacity overlay, not glass.
*   **DO NOT** use default black drop shadows globally. Adjust shadow intensity.
*   **DO NOT** leave text colors unadjusted for dark mode. `text-slate-900` is invisible on a dark frosted background. Always provide a `dark:text-white` or `dark:text-slate-300` counterpart.
