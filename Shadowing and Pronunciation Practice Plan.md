# Shadowing Mode — Implementation Plan (Revised)

> **Revision note.** The original plan (this file's earlier version) designed two separate practice modes — Shadowing and Pronunciation Practice — each with its own panel, three-column recording UI, and eventual Supabase-backed saved-attempt library. Product direction has changed: **Pronunciation Practice is merged into Shadowing** as an optional in-mode action, the three-column recording stage is being removed in favor of reusing Listening Mode's layout, and **permanent audio storage is out of scope entirely**. This revision supersedes the earlier version section-by-section; the file keeps its original name for continuity with existing links/discussion.

## 1. Current implementation status

Phase 1 (mode architecture) and Phase 2 (local recording prototype) from the original plan are built. An additional, unplanned pass then reworked the Shadowing/Pronunciation transcript-stage into a three-column desktop layout — this is exactly the layout being replaced by this revision, not a foundation to build further on.

**What exists in the repo today, and what this revision does with each piece:**

| File | Current state | Disposition |
|---|---|---|
| [types.ts](src/app/dictation/[videoId]/types.ts) | `InputMode = "dictation" \| "listening" \| "shadowing" \| "pronunciation"` | **Change**: drop `"pronunciation"` → `"dictation" \| "listening" \| "shadowing"` |
| [useInputModePreference.ts](src/app/dictation/[videoId]/useInputModePreference.ts) | Parses `?mode=` and a per-video localStorage key into 4 modes | **Change**: 3-way parse + migrate stored/URL `"pronunciation"` → `"shadowing"` (see §3.3) |
| [ModeSwitcher.tsx](src/app/dictation/[videoId]/components/ModeSwitcher.tsx) | 4 options (Listening, Shadowing, Pronunciation Practice, Dictation), each with its own SVG icon; Shadowing's current icon is mic-shaped | **Change**: remove the Pronunciation Practice option; give Shadowing a new non-mic icon (§4); update its description to cover both listening-and-imitating and recording |
| [ControlBar.tsx](src/app/dictation/[videoId]/components/ControlBar.tsx) | `isSpeakingMode = inputMode === "shadowing" \|\| inputMode === "pronunciation"` drives one center Record/Stop button; mode-switch trigger always shows a static `LayoutGrid` icon | **Change**: `isSpeakingMode` collapses to `inputMode === "shadowing"`; center button becomes two adjacent buttons (Record/Stop, Play/Pause My Recording — §5); mode-switch trigger icon becomes per-mode (§4) |
| [DefaultLayout.tsx](src/app/dictation/[videoId]/components/layouts/DefaultLayout.tsx) | Has a fully separate early-return render branch for `isSpeakingMode` (shadowing/pronunciation) using a 3-row desktop CSS Grid (`minmax(280px,1fr)_minmax(180px,220px)_84px`) that swaps the transcript stage for `<ShadowingPanel>`/`<PronunciationPanel>` | **Remove entirely.** Shadowing falls through the *same* return path Dictation/Listening already use — see §6 |
| [SpeakingPracticeStage.tsx](src/app/dictation/[videoId]/components/SpeakingPracticeStage.tsx) | Shared 3-column workspace (reference audio / recording status / your recording) + reserved translation strip, with disabled placeholder "Save"/"Evaluate" buttons | **Delete.** Superseded by control-bar actions (§5) + a right-panel Evaluation tab (§10) |
| [ShadowingPanel.tsx](src/app/dictation/[videoId]/components/ShadowingPanel.tsx) | Thin wrapper around `SpeakingPracticeStage` | **Delete** (with `SpeakingPracticeStage`) |
| [PronunciationPanel.tsx](src/app/dictation/[videoId]/components/PronunciationPanel.tsx) | Thin wrapper around `SpeakingPracticeStage` | **Delete** — Pronunciation Practice no longer exists as a mode |
| [useAudioRecorder.ts](src/hooks/useAudioRecorder.ts) | `MediaRecorder` lifecycle hook — permission request, MIME fallback, level meter, wall-clock duration, Blob-only result, never touches the network | **Keep as-is.** Already exactly the "in-memory Blob only" model §6/§7 require; no upload path was ever built against it |
| [AudioLevelMeter.tsx](src/components/AudioLevelMeter.tsx) | Bar-style level meter component | **Keep**, but repurpose for an in-button miniature meter (§5) instead of a stage-level display |
| [CompactAudioPlayer.tsx](src/components/CompactAudioPlayer.tsx) | Full compact player (play/pause, seek, time, mute) built for the 3-column stage | **Replace its call site.** Extract just its Play/Pause + `ended`-handling logic into a small headless hook (§5.3); the visible seek bar/time UI it currently provides is no longer needed since there is no dedicated playback surface in the new design |
| Supabase (migrations, storage) | No `practice_attempts` table and no Storage bucket were ever created — Phase 5 of the original plan was never implemented | **Nothing to remove in the database.** The removal in §6 below is a *plan* correction (delete the design), not a rollback of shipped schema |
| `useKeyboardShortcuts.ts`, `constants.ts`, `page.tsx` | Reference `"pronunciation"` only via the generic `inputMode !== "dictation"` checks already generalized in Phase 1 | **No change needed** — these already treat every non-dictation mode uniformly and don't hardcode `"pronunciation"` anywhere |

This table *is* the migration map: every row with "Change"/"Remove"/"Delete" is a concrete Phase 3 task (§12).

## 2. Product decision: one mode, Shadowing

```ts
type InputMode =
  | "dictation"
  | "listening"
  | "shadowing";
```

Shadowing now covers the full spectrum of speaking practice:
- **Listen and imitate** — play the original sentence (reusing the existing Replay control — see §5), listen, repeat it back.
- **Record and review** — record the attempt, play it back, compare informally by ear.
- **Optionally evaluate** — when an evaluation engine is available, send the current recording for structured feedback. Evaluation is one action inside Shadowing, never a mode of its own, never required, never automatic.

This removes an entire parallel UI (a second panel, a second set of control-bar buttons, a second roadmap) for a distinction — "imitate the speaker" vs. "read the sentence alone" — that in practice is just *whether the learner chooses to listen to the original again before recording*. Both are already just "press Replay, then press Record" in either case.

## 3. Mode architecture

### 3.1 Types and control-bar branching
- `InputMode` drops to 3 values (§2).
- [ControlBar.tsx](src/app/dictation/[videoId]/components/ControlBar.tsx)'s `isSpeakingMode` becomes `inputMode === "shadowing"` (no more `||`). Every other mode-branch already in the file (`isDictationMode`, the `!isDictationMode` Play/Pause-vs-Hint split, `INPUT_MODE_LABELS`) needs no structural change beyond dropping the `pronunciation` entry from `INPUT_MODE_LABELS` in [constants.ts](src/app/dictation/[videoId]/constants.ts).
- [DefaultLayout.tsx](src/app/dictation/[videoId]/components/layouts/DefaultLayout.tsx)'s `isSpeakingMode` local variable becomes unnecessary — see §6, Shadowing no longer branches away from the Dictation/Listening return path at all.

### 3.2 Mode switcher
- [ModeSwitcher.tsx](src/app/dictation/[videoId]/components/ModeSwitcher.tsx) drops its Pronunciation Practice `<ModeOption>` entirely, leaving three options: Listening Mode, Shadowing, Dictation.
- Shadowing's description updates to something like *"Listen, repeat it back, and record yourself"* — one line covering both halves of §2.
- Shadowing's icon changes from its current mic-shaped SVG to the waveform/echo icon chosen in §4 (a microphone icon here would be misread as "this mode is about recording only," and collides visually with the mic icon the Record button itself now uses).

### 3.3 URL parameters and stored preferences — migration requirement

```ts
// Any link or stored value from before this revision may still say
// "pronunciation" — treat it as "shadowing" rather than silently
// falling back to "dictation" (today's behavior for any unrecognized value).
const LEGACY_MODE_ALIASES: Record<string, InputMode> = { pronunciation: "shadowing" };

function parseInputMode(value: string | null): InputMode {
  if (!value) return "dictation";
  if (value in LEGACY_MODE_ALIASES) return LEGACY_MODE_ALIASES[value];
  return (NON_DEFAULT_MODES as readonly string[]).includes(value) ? (value as InputMode) : "dictation";
}
```

Requirements this must satisfy:
- **`?mode=pronunciation` links** (bookmarks, shared links, anything cached before this revision) resolve to Shadowing on load. `setInputMode`'s existing `router.replace(...)` call — already invoked whenever the mode is set — naturally rewrites the URL to `?mode=shadowing` the next time the mode changes; a one-time `router.replace` on initial mount when the *raw* param was `"pronunciation"` cleans up the URL immediately rather than waiting for the next manual mode switch, so a reloaded/re-shared link doesn't keep propagating the stale value.
- **Stored localStorage values** of `"pronunciation"` get the same alias treatment. Nothing needs to actively *rewrite* the stored string (the next `setInputMode` call overwrites it with `"shadowing"` anyway); the alias in `parseInputMode` is sufficient so old values never regress a visitor to the "dictation" fallback.
- **No session disruption.** This migration lives entirely in `useInputModePreference` — it never touches `useDictationSession`'s `currentSegIdx`, `uxState`, or `sessionStorage` snapshot. A learner mid-video with a stale `pronunciation` link keeps their exact video, sentence, and playback position; only which mode's UI renders changes.

### 3.4 Dashboard entry points
Checked directly: no dashboard, homepage, or history page in this codebase currently links to `/dictation/[videoId]?mode=pronunciation` or references a mode value at all — mode selection happens exclusively inside the practice page's own `ModeSwitcher`/`SettingsDrawer`. There is nothing to migrate here today. If a future dashboard feature (e.g., "resume where you left off" deep links) starts encoding `?mode=` values, it must route through the same `parseInputMode` alias table rather than duplicating mode logic.

### 3.5 Settings
[SettingsDrawer.tsx](src/app/dictation/[videoId]/components/SettingsDrawer.tsx) renders `<ModeSwitcher>` directly and has no mode-specific logic of its own — the §3.2 change is sufficient; no separate settings-drawer edit is needed.

## 4. Mode icon behavior

Every mode gets one fixed, distinct icon, shown in two places that must always agree: the `ModeSwitcher` popover row, and the control bar's mode-switch trigger button (which today shows a static `LayoutGrid` regardless of mode — this is the actual defect §4 of the request is about).

| Mode | Icon (lucide-react) | Rationale |
|---|---|---|
| Dictation | `Keyboard` | Typing is the mode's defining action |
| Listening | `Headphones` | Matches the existing `ModeSwitcher` icon already in use |
| Shadowing | `AudioLines` (fallback `Waves` if unavailable in the installed lucide-react version — confirm at implementation time) | A waveform/echo mark, distinct from the Record button's own mic icon |

Control-bar trigger changes:
```tsx
const MODE_ICONS: Record<InputMode, LucideIcon> = {
  dictation: Keyboard,
  listening: Headphones,
  shadowing: AudioLines,
};
const ModeIcon = MODE_ICONS[inputMode];
...
<ControlButton
  icon={<ModeIcon size={18} />}
  shortcut={`Switch mode — currently ${INPUT_MODE_LABELS[inputMode]}`}
  label={INPUT_MODE_LABELS[inputMode]}
  active
  onClick={...}
/>
```
`ControlButton` already renders `title`/`aria-label` from `shortcut`/`label` and has a fixed `w-10 h-10 sm:w-12 sm:h-12` footprint regardless of icon content — swapping only the `icon`/`shortcut`/`label` values changes nothing about the button's size or position, satisfying "keep the button in the same position and size" and "mode changes must not resize or shift the control bar" without any layout-level change at all.

## 5. Shadowing's control-bar actions

Two adjacent buttons appear in `ControlBar`'s center button cluster (the same `justify-self-center` flex group that already holds Prev/Replay/[mode button]/Next) **only when `inputMode === "shadowing"`**, replacing the single Hint/Play-Pause slot other modes use:

1. **Record/Stop**
2. **Play/Pause My Recording**

No separate "Hear it" button is added — **Replay already plays the original sentence** in every mode (it calls the same `playSegment(currentSegIdx)` Dictation and Listening already use) and continues to do exactly that in Shadowing.

### 5.1 Record/Stop button states
Driven by the same `useAudioRecorder` status machine already built (`idle` / `requesting-permission` / `recording` / `stopped` / `error`):

- **Idle / stopped / error** (not currently recording): mic icon, label "Record". Clicking calls `recorder.start()` — which, per the hook's existing implementation, already discards any prior clip at the top of `start()`, so *pressing Record again always replaces the current recording* with no separate "Record again"/"Retry" control needed, satisfying that requirement for free.
- **Recording**: the same button becomes the Stop button —
  - Icon area replaced by a miniature 3–4 bar level meter (a scaled-down `AudioLevelMeter`, sized to fit the button's existing `w-10 h-10`/`w-12 h-12` box) driven by `recorder.level`, live.
  - A persistent red ring/border and a small pulsing recording dot mark the state, distinct from the normal `active` (accent-colored) styling other toggled buttons use — this needs a new visual variant on `ControlButton` (e.g. an optional `variant="recording"` prop), not reuse of the existing `active` boolean, so a learner never confuses "recording" with an ordinary toggled-on control.
  - A compact elapsed-time readout (e.g. "0:04") sits immediately below the button. `ControlButton`'s hover-only label (`sm:group-hover:block`, invisible until hover) is the wrong mechanism for this — it needs to be visible continuously while recording, so this is a small, explicit addition to `ControlButton`: an optional `caption` prop that, when present, renders instead of (or in addition to) the hover label, always visible.
  - Clicking calls `recorder.stop()`.
- No waveform, timer, or level meter renders anywhere in the transcript stage — it is entirely contained inside this one button, which is the mechanism that makes recording state changes never affect the stage's height (§6 makes the stage identical to Listening Mode's, which has no recording-related UI at all).

### 5.2 Play/Pause My Recording button
- **Disabled** (existing `ControlButton` `disabled` prop) whenever `recorder.clip` is `null` — i.e., before any recording exists for the current sentence.
- Once a clip exists: Play icon → clicking plays the Blob back; while playing, the icon flips to Pause; playback ending (or a manual pause) flips it back to Play.
- No visible seek bar, time readout, or waveform for *this* playback — that level of detail belongs to the results/evaluation surface (§10), not the always-on control bar. This intentionally uses less UI than `CompactAudioPlayer` currently provides.

### 5.3 Implementation shape
Extract a small headless hook, e.g. `usePlaybackToggle(src: string | null)`, returning `{ isPlaying, toggle }`, driving a hidden `<audio>` element exactly the way `CompactAudioPlayer`'s internals already do (same `play()`/`pause()`/`ended` wiring) but *without* the seek bar, time labels, or mute control that component renders — those become dead code for this call site once `SpeakingPracticeStage` is deleted. `CompactAudioPlayer` itself can stay in `src/components/` unchanged in case a future results surface wants a full player again (e.g., inside the Evaluation tab to re-listen to context), but nothing in the Shadowing control-bar path uses it directly anymore.

### 5.4 Where the recorder instance lives now
Previously `DefaultLayout` owned the single `useAudioRecorder()` instance so both `ControlBar` and the (now-deleted) stage panel could share it. With the stage panel gone, `ControlBar` is the *only* consumer of live recorder state — but the eventual Evaluate action and its results (§8–§10) need that same clip available to a right-panel Evaluation tab, which is a sibling of `DefaultLayout` under `page.tsx`, not a descendant of it. So the recorder instance moves one level higher: **`page.tsx` instantiates `useAudioRecorder()`** (gated to only matter when `inputMode === "shadowing"`, exactly as `DefaultLayout` does today) and passes the handful of values/handlers both `DefaultLayout` (→ `ControlBar`) and `RightPanelTabs` (→ the new Evaluation tab) need. This is a small, mechanical move of an existing hook call one component up — not new logic.

### 5.5 Mobile row-space risk
Today's mobile `ControlBar` row already holds: sentence counter, Prev, Replay, one center button, Next, Speed, and a "More" trigger. Shadowing needs *two* center buttons instead of one, which is one more icon than the row has held before. Recommendation: for Shadowing specifically, move Playback Speed into the "More" bottom sheet (it already hosts secondary controls like Reset and subtitle visibility), keeping Prev / Replay / Record-Stop / Play-My-Recording / Next as the five always-visible primary-row icons. This must be verified against real touch-target spacing during Phase 4 (§12) — it is the most layout-fragile part of this design and is called out explicitly in the testing plan (§14).

## 6. Reuse Listening Mode's layout — remove the dedicated stage

This is the core structural change. [DefaultLayout.tsx](src/app/dictation/[videoId]/components/layouts/DefaultLayout.tsx)'s entire `if (isSpeakingMode) { return (...) }` early-return branch — the 3-row CSS Grid, the video-wrapper duplication, the `<ShadowingPanel>`/`<PronunciationPanel>` swap — is **deleted**. Shadowing falls through to the exact same `return (...)` that Dictation and Listening already share:

- The stage-content condition that currently reads `inputMode === "listening"` (rendering `<ListeningTranscript text={currentSegment?.text ?? ""} fontSizePx={englishFontPx} />`) becomes `inputMode === "listening" || inputMode === "shadowing"`. Shadowing and Listening render **the identical component** — same English script, same translation line below it, same `useTranscriptAutoFit` mobile height-clamp behavior, same `mobile-transcript-stage` fixed-height wrapper.
- `ShadowingPanel.tsx`, `PronunciationPanel.tsx`, and `SpeakingPracticeStage.tsx` are deleted outright — nothing in the new design needs a mode-specific stage component.
- The video block, `RightPanelTabs`, and `ControlBar`'s outer wrapper are untouched — they were never mode-specific to begin with.
- Consequence: Shadowing needs **zero** new layout code. The only remaining Shadowing-specific rendering is inside `ControlBar` (§5) and, later, one new tab inside `RightPanelTabs` (§10).

This directly resolves the original complaint ("wastes horizontal and vertical space… can push the shared control bar below the viewport") by removing the thing that caused it, rather than continuing to tune it — the 84px/220px/1fr grid tuning done in the previous pass is discarded along with the component it was built for.

**Mode-switch stability**, already true for Dictation↔Listening today, now automatically extends to Shadowing: switching among all three modes never remounts `YouTubePlayer` (same instance persists across the shared return path), never resets `currentSegIdx`/playback position, and never changes the transcript stage's dimensions — because Shadowing no longer has a different stage at all.

## 7. Recording architecture — Blob lifecycle, no persistence

[useAudioRecorder.ts](src/hooks/useAudioRecorder.ts) needs **no functional change** — it already satisfies every constraint in §6 of the product decision: it records into an in-memory `Blob`, exposes it via `clip.url` (an `URL.createObjectURL` object URL), and never issues a network request or touches `localStorage`/IndexedDB. The only change is *where it's instantiated* (§5.4) and *when it's released*:

**Release triggers** (all call the hook's existing `discard()`, which stops mic tracks, closes the `AudioContext`, revokes the object URL, and clears `clip`):
- Recording again — already happens automatically inside `start()` before the new take begins.
- Moving to a different sentence — the existing `currentSegIdx`-keyed `useEffect` that calls `discard()` on segment change carries over unchanged (moves along with the hook to `page.tsx`, §5.4).
- Leaving Shadowing Mode — a new effect keyed on `inputMode`, calling `discard()` whenever `inputMode` transitions away from `"shadowing"`.
- Leaving the lesson entirely — already covered: the hook's unmount cleanup (`useEffect` return in `useAudioRecorder`) stops tracks and revokes the URL unconditionally.
- The temporary evaluation flow finishing (success or failure) — does **not** force a discard by itself (the learner should still be able to play back what they just evaluated), but is itself a natural point where an explicit "Discard"/re-record action becomes available if the evaluation result view offers one.

**Why no IndexedDB:** nothing needs to survive a page refresh unsaved, by design — a refresh mid-recording losing the in-progress take is the intended behavior (matching "no permanent storage"), not a bug to work around. IndexedDB is the right tool for a *queue of not-yet-uploaded data that must survive a reload*; there is no such queue here. Component state (the hook's own `useState`) plus a couple of `useRef`s for the live `MediaRecorder`/`MediaStream`/chunk buffer (exactly what's already implemented) is sufficient and appropriate. `localStorage` is never used for audio data (Blobs aren't even serializable into it) — the only `localStorage` writes stay scoped to mode preference (§3.3) and small text flags (e.g. a "seen this hint" marker), never audio bytes.

## 8. Temporary evaluation flow

Evaluation is an **optional, explicit, opt-in action** available once a recording exists — never automatic, never a precondition for basic Shadowing practice, and never gated behind saving audio anywhere (because nothing is ever saved).

```text
Record → Listen back (Play/Pause My Recording) → Evaluate → send the temporary Blob
       → receive structured JSON results → discard the uploaded/temporary audio
```

- The Evaluate action only appears once an evaluation implementation actually exists behind it (§8, "do not expose a nonfunctional Evaluate button in production"). Until Phase 5/6 (§12) ship, there is no Evaluate affordance anywhere in the UI — not a disabled button, not a "coming soon" label. This is a deliberate reversal of the deleted `SpeakingPracticeStage`'s disabled placeholder buttons.
- If server-side processing is needed: the client sends the in-memory `Blob` directly (e.g. `multipart/form-data`, or a raw body with a `Content-Type` matching `clip.mimeType`) to `/api/practice/evaluate`. The route processes it in-memory or via a short-lived temp file (only if a conversion step like ffmpeg requires a real file path), and **deletes any temp file immediately** after the engine call resolves — success or failure, via a `try/finally`. No Supabase Storage call exists anywhere in this path. No database row is written for the audio. The route returns structured JSON only; the audio itself never persists past the request.
- This route follows the same "server-side-only secret" discipline already established for `GEMINI_API_KEY`/`SUPABASE_SERVICE_ROLE_KEY` ([lib/gemini.ts](src/lib/gemini.ts), [lib/supabase/server.ts](src/lib/supabase/server.ts)) — any evaluation-engine API key lives only in `/api/practice/evaluate`'s server environment, never reaches the client bundle.

### 8.1 Word Match vs. true evaluation — kept strictly separate
Carried over from the original plan's engine research (§9 there), re-anchored to the single-mode design:

**Word Match** (speech recognition + text comparison):
- Uses the existing `checkAnswer`/`wordDiff`/`normalizeText` pipeline already in [lib/utils/text.ts](src/lib/utils/text.ts) — no new alignment logic needed, just a new caller.
- Identifies missing, substituted, and inserted words against the reference sentence.
- Labeled **"Word Match"** everywhere in the UI — never "Pronunciation Score." Never claims phoneme-, accuracy-, or prosody-level correctness.
- Recognition source: Web Speech API (`SpeechRecognition`), realistically Chrome/Edge/Android Chrome only (see the engine table, §9) — on Safari/iOS or when unsupported, the UI states plainly that Word Match isn't available there rather than showing a broken or empty state.

**True speech/pronunciation evaluation** (accuracy, fluency, completeness, phoneme, prosody):
- Only shown when the underlying engine actually supports that specific metric — never a placeholder score for a dimension the engine can't produce.
- Kept as an explicitly optional, postponable upgrade (Phase 6, §12), not required for Shadowing's core loop.
- Engine selection continues to prioritize free/recurring-free-tier options (Azure AI Speech Pronunciation Assessment's F0 tier remains the standout — see §9); a paid engine is never required for ordinary Shadowing use and is, at most, an opt-in upgrade path documented alongside its real recurring cost.

## 9. Engine comparison (unchanged in substance, re-scoped to one mode)

*Checked 2026-09-03 against official docs. This table is unchanged from the original research — only its framing changes: every row now feeds Shadowing's optional Evaluate action rather than a separate Pronunciation Practice mode.*

| Engine | Purpose | True scoring or transcription-only | Word-level | Phoneme-level | Fluency/prosody | Runs where | Free allowance | Recurring cost | Recommendation |
|---|---|---|---|---|---|---|---|---|---|
| **MediaRecorder + Web Audio + AudioLevelMeter** | Recording, in-button level meter | Neither | No | No | No | Browser | Unlimited, free | $0 | **Use — already built (§7)** |
| **Web Speech API (`SpeechRecognition`)** | Live ASR | Transcription-only | Yes (via diff) | No | No | Browser (Chrome/Edge/Android Chrome only, real-use) | Unlimited | $0 | **Use for Word Match on Chromium browsers only (§8.1)** |
| **whisper.cpp / faster-whisper / Vosk / wav2vec2** | Server ASR / phoneme CTC | Transcription or phoneme-recognition | Yes | Partial | No | **Not** Vercel functions, **not** Supabase Edge Functions — needs a dedicated VPS | Free (self-hosted) | ~$0–7/mo VPS | Not for MVP — real ops burden, no platform fit |
| **OpenPronounce** ([GitHub](https://github.com/Halleck45/OpenPronounce)) | Self-hosted pronunciation scoring | True scoring | Yes | Yes (IPA) | Partial | VPS only | Free (self-hosted) | ~$2–7/mo VPS | Best-quality self-hosted option, only if a VPS is acceptable |
| **Azure AI Speech — Pronunciation Assessment** | Cloud pronunciation scoring | **True scoring**: accuracy, fluency, completeness, prosody (en-US) | Yes | Yes (IPA/SAPI + syllable) | Yes (opt-in, en-US) | Server (Next.js API route) | **F0 tier: 5 audio hours/month, recurring** ([pricing](https://azure.microsoft.com/en-us/pricing/details/speech/)) | $0 within F0 | **Recommended low-cost/best-quality option (Phase 6)** |
| **Google Cloud Speech-to-Text / AWS Transcribe / OpenAI transcription** | Cloud ASR | Transcription-only | Yes | No | No | Server | Google: ~60 min/mo *(unverified)*; AWS: 12-month trial only; OpenAI: none | $0.003–0.017/min beyond free tier | No pronunciation capability regardless — not needed |
| **Gemini (already integrated)** | General LLM, audio-capable | Qualitative only, not calibrated scoring | Rough | No | No | Server (already wired) | **~20 calls/day, shared across the whole app** | $0 within quota | Optional, rare, user-triggered fallback only — never the default evaluator (quota far too small for per-recording use) |
| **SpeechAce / ELSA / Soapbox Labs** | Commercial pronunciation APIs | True scoring | Yes | Yes | Yes | Server | None meaningful | Real subscription cost | **Do not use** — no tier fits a personal project |

**Recommended MVP evaluation stack:** none required — Shadowing's core loop (§6, §7) needs no evaluation engine at all. **Recommended first evaluation upgrade:** Web Speech API Word Match (Phase 5) — $0, uses only what's already in the codebase. **Recommended true-evaluation upgrade:** Azure Pronunciation Assessment F0 tier (Phase 6) — $0 at personal-usage scale, real recurring quota, genuine phoneme/fluency/prosody output. **Do not use:** AWS Transcribe as a "free" tier (12-month trial, not permanent), Gemini as a default per-recording evaluator (quota), any commercial pronunciation API (no viable free tier), or any of the self-hosted engines as a *default* (all require a VPS this app doesn't otherwise need).

## 10. Evaluation result presentation

The English script, translation, video, and control bar must stay exactly where they are when a result appears — no remount, no height change, no new section pushing anything down.

**Design: an "Evaluation" tab inside the existing `RightPanelTabs`.**

[RightPanelTabs.tsx](src/app/dictation/[videoId]/components/RightPanelTabs.tsx) already renders Script/Words/Sentences as three switchable tabs inside a panel that:
- On **desktop**, sits beside the video/transcript column at a fixed width (`lg:w-[clamp(340px,24vw,400px)]`), independently scrollable, and never affects the left column's size when its internal tab content changes (confirmed already true today — switching Script→Words→Sentences causes zero layout movement in the video/control-bar column).
- On **mobile**, is the same component rendered as a large (`h-[min(100svh,750px)]`), full-width, internally-scrolling panel toggled via the existing `showLearningPanel` state — already functionally a bottom-sheet/full-height overlay, with its own `overflow-y-auto` tab content area.

Adding a fourth tab — **Evaluation** — reuses 100% of this existing, already-responsive mechanism instead of building a new drawer or overlay component:
- The tab is hidden until at least one sentence in the current session has an evaluation result (or the moment `Evaluate` is pressed, whichever is designed to feel more responsive — a loading state either way, per §8).
- Pressing `Evaluate` auto-switches `rightPanelTab` to `"evaluation"` (the same state `page.tsx` already owns and passes to `RightPanelTabs` for the other three tabs), surfacing the loading/result state immediately without the learner hunting for it — while the video, script, translation, and control bar are entirely unaffected, since only content *inside* the already-independent right panel changes.
- From the Evaluation tab, the learner can freely switch back to Script/Words/Sentences — nothing about entering or leaving the tab touches session/video state.
- Content shown: per-sentence result (Word Match and/or true-evaluation categories, per §8.1's strict separation and the labeling rules carried over from the original plan — a 3-tier needs-work/getting-there/solid presentation rather than a single precise-looking percentage, distinct visual treatment for Word Match vs. true scores, an engine-attribution footer on every card) plus, once more than one sentence has been evaluated, the session summary (§11).

This is the layout decision the plan needed to make before implementation, per the request — no new component class, no z-indexed overlay, no separate route: one new tab on an existing, already-responsive panel.

## 11. Per-sentence and session evaluation

Each sentence is evaluated **individually** — never by concatenating separately recorded clips into one file for a "final" score, which would introduce artificial pauses, volume jumps, and start/end gaps that make fluency/prosody numbers meaningless.

```ts
type SentenceEvaluation = {
  segmentIndex: number;
  referenceText: string;
  wordCount: number;
  audioDuration: number;

  accuracy?: number;
  completeness?: number;
  fluency?: number;
  prosody?: number;

  problemWords?: Array<{
    word: string;
    score?: number;
    errorType?: string;
  }>;
};
```

**Storage:** `sessionStorage`, following the exact convention [sessionPersistence.ts](src/app/dictation/[videoId]/sessionPersistence.ts) already uses for the dictation session snapshot (`dictation.active-session.<videoId>`) — a new key, e.g. `dictation.shadowing-evaluations.<videoId>`, holding `Record<number, SentenceEvaluation>` keyed by `segmentIndex`. Nothing here is written to Supabase or any server-side store. Re-evaluating a sentence simply overwrites its entry for that key.

**Session summary**, computed from whatever's in that map at any point (not a separate "end of session" event — the summary can update live as more sentences are evaluated):
- **Accuracy / completeness**: weighted by `wordCount` — `Σ(metric_i × wordCount_i) / Σ(wordCount_i)` over evaluated sentences.
- **Fluency / prosody**: weighted by `audioDuration` — `Σ(metric_i × audioDuration_i) / Σ(audioDuration_i)`.
- **Coverage**, always shown alongside the summary: `"{evaluated} of {total} sentences evaluated"`. Skipped and failed evaluations are excluded from every weighted average above *and* their count is shown separately (e.g. `"3 sentences not evaluated"`) — never silently dropped from the denominator without comment.
- **Aggregated problem words**: tally `problemWords` across all evaluated sentences by word, surfaced as a ranked "words to practice" list.
- **Weakest sentences**: the N lowest-`accuracy` (or highest-problem-word-count) evaluated sentences, surfaced as a "needs more practice" list with a jump-to-sentence action (reusing the existing `jumpToSegment` handler already wired through `useDictationSession`).
- **No single blended Overall Score by default** — accuracy/completeness/fluency/prosody are shown as separate category numbers/bars. If an Overall Score is introduced later, its formula must be documented in this plan, and it must be visually and textually identified as an app-computed aggregate (e.g. "Overall (calculated)") — never presented as if the evaluation engine itself returned one number, since none of the engines in §9 that support multiple categories return a single authoritative blend.

## 12. Optional future feature: Full Passage Assessment

Not required for the MVP; documented here only so it isn't confused with per-sentence evaluation or accidentally built by concatenation:
- Record one **continuous** take spanning roughly 3–6 consecutive sentences (a genuinely new recording flow — the learner listens through/reads several sentences in a row and records once, continuously, matching Listening Mode's continuous-playback behavior rather than per-sentence `playSegment` calls).
- Evaluate that single recording as one unit, labeled **"Full Passage Assessment"**, kept visually and terminologically distinct from per-sentence results.
- Delete the audio after evaluation, same as every other evaluation path in this plan.
- Explicitly **not** built by stitching together individually recorded per-sentence clips — if this ships, it needs its own recording UI (continuous record across a sentence range) designed at that time, not reuse of the per-sentence Record button described in §5.

## 13. Revised phased roadmap

**Phase 1 — Mode architecture preparation.** *Status: completed, needs cleanup.*
The `InputMode` plumbing, `ModeSwitcher` activation, and `useInputModePreference` URL/localStorage handling from the original Phase 1 remain valid and don't need to be redone — they need to be **narrowed** from 4 modes back to 3 (§3), with the legacy-alias migration (§3.3) added on top of what's already there.

**Phase 2 — Local recording prototype.** *Status: completed, kept as-is.*
`useAudioRecorder.ts` and `AudioLevelMeter.tsx` need no functional changes — they already model exactly the Blob-only, no-persistence lifecycle this revision requires (§7). Only their *call site* moves (§5.4).

**Phase 3 — Shadowing UI consolidation and core flow.** *Not postponable — this is the new MVP target.*
- Delete `SpeakingPracticeStage.tsx`, `PronunciationPanel.tsx`, `ShadowingPanel.tsx`, and `DefaultLayout.tsx`'s `isSpeakingMode` grid branch (§6).
- Extend the existing `inputMode === "listening"` stage-content condition to also cover `"shadowing"` (§6).
- Move `useAudioRecorder()` instantiation from `DefaultLayout` to `page.tsx` (§5.4).
- Add the Record/Stop and Play/Pause My Recording buttons to `ControlBar`'s center cluster (§5.1–§5.3), including the new `ControlButton` `variant="recording"` and `caption` support.
- Implement the mode-icon changes (§4) — per-mode `ModeSwitcher`/control-bar-trigger icons, Shadowing's new non-mic icon.
- Apply the `?mode=pronunciation`/localStorage migration (§3.3).
- No evaluation, no Word Match, no saving — record/stop/play-back/overwrite only.
- **Acceptance**: switching into/out of Shadowing never remounts the video or changes `currentSegIdx`/timestamp; the transcript stage is visually identical to Listening Mode's; recording state changes (idle→recording→stopped) never move the control bar or resize the stage; an old `?mode=pronunciation` link lands in Shadowing with the video/session otherwise untouched.

**Phase 4 — Mobile and cross-browser hardening.** *Not postponable — moved earlier than the original plan's Phase 10, per explicit instruction.*
- Resolve the two-button mobile row-space question (§5.5) with real devices, not just reasoning.
- Verify no icon overlap at narrow widths; verify the in-button waveform/timer stays legible at `w-10 h-10`.
- Microphone permission denial/no-mic-present, tab backgrounding/minimizing mid-recording, app/lesson exit mid-recording.
- Chrome, Edge, Android Chrome, desktop Safari, iPhone Safari.
- **Acceptance**: control bar stays on one row at all tested widths; no control overlap; no transcript-stage resize; recording survives (or cleanly aborts, never silently corrupts) a background/foreground cycle.

**Phase 5 — Optional free Word Match.** *Postponable.*
- Wire Web Speech API transcription of the current recording against `checkAnswer`/`wordDiff` (§8.1).
- Label results "Word Match" everywhere; degrade to an honest "not available on this browser" state on Safari/iOS.
- Must not block or slow down ordinary record/playback — this is purely additive.

**Phase 6 — Temporary true-evaluation integration.** *Postponable.*
- `/api/practice/evaluate`: accepts the in-memory Blob, calls the selected engine (Azure F0 tier recommended first — §9), returns structured JSON, deletes any temp file immediately (§8).
- No Supabase Storage, no permanent audio, no DB row for the recording.
- Graceful degradation when the engine or its quota is unavailable — falls back to Word Match only (if Phase 5 shipped) or a plain "evaluation unavailable right now" state, never a broken UI.

**Phase 7 — Session summary.** *Postponable, depends on Phase 5 and/or 6 having produced at least some `SentenceEvaluation` data.*
- Aggregate `sessionStorage`-held per-sentence results using the weighted formulas in §11.
- Coverage display, excluded-sentence count, aggregated problem words, weakest-sentences list.
- Summary is session-scoped only — no cross-session history, no persistence beyond `sessionStorage`'s natural lifetime (cleared on tab close, same as the existing dictation-session snapshot).

**Future — Full Passage Assessment.** *Postponable, no dependency on Phases 5–7 beyond sharing the same evaluation route shape.* See §12.

**Explicitly removed from the roadmap** (were Phases 5, 7 (partially), 8's storage half, and 9 in the original plan): permanent Supabase-backed recording storage, the `practice_attempts` table, the `practice-recordings` bucket and its RLS policies, `/api/practice/save`, `useSavedAttempts`, saved-attempt deletion, storage-usage display, audio retention policy. None of this was ever built, so nothing needs to be undone in code — only the design is being dropped.

## 14. Corrected roadmap dependencies

The original plan's Phase 7 (Pronunciation Practice MVP) depended on Phase 5 (Supabase saving). **That dependency no longer exists anywhere in this plan.**

**Core Shadowing (Phase 3) depends only on:**
- Mode architecture (Phase 1, narrowed).
- Local recording (Phase 2, unchanged).
- Playback (the new `usePlaybackToggle`, §5.3).
- Responsive control-bar integration (Phase 4, moved earlier).

**Evaluation (Phases 5–6) depends only on:**
- A temporary recording Blob already in memory (Phase 3).
- The selected evaluation engine (§9).
- A result UI (§10 — the Evaluation tab).

**Evaluation explicitly does not depend on:**
- Supabase Storage — removed from the plan entirely (§13).
- A permanent Save action — removed entirely (§7).
- Audio history — removed entirely.
- A separate Pronunciation mode — removed entirely (§2).

**The true MVP** — the only non-postponable work — is Phases 1 (cleanup), 2 (kept), 3 (consolidation), and 4 (hardening): architecture cleanup, local record/stop/playback, a stable Shadowing UI reusing Listening's layout, and cross-browser/mobile hardening. Word Match (Phase 5), true evaluation (Phase 6), session summaries (Phase 7), and Full Passage Assessment (Future) are all optional, clearly postponable upgrades — this replaces the original plan's "Phases 1–7, 10 are non-postponable" statement, which no longer holds under the simplified product scope.

## 15. Testing plan

Beyond the original plan's browser/device/failure-mode matrix (still valid: mic denied, no mic present, recording interrupted, silent audio, background noise, very short/over-cap recordings, network failure, evaluation timeout), this revision adds:

- Migration: a stored `"pronunciation"` localStorage value loads as Shadowing; an old `?mode=pronunciation` URL loads Shadowing and the address bar updates to `?mode=shadowing`.
- Switching among Dictation, Listening, and Shadowing (all pairwise directions) — video never remounts, `currentSegIdx`/video timestamp never resets, transcript-stage dimensions never change.
- Record permission accepted and denied, from the control-bar Record button specifically (not the old stage button, which no longer exists).
- Recording start, stop, and overwrite (press Record again mid-existing-clip).
- The in-button waveform/level meter actually animates during recording, at both button sizes (`w-10`/`w-12`).
- Play/Pause My Recording: disabled before any recording exists; toggles correctly; auto-resets to Play when playback ends.
- Switching sentences while recording — recording is discarded (§7), no dangling `MediaRecorder`/stream.
- Switching modes (away from Shadowing) while recording — same discard guarantee.
- Tab backgrounding / browser minimizing mid-recording.
- Temporary evaluation: success, failure, and timeout paths; confirm (via network inspection or a server-side log assertion) that the evaluated audio is never written to any persistent store and any temp file is deleted.
- Re-evaluating an already-evaluated sentence replaces its `SentenceEvaluation` entry rather than duplicating it.
- Session-summary weighting is correct against a hand-computed example (word-count-weighted accuracy/completeness, duration-weighted fluency/prosody) and excluded sentences are visibly counted, not silently dropped.
- Desktop and mobile control-bar stability specifically: no icon overlap, no transcript-stage resize, control bar never pushed below the viewport — at minimum **1366×768, 1536×864, 1920×1080**, plus **Android Chrome** and **iPhone Safari**.

## 16. Security and privacy

- Microphone access requested lazily on first Record press, browser-native permission prompt only — no custom pre-prompt dialog.
- A visible recording indicator (the Record button's own red-ring/dot state, §5.1) whenever `MediaRecorder` is active.
- **No audio is ever stored** — private-bucket RLS, signed URLs, and retention policy are all removed from this plan along with the storage design itself (§13). The only place audio ever leaves the device is a direct, temporary POST to `/api/practice/evaluate` when the learner explicitly presses Evaluate — and only if Phase 6 (or the Web Speech API browser-native path for Phase 5, which sends audio to the browser vendor's own recognition servers, not this app's backend) is in use.
- Any evaluation-engine API key (Azure Speech key, etc.) lives only in server-side environment variables, read only inside `/api/practice/evaluate`, matching the existing `GEMINI_API_KEY`/`SUPABASE_SERVICE_ROLE_KEY` discipline.
- The UI discloses, per evaluation attempt, which processing happened locally (Word Match via the browser's own recognizer) vs. was sent to a third party (Azure or similar) — carried over from the original plan's labeling requirement.
- Any server-side temp file created during evaluation (e.g. for an ffmpeg conversion step) is deleted in a `finally` block immediately after the engine call resolves, regardless of success or failure.

## 17. Estimated recurring costs at personal usage

- Core Shadowing (Phases 1–4): **$0/month** — no new infrastructure, no storage, nothing beyond what's already deployed.
- Word Match (Phase 5): **$0/month** — browser-native, no server cost.
- True evaluation (Phase 6, Azure F0 tier): **$0/month** at personal-usage scale (well under 5 audio-hours/month for one learner practicing a handful of sentences a day) — and with no Save step and no audio history, usage stays naturally bounded to "however much a learner evaluates in one sitting," not an ever-growing saved library.
- Session summary (Phase 7): **$0** — pure client-side computation over already-fetched `SentenceEvaluation` data.
- Removed entirely from the cost picture versus the original plan: Supabase Storage usage (was already negligible, but is now exactly zero since nothing is stored), and any self-hosted-VPS cost that would only have been relevant to a permanent saved-attempt library.

## 18. Open decisions requiring user input

1. Exact icon choice for Shadowing if `AudioLines` isn't available in the installed lucide-react version (`Waves` is the suggested fallback) — a two-minute check at implementation time, not a design question, but flagged since it wasn't verified against the actual installed package version while writing this plan.
2. Whether the Evaluation tab (§10) should be hidden entirely until the first `Evaluate` press, or should always exist (showing an empty state) once Phase 5/6 ships — a product-feel call.
3. Whether Phase 5 (Word Match) or Phase 6 (true evaluation via Azure) should be built first — they're independent and either can lead; Phase 5 is cheaper/faster to ship, Phase 6 is more valuable but has a real (if free-tier) external dependency to wire up.
4. Whether the mobile row-space fix in §5.5 (moving Playback Speed into "More" for Shadowing) is acceptable, or whether a different control should move instead — needs a quick look at real devices during Phase 4.
5. Whether Full Passage Assessment (§12) is wanted at all before there's user feedback on per-sentence evaluation — currently unscoped and postponable indefinitely.

## Immediate next implementation step

The smallest safe move from the current Phase 1–2 code to the new Phase 3 is, in order:
1. Delete `SpeakingPracticeStage.tsx`, `ShadowingPanel.tsx`, `PronunciationPanel.tsx`, and `DefaultLayout.tsx`'s `isSpeakingMode` grid branch; extend the `inputMode === "listening"` stage condition to include `"shadowing"`. This alone should already make Shadowing visually identical to Listening Mode, with no recording UI yet — a clean, verifiable checkpoint before adding anything new.
2. Narrow `InputMode` to three values, remove the Pronunciation option from `ModeSwitcher`, and add the `?mode=pronunciation`/localStorage alias migration in `useInputModePreference` (§3.3) — verify an old `?mode=pronunciation` link still lands correctly.
3. Only then add the two new `ControlBar` buttons (§5) and the recorder-instance move to `page.tsx` (§5.4) — the riskiest, most novel piece of Phase 3, done last so it lands on top of an already-verified, already-simplified base rather than alongside a half-migrated mode system.
