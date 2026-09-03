Shadowing Mode & Pronunciation Practice Mode — Implementation Plan
1. Repository findings
Practice page architecture (src/app/dictation/[videoId]/):

page.tsx is the orchestrator — owns all top-level state, wires ~15 hooks (useDictationSession, useInputModePreference, usePracticeModePreference, useBookmarks, useLessonCapture, etc.), and renders <DefaultLayout> + <RightPanelTabs> inside one shared shell (header, video card, control bar, right panel). There is no per-mode page — this is the single layout every mode must plug into.
DefaultLayout.tsx renders: a fixed-aspect video block → a "transcript stage" (mobile-transcript-stage, height-locked on mobile via useTranscriptAutoFit so switching sentences never resizes the box) → <ControlBar>. Today the stage branches on isDictationMode: <SentenceWordInput> for dictation, <ListeningTranscript> for listening. This is the exact swap point for Shadowing/Pronunciation Practice — a third/fourth branch replacing that stage's content with a record/playback UI, without touching the video block or ControlBar wiring.
RightPanelTabs.tsx is mode-agnostic (Script/Words/Sentences) and needs no structural change; an "Attempts" or "History" tab could be added later without disrupting it.
types.ts: InputMode = "dictation" | "listening". Must become "dictation" | "listening" | "shadowing" | "pronunciation".
ModeSwitcher.tsx already has a disabled "Shadowing — Coming soon" row hard-coded between Listening and Dictation — a clear signal this was pre-planned as the fourth InputMode. Pronunciation Practice has no placeholder yet and needs one added.
useInputModePreference.ts: ?mode= URL param is the source of truth (dashboard links, resumable sessions, shared links all agree on mode); per-video localStorage["dictation.input-mode.<videoId>"] is the fallback for links without the param. Currently a binary === "listening" check — must become a proper 4-way switch.
ControlBar.tsx hosts the mode-switch popover trigger, playback-speed control, subtitle-visibility popover, and (on mobile) a "More" bottom sheet. It already conditionally swaps its center button (Hint vs Play/Pause) by mode — the same pattern extends to a Record button.
YouTube player control surface (YouTubePlayer.tsx) exposes playSegment(segIdx), playVideo(), pauseVideo(), seekTo(), setPlaybackRate() — playSegment already plays exactly one sentence and stops, which is precisely "play the original sentence" for both new modes. No player changes needed.
sessionPersistence.ts establishes the house pattern for surviving remounts: snapshot transient UI state into sessionStorage, scoped by video ID. The new modes should follow this pattern for in-progress (unsaved) recording state.
Reusable evaluation primitives already in the codebase:

lib/utils/text.ts: normalizeText, wordDiff (LCS-based), checkAnswer, classifyError — this is a working Word Match engine already (text normalization, punctuation/contraction handling via removePunctuation, word-level diff with correct/missing/wrong/extra statuses). Pronunciation Practice's Word Match layer should call this directly rather than reimplementing alignment.
useAutoTranscribeSpeech.ts: an existing, already-shipped SpeechRecognition integration (continuous mode, auto-restart on onend, permission-denied handling). It's used for a different purpose (transcribing the video itself) but is a ready template for "record the user, get interim/final text back" — confirms Web Speech API is already an accepted approach in this codebase, with its Chrome-only/privacy caveat already implicitly acknowledged in its own comment.
Backend/hosting reality that constrains the evaluation architecture:

package.json: Next.js 16 App Router, Supabase (@supabase/ssr, @supabase/supabase-js), @google/generative-ai, @upstash/redis. No audio/ML libraries yet.
lib/rateLimit.ts: Gemini calls are gated by a global, shared quota — GEMINI_RPM_LIMIT=5, GEMINI_RPD_LIMIT=20 by default, tracked in Upstash Redis and shared across every caller of the app, not per-user. This is decisive: Gemini cannot be the default per-attempt evaluator for either new mode — 20 calls/day total would be exhausted by a single practice session. It remains usable only as a rare, explicitly user-triggered, opt-in action (mirroring api/ai/explain/route.ts's pattern), sharing the same tiny budget as the app's existing AI-explanation feature.
lib/supabase/server.ts: cookie-based RLS client for user-scoped reads/writes, a separate createServiceClient() for privileged service-role operations (never exposed client-side) — the pattern the new evaluation route must follow.
lib/supabase/ownership.ts: ownsSession/ownsAttempt helpers pair an RLS policy with an explicit server-side ownership check — a new ownsPracticeAttempt helper should follow the same shape.
No Supabase Storage bucket exists anywhere in the codebase today (vocabulary images are external Openverse URLs, not stored). This is greenfield — bucket, policies, and upload plumbing all need to be built from scratch.
Migrations are sequential, one concern per file, through 012_listening_sessions.sql — the next migration is 013_practice_attempts.sql.
No dedicated backend/VPS exists; hosting is Vercel (Next.js serverless/Node functions) + Supabase + Upstash. This rules out anything requiring a persistent process or GPU as a default dependency (see §4).
2. Product recommendation
Build Shadowing Mode and Pronunciation Practice Mode as two new values of the existing InputMode enum, sharing 100% of the existing shell (header, video card, RightPanelTabs, ControlBar chrome) and swapping only the transcript-stage content — exactly the way Listening Mode already swaps in <ListeningTranscript> instead of <SentenceWordInput>. Do not build a new route or page.

Ship them in two clearly separated tracks because they solve different problems:

Shadowing is self-comparison, no scoring required, MVP-able entirely client-side with zero backend cost.
Pronunciation Practice genuinely needs some recognition/scoring engine, so it must be designed around the hard constraint above: no free engine of real quality runs on this app's current hosting. Its MVP is therefore Word Match only (transcription + alignment, honestly labeled as not a pronunciation score), with true pronunciation scoring (Azure F0) as an explicit, later, optional upgrade — not blocking the MVP.
Be honest with the user about this tradeoff up front rather than over-promising a phoneme-level score the free stack can't deliver on day one.

3. Shadowing vs. Pronunciation Practice — the distinction
Shadowing	Pronunciation Practice
Goal	Rhythm, timing, stress, intonation — mimic the speaker	Correctness of individual words/sounds against reference text
Reference	The speaker's audio (heard, then imitated in near-overlap or immediately after)	The sentence's text (read aloud once, alone)
Scoring requirement	None required for MVP — self-comparison only	Needs at least Word Match; true phoneme scoring is a stretch upgrade
Primary feedback	"How close was your timing/rhythm to the original?" (duration, pace, waveform overlay)	"Which words did you mispronounce or skip?"
Recording use	Play original → record while/just after → compare both recordings side by side	Play original → stop it → record alone → evaluate against text
Repetition model	Same sentence many times, or a whole section continuously	One sentence at a time, retry until satisfied
Failure mode to avoid	Treating a rough pitch/duration heuristic as an authoritative score	Treating successful transcription as proof of correct pronunciation
4. Engine comparison table
Checked 2026-09-03 against official docs; see inline links. Google Cloud's free-tier figure below could not be verified against a clean fetch of the official pricing page (secondary sources converge on it) — verify at cloud.google.com/speech-to-text/pricing before depending on it.

Engine	Purpose	True scoring or transcription-only	Word-level	Phoneme-level	Fluency/prosody	English locales	Runs where	Mobile OK	Free allowance	Recurring cost	Compute	Privacy	License	Advantages	Disadvantages	Recommendation
MediaRecorder + Web Audio + Meyda + Pitchy/VAD	Recording, waveform, energy/pitch/VAD	Neither (no recognition)	No	No	No (rough pitch/energy contour only)	N/A	Browser	Yes (all)	Unlimited, free	$0	Negligible	100% local, nothing leaves device	MIT/BSD-style	Zero cost, zero infra, instant, private	Zero word-correctness signal	Use — foundation for both modes
Web Speech API (SpeechRecognition)	Live ASR	Transcription-only	Yes (via diff)	No	No	en-* (browser-dependent)	Browser (Chrome/Edge/Android Chrome only, real-use)	No (iOS Safari unreliable)	Unlimited	$0	None (Google's servers do the work)	Audio sent to Google's servers, not local, no offline	N/A (browser API)	Already used elsewhere in this codebase, zero setup	Chrome-only in practice, privacy tradeoff, no scoring	Use for Word Match on Chromium browsers only
Transformers.js (Whisper tiny/base, in-browser)	Offline ASR	Transcription-only	Yes (via diff)	No	No	Multilingual/en	Browser (WASM, WebGPU accel on Chrome/Edge)	Slow/heavy on phones, iOS WebGPU partial	Unlimited	$0	~75–150MB one-time download; multi-sec CPU on phone	Fully local/private	MIT (Xenova)	Private, works offline once cached, no per-call cost	Large download, slow on mobile, Safari WebGPU gaps	Optional fallback for Safari/offline, not MVP default
whisper.cpp / faster-whisper	Server ASR	Transcription-only	Yes	No	No	Multilingual/en	Not Vercel functions, not Supabase Edge Fn — needs a small VPS	Backend-only	Free (self-hosted)	~$0–7/mo VPS (Fly.io/Railway/Render)	CPU-only OK for short clips	Private if self-hosted	MIT	Accurate, no per-call fee once running	Real ops burden for a solo dev; no platform fit on current stack	Not for MVP; only if a VPS is later justified
Vosk	Server ASR	Transcription-only	Yes	No	No	en (small model 40MB)	Same as above — VPS only	Backend-only	Free	Same VPS cost	Low (small model)	Private if self-hosted	Apache 2.0	Small model, decent accuracy	Same deployment gap as whisper.cpp	Not for MVP
wav2vec2 (HF)	ASR / phoneme CTC	Transcription or phoneme-recognition	Yes	Partial (via CTC phones)	No	en	VPS only (PyTorch)	Backend-only	Free	VPS cost	CPU OK, GPU nicer	Private if self-hosted	Apache 2.0	Basis for open pronunciation tools (below)	Needs PyTorch runtime, no platform fit	Building block, not standalone MVP choice
OpenPronounce (wav2vec2 + DTW, GitHub)	Self-hosted pronunciation scoring	True scoring	Yes	Yes (IPA)	Partial (pitch/energy curves, no formal fluency score)	en	VPS only	Backend-only	Free (self-hosted)	VPS cost (~$2–7/mo)	CPU OK for short clips, ~2.4GB RAM for two wav2vec2 checkpoints	Private if self-hosted	MIT	Closest free/open Azure-Assessment clone that exists today	Small project (47★), ~10% phone-error-rate caveat acknowledged by its own author, real VPS ops burden	Best-quality self-hosted option if a VPS is acceptable
Montreal Forced Aligner + Kaldi GOP	Forced alignment + pronunciation scoring	True scoring (GOP)	Yes	Yes	No	en	VPS only (conda/Kaldi)	Backend-only	Free	VPS cost	CPU OK	Private if self-hosted	MIT/Apache	Well-validated in research literature	Steep Kaldi/conda ops burden, no scoring UI, must be hand-built	Too much build effort for a solo personal app
Azure AI Speech — Pronunciation Assessment	Cloud pronunciation scoring	True scoring: accuracy, fluency, completeness, prosody (en-US)	Yes	Yes (IPA/SAPI + syllable, en-US)	Yes (ProsodyScore, opt-in, en-US only)	Broad (best on en-US)	Server (call from a Next.js API route)	Yes	F0 tier: 5 audio hours/month, recurring, not a trial (pricing)	$0 within F0; beyond it, standard STT rate + $0.30/hr only for real-time streaming (batch mode free of that surcharge)	None (Microsoft's servers)	Audio leaves the device to Microsoft	Proprietary/commercial API	Only option here with genuine word+phoneme+prosody scoring and a real recurring free quota	Third-party dependency, needs a server-side proxy to hide the key, en-US-centric prosody	Recommended low-cost/best-quality cloud fallback
Google Cloud Speech-to-Text	Cloud ASR	Transcription-only	Yes (confidence)	No	No	Broad	Server	Yes	~60 min/month recurring (unverified — check official page)	~$0.016/min beyond free tier	None	Leaves device to Google	Proprietary	Simple, broad locale support	No pronunciation feature at all	Not needed given Azure covers this better
AWS Transcribe	Cloud ASR	Transcription-only	Yes	No	No	Broad	Server	Yes	60 min/month for 12 months only — a trial, not permanent (pricing)	$0.006–0.01/min	None	Leaves device to AWS	Proprietary	—	No pronunciation feature; free tier expires	Do not use — trial, not a real free tier, and no scoring capability anyway
OpenAI Whisper/gpt-4o-transcribe API	Cloud ASR	Transcription-only	Yes	No	No	Broad	Server	Yes	None	$0.003–0.017/min (pricing)	None	Leaves device to OpenAI	Proprietary	High transcription accuracy	No free tier, no pronunciation feature	Only as a paid last-resort fallback, not MVP
Gemini (already integrated)	General LLM, audio-capable	Transcription/qualitative feedback only, not calibrated scoring	Rough (prompt-dependent)	No	No (unreliable if prompted for it)	Broad	Server (already wired)	Yes	~20 calls/day, shared across the whole app	$0 within quota	None	Leaves device to Google	Proprietary	Zero new integration cost, already rate-limited/cached pattern exists	Quota far too small for per-attempt use; not a calibrated pronunciation scorer	Optional, rare, user-triggered "ask AI" button only — never the default evaluator
SpeechAce / ELSA / Soapbox Labs	Commercial pronunciation APIs	True scoring	Yes	Yes	Yes	en	Server	Yes	None meaningful (SpeechAce ~$125/mo for 10k calls; ELSA Business ~$18/user/mo)	Real, ongoing subscription cost	None	Leaves device to vendor	Proprietary	Purpose-built, mature	Expensive for a personal project	Do not use — no free tier fits a personal app's budget
Recommended completely free MVP stack
Browser recording (MediaRecorder + Web Audio/Meyda/Pitchy) for both modes' local metrics and playback, plus Web Speech API for Word Match on Chrome/Edge/Android Chrome (with an honest "recognition unavailable here" state on Safari/iOS). $0 recurring, zero new infrastructure.

Recommended low-cost upgrade stack
Add Azure AI Speech Pronunciation Assessment on the F0 free tier (5 hrs/month, recurring) behind a Next.js API route, used only when the learner explicitly presses "Evaluate pronunciation" on a saved recording (not automatically, not per-attempt). Still $0/month at personal-scale usage, with a hard ceiling that degrades gracefully to Word Match if exceeded.

Recommended best-quality stack
Same Azure integration, moved to pay-as-you-go once F0's 5 hrs/month is a real constraint (unlikely for one learner) — batch-mode pronunciation assessment costs the same as plain STT, no extra surcharge. Self-hosting OpenPronounce on a ~$2–7/month VPS is the alternative "best-quality, zero external API dependency" path, but only worth it if the user actively wants to avoid any cloud vendor and is willing to own ongoing ops (patching, uptime, model updates) — not recommended as the default for a one-developer personal app.

Engines that should not be used, and why
AWS Transcribe as a "free" engine — its free tier is a 12-month trial, not permanent, and it has no pronunciation-scoring capability regardless.
OpenAI transcription as a default/free path — no free tier at all, transcription-only.
Gemini as the default per-attempt evaluator for either mode — the app's shared quota is 20 calls/day total; a single practice session would exhaust it and starve the existing AI-explanation feature.
whisper.cpp / faster-whisper / Vosk / wav2v2 / MFA / Kaldi-GOP directly inside Vercel serverless or Supabase Edge Functions — technically impossible: no persistent disk for model caching, no GPU, and Supabase Edge Functions cap at 2s CPU-time/150MB memory on the free tier. Any of these require a dedicated VPS, which is a real (if small) recurring cost and maintenance burden, not "free" in practice.
Commercial pronunciation APIs (SpeechAce/ELSA/Soapbox) — no tier realistically fits a personal project's budget.
Web Speech API as a claimed "pronunciation" scorer — it is ASR only; never present its output as anything but Word Match, and never as evidence of correct pronunciation.
5–6. Recommended stacks
Already stated above (end of §4) per the required structure — free MVP stack and low-cost upgrade stack.

7. UX flows
Shadowing Mode
Select Shadowing from the mode switcher (same popover as today, ModeSwitcher.tsx's stub becomes live).
Headphone reminder — a dismissible one-time banner (localStorage-flagged, same pattern as REPLAY_HINT_SEEN_KEY) explaining that speaker playback will bleed into the recording; no way to technically prevent it, so this is purely instructional.
Play original — reuses playSegment(currentSegIdx). Button label "▶ Hear it" replaces the dictation input area's role.
Countdown (3-2-1, ~configurable, default 3s) — visual only, no audio cue that would itself get picked up by the mic.
Record — big record button, live level meter (Web Audio analyser), running timer, auto-stop at a max duration (original sentence duration × 2.5, capped at e.g. 20s) or manual stop.
Compare — two playback buttons side by side: "▶ Original" / "▶ You," plus a stacked/overlaid waveform view (two <canvas> traces) and the local metrics (see §9).
Retry — discards the Blob, returns to step 3, no network call. Retries are unlimited and free.
Optionally save — "💾 Save this attempt" uploads only the currently-selected Blob.
Continue — "Next sentence" (single-sentence loop) or "Practice this section" (auto-advance through N sentences, same play→record→compare loop repeated, pausing between each).
Pronunciation Practice Mode
Select Pronunciation Practice from the mode switcher (new stub, same visual slot as Listening/Shadowing/Dictation).
Play original — playSegment; video/audio is force-paused before recording starts (unlike Shadowing, which may still be mid-playback when recording begins).
Countdown, then record (same primitives as Shadowing).
Stop — auto (silence-based VAD, optional Phase 8 enhancement) or manual.
Playback before evaluation — learner can listen to their own take and re-record before spending any evaluation budget.
Evaluate — button explicitly separate from "record," so evaluation (whether local Word Match or, later, an Azure call) is opt-in per attempt, never automatic.
Loading state — skeleton/spinner on the results card; Word Match resolves near-instantly (client-side), Azure calls show a distinguishable "calling pronunciation engine…" state with a timeout.
Results — Word Match card always; Pronunciation/Fluency/Prosody cards only when that engine actually ran (see §14 for labeling rules).
Retry or Save — same local-first, explicit-save pattern as Shadowing.
Mode-switch behavior (applies to both)
Switching into Shadowing/Pronunciation Practice from Dictation/Listening: video player is not remounted (same YouTubePlayer instance persists — only DefaultLayout's stage content swaps); current timestamp and currentSegIdx are preserved exactly as they are today when toggling Dictation↔Listening.
Switching away mid-recording: if a recording is in progress, prompt "Discard this recording?" (unsaved Blobs are cheap to lose, but silent loss is bad UX) — same idea as the existing window.confirm guards used for script regeneration.
Refresh during an unsaved attempt: the Blob is gone (it was never persisted — by design, see §8); on remount, if sessionStorage shows a recording was in progress, show a small "Your last recording wasn't saved" toast rather than silently doing nothing.
Desktop vs. mobile
Desktop: record controls sit in the transcript stage's fixed-height area (same slot SentenceWordInput/ListeningTranscript occupy today); level meter and waveform render inline.
Mobile: identical stage swap, but secondary actions (waveform detail, saved-attempts history) move into the existing MobileBottomSheet "More" pattern rather than crowding the fixed-height stage, keeping the one-row ControlBar mobile layout untouched. Record/Stop stays the one always-visible primary action, replacing the Hint/Play-Pause slot in ControlBar's center for these two modes.
8. Recording architecture
Local-first, explicit-save. MediaRecorder writes to an in-memory Blob per attempt; nothing touches the network or Supabase until "Save attempt" is pressed. Failed/discarded takes never leave the browser.
MIME selection at record time, runtime-detected via MediaRecorder.isTypeSupported(), preferring audio/webm;codecs=opus (Chrome/Edge/Android Chrome/Firefox) and falling back to audio/mp4 (Safari — default there since MediaRecorder support landed, WebM added only in Safari 18.4+ and not default even then).
No client-side transcoding to WAV. Store the compressed Blob as recorded; only convert to 16kHz mono PCM/WAV server-side, on-demand, immediately before a pipeline that requires it (Azure Speech SDK), via ffmpeg-static/fluent-ffmpeg inside a Node.js-runtime API route (not Edge runtime — Edge can't run native binaries).
Duration cap: recording auto-stops at max(originalDuration × 2.5, 8s), capped at 20s absolute, to bound both UX (no one shadows a 3-word sentence for a minute) and later Storage/Azure-minute costs.
Temporary local storage: keep the Blob in a useRef/component state only for the current attempt (per requirements, an explicit "current vs. previous attempt" comparison needs at most the last one or two Blobs in memory — IndexedDB is not required for the MVP, since nothing needs to survive a refresh unsaved by design). Reserve IndexedDB for a later "offline queue of not-yet-uploaded saves" enhancement, not the MVP.
Mic permission: request via getUserMedia({ audio: true }) lazily, only when the learner first presses Record in one of these two modes — never on page load. Denials produce a persistent inline state ("Microphone access denied — check your browser's site settings") rather than a dead button.
Recording indicator: a clearly visible red dot + timer while MediaRecorder.state === "recording", consistent with platform mic-in-use indicators (which the browser/OS already shows independently).
9. Evaluation architecture
Pipeline A — Completely free MVP (local/client-only)
Computed entirely in the browser from the two Blobs (original sentence audio, extracted once via an offline <audio> decode of the segment's YouTube time range is not available — YouTube's iframe doesn't expose raw PCM — so "original" metrics are approximated from the known segment duration end - start, not from decoding audio) and the user's recording:

Duration comparison: recorded length vs. segment duration — reliable, cheap, meaningful signal for shadowing pace.
Speaking-rate proxy: syllable-ish estimate from word count ÷ duration — reliable enough as a rough words-per-minute comparison, not a real syllable count.
Silence/pause detection: energy-threshold segmentation via Web Audio AnalyserNode/Meyda RMS — reliable for "did you pause where the speaker paused," reasonably trustworthy.
Start/end timing offset: when did speech begin relative to recording start — reliable.
Waveform overlay: purely visual, always safe to show (it's just a picture, no claim of correctness).
Pitch contour comparison: Pitchy/autocorrelation-based F0 tracking on both clips, plotted together — experimental, label it as such; absolute pitch differs by speaker (voice range, gender) so raw contour overlap is a rough rhythm-of-intonation cue at best, not a similarity score. Do not reduce it to a single number.
What this pipeline cannot evaluate: word correctness, pronunciation accuracy, phoneme correctness, fluency in any calibrated sense. It is entirely presented as self-comparison aids, never as a score.
Pipeline B — Free/low-cost Word Match
Client records the learner reading the sentence alone.
On Chrome/Edge/Android Chrome: run SpeechRecognition on the recording (same getSpeechRecognitionCtor() pattern as useAutoTranscribeSpeech.ts, applied live during/just after the mic recording rather than during video playback).
On Safari/iOS or when recognition is unsupported: show "Word Match isn't available on this browser — you can still listen back and self-rate" rather than a broken/empty state; optionally offer a manual opt-in "Ask AI to transcribe this" button that spends 1 of the app's shared Gemini calls (rate-limited, clearly labeled).
Feed both texts into the existing checkAnswer/wordDiff/normalizeText pipeline from lib/utils/text.ts (relaxed mode: lowercase, punctuation stripped, contractions handled the same way dictation already does).
Derive Word Error Rate from the diff (substitutions+deletions+insertions ÷ reference word count), and surface missing/inserted/substituted words individually.
Label the result "Word Match," never "Pronunciation Score." Recognition confidence (where the browser exposes it) can gray out low-confidence words rather than asserting them as definite mismatches.
Pipeline C — True pronunciation assessment (Azure)
Learner saves a recording and presses "Evaluate pronunciation" (explicit, budget-aware action, not automatic).
Server route (/api/practice/evaluate, Node.js runtime) downloads the Blob from Supabase Storage using the service-role client, converts to 16kHz mono WAV via ffmpeg-static.
Calls Azure Speech's Pronunciation Assessment REST endpoint with the reference text and audio, server-side only (key lives in an env var, never reaches the browser) — mirrors the existing GEMINI_API_KEY server-only pattern.
Normalizes Azure's response into { accuracyScore, fluencyScore, completenessScore, prosodyScore, overall, wordScores: [{word, accuracyScore, errorType}], phonemeScores: [...] } and writes it to practice_attempts.pronunciation_result (JSONB) plus engine_name='azure-pronunciation-assessment', engine_version (API version string), eval_status='completed'.
Errors/timeouts (network, Azure quota exhausted, malformed audio) set eval_status='failed' with a short reason string, and the UI falls back to showing Word Match only, with a retry button — never a silent blank state.
If Azure's F0 minutes are realistically never exhausted at personal-usage scale (a handful of sentences/day), no quota gating beyond a sane request timeout (~10s) is needed; if usage grows, apply the same Upstash-backed shared-quota pattern already used for Gemini.
If the user explicitly wants zero cloud dependency, the smallest practical alternative is self-hosting OpenPronounce on a small VPS (§4) — call out clearly that this trades "no vendor" for "you now run and patch a server," which is a real ongoing cost this personal app doesn't currently carry.

10. Supabase Storage and database design
Bucket: practice-recordings — private (no public read). Path convention:


{userId}/{videoId}/{segmentIndex}/{attemptId}.{ext}
ext derived from the stored MIME type (webm or m4a/mp4). Access only via short-lived signed URLs (~60s TTL, regenerated on each playback request) issued by a server route that first calls the ownsPracticeAttempt check.

Table practice_attempts (naming note: the brief suggested shadowing_attempts, but since one table serves both modes with a mode column — the same shape-sharing tradeoff listening_sessions vs. learning_sessions already made a call on in this codebase — a mode-neutral name avoids an outgrown legacy name):


create table practice_attempts (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references users(id) on delete cascade,
  youtube_video_id      text not null,
  transcript_id         uuid references transcripts(id) on delete set null,
  segment_index         integer not null,
  mode                  text not null check (mode in ('shadowing', 'pronunciation')),
  reference_text        text not null,
  storage_path          text not null,
  mime_type             text not null,
  duration_sec          numeric,
  recognized_text       text,
  word_match            jsonb,   -- { wer, diff: DiffToken[], missing: [], inserted: [], substituted: [] }
  pronunciation_result  jsonb,   -- { accuracyScore, fluencyScore, completenessScore, prosodyScore, wordScores: [...] }
  engine_name           text,
  engine_version         text,
  eval_status           text not null default 'not_evaluated'
                           check (eval_status in ('not_evaluated', 'pending', 'completed', 'failed')),
  eval_error             text,
  self_rating            smallint check (self_rating between 1 and 5),
  created_at             timestamptz not null default now()
);

create index practice_attempts_user_idx  on practice_attempts(user_id);
create index practice_attempts_video_idx on practice_attempts(youtube_video_id, segment_index);

alter table practice_attempts enable row level security;
create policy "practice_attempts_owner" on practice_attempts for all using (auth.uid() = user_id);
A row is written only when the learner saves (mirrors "do not automatically store every failed attempt" — unlike attempt_logs, which logs every dictation submission, this table intentionally does not).

Storage RLS policies (bucket-scoped, folder-based ownership check — same idiom as any per-user Supabase Storage setup):


create policy "practice_recordings_owner_select"
  on storage.objects for select
  using (bucket_id = 'practice-recordings' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "practice_recordings_owner_insert"
  on storage.objects for insert
  with check (bucket_id = 'practice-recordings' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "practice_recordings_owner_delete"
  on storage.objects for delete
  using (bucket_id = 'practice-recordings' and (storage.foldername(name))[1] = auth.uid()::text);
Upload flow: client uploads directly to Storage using the browser (anon-key, RLS-checked) client — no server round-trip needed for the audio bytes themselves — then calls a server route to insert the practice_attempts row (so the DB write can validate mode/segment_index against the video/transcript and use the service-role client for consistency). If the Storage upload succeeds but the DB insert fails, the route deletes the orphaned Storage object before returning an error (explicit cleanup, not a dangling file).

Retention: no automatic deletion for the MVP — a personal app's recording volume is small (a handful of MB per saved sentence, WebM/Opus at ~16–32kbps mono ≈ well under 100KB for a typical sentence). Add a "Storage used: X MB" indicator in Settings and a manual per-recording delete button (removes both the Storage object and the DB row) rather than building automatic-cleanup logic the user didn't ask for.

File size/bitrate: cap MediaRecorder's audioBitsPerSecond around 24–32kbps mono (voice-adequate, keeps files tiny); reject/warn on any Blob over ~2MB (should never happen at a 20s cap and this bitrate, but guards against a runaway recording).

11. Security and privacy
Mic access requested lazily, per-mode, with the browser's native permission prompt; no custom pre-prompt dialog needed beyond the headphone-reminder banner.
A visible recording indicator (red dot + timer) is shown any time MediaRecorder is active, independent of the OS's own mic-in-use indicator.
Recordings are private by default: private bucket, RLS-scoped by auth.uid(), signed URLs only, never a public/anon-readable path.
SUPABASE_SERVICE_ROLE_KEY, AZURE_SPEECH_KEY (new), and GEMINI_API_KEY are read only in Node.js-runtime API routes, never sent to or importable from client bundles — same discipline already enforced for the existing service-role/Gemini usage.
Disclose in-product which processing is local-only vs. sent to a third party: a small "Processed locally" vs. "Sent to Azure/Google for evaluation" tag on each results card, so the learner always knows before pressing Evaluate.
Deletion is real deletion: removing a saved attempt deletes the Storage object and the DB row together (not a soft-delete/orphan).
Failure cleanup: if a Storage upload succeeds but the subsequent DB insert fails (§10), the orphaned object is deleted server-side before the error surfaces to the client, so it's never left instead of a matching row.
No local-only-forever option is offered for saved attempts (saving inherently means uploading), but everything before "Save" — every retried, discarded take — is 100% local and never transmitted anywhere, satisfying a strong default privacy posture for the common case.
12. Phased implementation roadmap
Phase 1 — Repository & architecture prep (Small)
Goal: land the plumbing every later phase depends on, no user-visible change yet.

Extend InputMode to 4 values across types.ts, useInputModePreference.ts (proper switch, not binary), ModeSwitcher.tsx (activate the Shadowing stub, add a Pronunciation Practice entry), ControlBar.tsx/SettingsDrawer.tsx label plumbing.
Add empty ShadowingPanel/PronunciationPanel components wired into DefaultLayout.tsx's stage branch, showing a placeholder.
Risk: touching the shared mode-switch plumbing without breaking Dictation/Listening — mitigate with the existing Jest suite plus manual regression pass on both modes.
Acceptance: switching to Shadowing/Pronunciation via the mode switcher shows a placeholder without any layout jump or video remount.
Phase 2 — Local recording prototype (Medium)
Goal: a standalone useAudioRecorder hook — permission request, MediaRecorder lifecycle, MIME detection/fallback, level meter via Web Audio, Blob-in-memory result.

New: useAudioRecorder.ts, AudioLevelMeter.tsx.
Risks: Safari MIME fallback correctness, permission-denied UX.
Testing: manual across Chrome/Edge/Android Chrome/Safari desktop+iOS.
Acceptance: record/stop/playback works and reports the right MIME/duration on every target browser.
Phase 3 — Shadowing Mode MVP (Medium–Large)
Goal: full flow — play original → countdown → record → compare (playback only, no metrics yet) → retry (local, unlimited).

Files: ShadowingPanel.tsx, useShadowingSession.ts (per-sentence state machine), countdown component.
Depends on: Phase 2.
Testing: full manual flow, mode-switch-during-recording guard, refresh-during-unsaved-attempt behavior.
Acceptance: learner can shadow one sentence repeatedly with zero network calls.
Phase 4 — Local playback & attempt comparison (Medium)
Goal: add Pipeline A metrics — duration/rate/pause/waveform/pitch-contour comparison, current-vs-previous-attempt view (keep the last 1–2 Blobs in memory).

New: audioMetrics.ts (RMS/silence/duration/rate), WaveformCompare.tsx, Meyda/Pitchy integration.
Risk: presenting experimental pitch data misleadingly — mitigate with explicit "experimental" labeling (§14).
Acceptance: metrics visibly update per attempt and are clearly labeled by reliability tier.
Phase 5 — Optional Supabase saving (Medium)
Goal: "Save recording" wired end-to-end — bucket + RLS + practice_attempts table + upload/insert/cleanup flow.

DB/Storage: migration 013_practice_attempts.sql, bucket + policies (§10).
New: /api/practice/save route, ownsPracticeAttempt helper, useSavedAttempts hook, delete action.
Risks: orphaned-object cleanup correctness, upload-retry UX on flaky mobile networks.
Testing: upload success/DB-insert-failure interleaving, delete removes both object and row, storage-usage display accuracy.
Acceptance: a saved attempt survives refresh, plays back via signed URL, and can be deleted cleanly.
Phase 6 — Word Match evaluation (Medium)
Goal: Pipeline B — Web Speech API transcription + checkAnswer/wordDiff alignment, applied to Pronunciation Practice (and optionally surfaced in Shadowing as a bonus, non-primary signal).

New: reuse lib/utils/text.ts as-is; add a thin wordMatch.ts wrapper mapping recognizer output → CheckResult-shaped data for the results UI.
Risk: Safari has no reliable recognizer — must degrade gracefully (§9).
Acceptance: on Chrome/Edge, a read-aloud sentence produces correct/missing/substituted word highlighting matching manual inspection on a handful of test sentences.
Phase 7 — Pronunciation Practice MVP (Large)
Goal: full flow — play original → stop → countdown → record → playback-before-evaluate → Word Match results → retry/save.

Files: PronunciationPanel.tsx, usePronunciationSession.ts, results card components.
Depends on: Phases 2, 5, 6.
Testing: full flow across target browsers, evaluation-failure states, multiple rapid retries.
Acceptance: end-to-end flow works with Word Match as the only "evaluation," honestly labeled, no phoneme/pronunciation claims yet.
Phase 8 — True pronunciation-engine integration (Large, postponable)
Goal: Pipeline C — Azure Pronunciation Assessment wired behind an explicit "Evaluate pronunciation" action.

New: /api/practice/evaluate (Node runtime), ffmpeg conversion step, Azure SDK/REST call, response normalization.
DB: populate pronunciation_result, engine_name, engine_version, eval_status.
Risks: Azure key management, timeout/retry handling, F0-quota exhaustion behavior, ffmpeg binary size within Vercel's function bundle limit.
Testing: evaluation timeout, Azure error responses, quota-exceeded fallback to Word-Match-only.
Acceptance: a saved attempt can be evaluated for accuracy/fluency/completeness/prosody, clearly separated from Word Match in the UI, with graceful failure handling.
Postponable: yes — the product is fully usable and honest without this phase.
Phase 9 — Progress history & analytics (Medium, postponable)
Goal: an "Attempts" view (new RightPanelTabs tab or a dashboard section) listing saved attempts per video/sentence, trend over time.

Files: new tab component, dashboard query.
Postponable: yes.
Phase 10 — Mobile optimization & cross-browser hardening (Medium)
Goal: close out the testing plan (§13) — Safari MediaRecorder quirks, layout stability under mobile-transcript-stage, control-bar space for the Record button on the one-row mobile layout.

Not postponable — required before calling either mode shipped, since this app is explicitly responsive desktop/mobile.
Non-postponable for MVP: Phases 1–7, 10. Postponable: Phases 8 (cloud pronunciation scoring) and 9 (history/analytics) — the product is coherent and honestly labeled without either.

13. Testing plan
Chrome/Edge desktop; Android Chrome; iPhone Safari — each exercising: mic denied, no mic present, recording interrupted (tab backgrounded/minimized mid-record), silent audio, background noise, very short recording (<1s), recording that hits the max-duration cap, headphones vs. speaker leakage (manual/subjective check), network failure mid-upload, evaluation-API timeout, Storage-upload-succeeds-but-DB-insert-fails, deleted/missing recordings (signed URL for a deleted object), switching modes mid-recording, refreshing during an unsaved attempt, multiple rapid retries in a row, and mobile layout stability (no control overlap, no stage resize on sentence change) across the above.

14. Feedback presentation
Sections per attempt, in this order: What you said (recognized text, only if Word Match ran) → Reference sentence → Word Match (always, if any recognizer ran) → Pronunciation / Fluency / Completeness / Rhythm-Prosody (only if Pipeline C actually ran — never a placeholder score) → Words to practise (a filtered list from the diff/error-type data) → playback controls (Original / Yours) → Try again / Save attempt.

Color/threshold discipline: use a 3-tier system (needs-work / getting-there / solid) rather than a precise percentage implying false precision where the engine can't support it; Word-Match-only results should visually look distinct (e.g., a neutral/blue "Word Match" badge) from true Pipeline-C scores (a green/amber/red "Pronunciation" badge), so a learner never mistakes one for the other. Every score card carries a one-line engine-attribution footer ("via your browser's speech recognizer" / "via Azure Pronunciation Assessment") so the source and its limits are always visible, and never present a single blended "overall score" when the underlying engine only supports Word Match — that's exactly the over-authoritative presentation the brief warns against. Avoid "native-accent" framing in copy; describe scores as "clarity/intelligibility" against the reference reading, not correctness against one accent.

15. Estimated recurring costs at personal usage
MVP (Pipelines A + B, browser-only): $0/month — no new infrastructure beyond existing Vercel/Supabase/Upstash usage, which stays within free tiers at personal scale.
Storage: a heavy month of saved recordings (e.g., 200 sentences × ~50–100KB each) is a few MB–tens of MB — negligible against Supabase's free-tier Storage allowance.
Azure F0 tier (Pipeline C, optional): $0/month while under 5 audio-hours/month, which at "one learner, a few dozen sentences/day" is very unlikely to be hit (a few dozen 5-second clips/day ≈ a few minutes/day ≈ well under the monthly cap).
Self-hosted VPS alternative (OpenPronounce/whisper.cpp), if ever chosen instead of Azure: ~$2–7/month (Fly.io/Railway/Render smallest tier) plus real ongoing maintenance time — explicitly not "free" once ops burden is counted honestly, which is why it's not the default recommendation.
16. Open decisions requiring user input
Whether to build the Azure Pronunciation Assessment integration (Phase 8) at all for v1, or ship indefinitely with Word-Match-only Pronunciation Practice.
Whether the rare "Ask AI" Gemini-based transcription fallback for Safari (§9) is worth building given it competes with the existing AI-explanation feature's already-tiny shared daily quota — or whether Safari should simply show "Word Match unavailable" with no fallback.
Exact max recording duration and countdown length (defaults proposed above: 20s cap, 3s countdown) — a product-feel call, not a technical constraint.
Whether "practice a whole section continuously" (Shadowing) is in-scope for the MVP or a Phase 9+ enhancement — it adds meaningful state-machine complexity (§7 flow 9) that could be deferred.
17. Final recommended next step
Start with Phase 1 + Phase 2: land the InputMode plumbing (activating the existing Shadowing stub and adding a Pronunciation Practice one) and a standalone, well-tested useAudioRecorder hook. Both are small, fully reversible, unlock every later phase, and require zero new infrastructure or product decisions — a good point to pause and confirm the UX details in §16 before committing to Phase 3's full Shadowing flow.