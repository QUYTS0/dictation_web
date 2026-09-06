"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Copy, X } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { formatErrorTypeLabel } from "../helpers";
import {
  currentSentenceProblemWords,
  findWord,
  formatExpectedHeardLabel,
  formatWeakestSoundLabel,
  formatWeakestSyllableLabel,
  scoreTierFor,
  semanticTierFor,
  SEMANTIC_TEXT_CLASS,
  tierLabel,
  weakestSoundFor,
  weakestSyllableFor,
} from "../evaluationFeedback";
import type { TrueEvaluationResult, TrueEvaluationWord } from "../types";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

function ScoreRow({ label, value }: { label: string; value: number | undefined }) {
  if (value === undefined) return null;
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm">
      <span className="text-[var(--text-muted)]">{label}</span>
      <span className="font-semibold tabular-nums text-[var(--text)]">{Math.round(value)}/100</span>
    </div>
  );
}

/** Every evaluated word's full diagnostic breakdown — Offset/Duration are
 *  deliberately never rendered here (or anywhere in this report outside
 *  Raw Azure response): they're implementation timing, not learning
 *  feedback. The fields stay on the data for a possible future "replay
 *  this exact audio segment" feature — see helpers.ts's formatAzureDuration
 *  and the ticks already stored on TrueEvaluationWord/Syllable/Phoneme. */
function WordAnalysisRow({ word }: { word: TrueEvaluationWord }) {
  const hasError = word.errorType && word.errorType !== "None";
  const hasDetail = (word.syllables?.length ?? 0) > 0 || (word.phonemes?.length ?? 0) > 0;
  const weakestSyllable = weakestSyllableFor(word.syllables);
  const weakestSound = weakestSoundFor(word.phonemes);
  const expectedHeard = weakestSound ? formatExpectedHeardLabel(weakestSound) : null;

  const header = (
    <div className="flex flex-1 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <span className={`font-medium ${hasError ? "text-[var(--red)]" : "text-[var(--text)]"}`}>{word.word}</span>
      <span className="flex flex-wrap items-center gap-x-2 text-xs text-[var(--text-faint)]">
        {word.accuracyScore !== null && word.accuracyScore !== undefined && (
          <span className="font-semibold tabular-nums text-[var(--text-muted)]">
            {Math.round(word.accuracyScore)}/100
          </span>
        )}
        {hasError && <span>{formatErrorTypeLabel(word.errorType)}</span>}
      </span>
    </div>
  );

  if (!hasDetail) {
    return <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm">{header}</div>;
  }

  return (
    <details className="group rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm">
      <summary className="flex cursor-pointer list-none items-start gap-2 [&::-webkit-details-marker]:hidden">
        {header}
        <ChevronDown size={14} className="mt-1 shrink-0 text-[var(--text-faint)] transition-transform group-open:rotate-180" />
      </summary>
      <div className="mt-2 flex flex-col gap-3 border-t border-[var(--border)] pt-2 text-xs">
        {(weakestSyllable || weakestSound) && (
          <div className="flex flex-col gap-0.5 text-[var(--text-muted)]">
            {weakestSyllable && <p>{formatWeakestSyllableLabel(weakestSyllable)}</p>}
            {weakestSound && <p>{formatWeakestSoundLabel(weakestSound)}</p>}
          </div>
        )}
        {word.syllables && word.syllables.length > 0 && (
          <div>
            <p className="mb-1 font-semibold uppercase tracking-wide text-[var(--text-faint)]">Syllables</p>
            <div className="flex flex-col gap-1">
              {word.syllables.map((s, i) => (
                <div key={i} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                  <span className="font-mono text-[var(--text)]">
                    {s.grapheme ? `${s.grapheme} · ` : ""}/{s.syllable}/
                  </span>
                  {s.accuracyScore !== null && s.accuracyScore !== undefined && (
                    <span className="font-semibold tabular-nums text-[var(--text-muted)]">
                      {Math.round(s.accuracyScore)}/100
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
        {word.phonemes && word.phonemes.length > 0 && (
          <div>
            <p className="mb-1 font-semibold uppercase tracking-wide text-[var(--text-faint)]">Phonemes</p>
            <div className="flex flex-col gap-1">
              {word.phonemes.map((p, i) => (
                <div key={i} className="flex flex-col gap-0.5">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                    <span className="font-mono text-[var(--text)]">/{p.phoneme}/</span>
                    {p.accuracyScore !== null && p.accuracyScore !== undefined && (
                      <span className="font-semibold tabular-nums text-[var(--text-muted)]">
                        {Math.round(p.accuracyScore)}/100
                      </span>
                    )}
                  </div>
                  {p.nBestPhonemes && p.nBestPhonemes.length > 0 && (
                    <details className="group/candidates">
                      <summary className="cursor-pointer list-none text-[var(--text-faint)] hover:text-[var(--text-muted)] [&::-webkit-details-marker]:hidden">
                        Advanced phoneme candidates
                      </summary>
                      <p className="mt-1 pl-2 text-[var(--text-faint)]">
                        {p.nBestPhonemes.map((c, ci) => (
                          <span key={ci} className="font-mono">
                            {ci + 1}. /{c.phoneme}/ {Math.round(c.score)}
                            {ci < p.nBestPhonemes!.length - 1 ? ", " : ""}
                          </span>
                        ))}
                      </p>
                    </details>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
        {expectedHeard && <p className="text-[var(--text-muted)]">{expectedHeard}</p>}
      </div>
    </details>
  );
}

/**
 * Answers "what should I practice first?" — the ranked, actionable summary
 * that sits right after Overview, before the full per-word breakdown.
 * Reuses the same currentSentenceProblemWords ranking as the right panel's
 * Focus card (weakest-first, deduped) so the two surfaces never disagree
 * about which words are the problem, just how much detail they show.
 */
function WhatToImproveSection({ words }: { words: TrueEvaluationWord[] }) {
  const problems = currentSentenceProblemWords(words);
  if (problems.length === 0) return null;

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-faint)]">What to improve</h3>
      <ol className="flex flex-col gap-2">
        {problems.map((p, i) => {
          const wordObj = findWord(words, p.word);
          const weakestSyllable = weakestSyllableFor(wordObj?.syllables);
          const weakestSound = weakestSoundFor(wordObj?.phonemes);
          const expectedHeard = weakestSound ? formatExpectedHeardLabel(weakestSound) : null;
          return (
            <li key={p.word} className="rounded-lg border border-[var(--red)]/25 bg-[var(--red)]/[0.06] px-3 py-2 text-sm">
              <p className="font-medium text-[var(--red)]">
                {i + 1}. {p.word} · {Math.round(p.score)}/100
              </p>
              <div className="mt-0.5 flex flex-col gap-0.5 text-xs text-[var(--text-muted)]">
                {weakestSyllable && <p>{formatWeakestSyllableLabel(weakestSyllable)}</p>}
                {weakestSound && <p>{formatWeakestSoundLabel(weakestSound)}</p>}
                {expectedHeard && <p>{expectedHeard}</p>}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** Secondary/advanced diagnostics that don't belong in the main learner
 *  flow — currently just prosody (break/intonation) feedback per word.
 *  Per-phoneme NBest candidates live inline in Word analysis instead (each
 *  phoneme's own "Advanced phoneme candidates" disclosure), since they're
 *  naturally scoped to that phoneme rather than the whole sentence. */
function AdvancedDetailsSection({ words }: { words: TrueEvaluationWord[] }) {
  const flagged = words.filter((w) => w.prosodyFeedback?.breakErrorType || w.prosodyFeedback?.intonationErrorType);
  if (flagged.length === 0) return null;

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-faint)]">Advanced pronunciation details</h3>
      <div className="flex flex-col gap-1.5">
        {flagged.map((w, i) => (
          <div key={i} className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm">
            <p className="font-medium text-[var(--text)]">{w.word}</p>
            <p className="text-xs text-[var(--text-muted)]">
              {w.prosodyFeedback?.breakErrorType && (
                <span>
                  {formatErrorTypeLabel(w.prosodyFeedback.breakErrorType)}
                  {w.prosodyFeedback.breakConfidence !== undefined &&
                    ` (confidence ${w.prosodyFeedback.breakConfidence.toFixed(2)})`}
                </span>
              )}
              {w.prosodyFeedback?.breakErrorType && w.prosodyFeedback?.intonationErrorType && " · "}
              {w.prosodyFeedback?.intonationErrorType && (
                <span>
                  {formatErrorTypeLabel(w.prosodyFeedback.intonationErrorType)}
                  {w.prosodyFeedback.monotoneConfidence !== undefined &&
                    ` (confidence ${w.prosodyFeedback.monotoneConfidence.toFixed(2)})`}
                </span>
              )}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

function RawResponseSection({ rawResult }: { rawResult: Record<string, unknown> }) {
  const [copied, setCopied] = useState(false);
  const json = JSON.stringify(rawResult, null, 2);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied — the JSON is still visible/selectable below.
    }
  };

  return (
    <details className="group rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3 text-sm">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 font-semibold text-[var(--text-faint)] [&::-webkit-details-marker]:hidden">
        Raw Azure response
        <ChevronDown size={14} className="shrink-0 transition-transform group-open:rotate-180" />
      </summary>
      <div className="mt-2 flex flex-col gap-2">
        <button
          type="button"
          onClick={handleCopy}
          className="flex min-h-[32px] w-fit items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 text-xs font-semibold text-[var(--text)] hover:bg-white/10"
        >
          <Copy size={12} /> {copied ? "Copied" : "Copy JSON"}
        </button>
        <pre className="max-h-80 overflow-auto rounded-lg bg-[var(--surface)] p-2.5 font-mono text-[11px] leading-relaxed text-[var(--text-muted)]">
          {json}
        </pre>
      </div>
    </details>
  );
}

/**
 * The Level-2 diagnostic breakdown behind "Detailed report" — the compact
 * Evaluate panel only ever shows a summary (headline score, secondary
 * scores, one Focus issue); everything Azure actually returned lives here
 * instead, translated into a readable hierarchy (Overview → What to improve
 * → Word analysis → Advanced pronunciation details → Raw Azure response),
 * never inline in the main panel. Offset/Duration are intentionally never
 * rendered prominently anywhere in this hierarchy — see WordAnalysisRow's
 * own doc comment — only inside Raw Azure response.
 *
 * Rendered via a React portal directly into `document.body` — NOT as a
 * normal in-place child. This component is used from deep inside the right
 * panel, which page.tsx animates with Framer Motion's `x` motion value
 * (see the `motion.div ref={rightPanelRef}` wrapper around RightPanelTabs).
 * Framer Motion keeps that transform applied via inline style even at rest
 * (`translateX(0px)`), and any non-none `transform` on an ancestor becomes
 * the containing block for every `position: fixed` descendant — so without
 * the portal, this modal's `inset`/centering resolves against that narrow
 * right-panel box instead of the viewport, and gets visually confined to
 * (and clipped by) the sidebar. Portaling to `document.body` sidesteps that
 * ancestor entirely, matching the app's SettingsDrawer/MobileBottomSheet
 * dialog z-index layer (backdrop z-[70], panel z-[75]) but escaping every
 * stacking/containing-block context inside the practice page.
 *
 * Desktop: a centered card (see PANEL_SIZE_CLASS). Mobile: a true
 * full-screen sheet (100dvh, safe-area aware), not just a narrower card —
 * this content is long tables/JSON, not a handful of toggles. The header is
 * a non-scrolling flex sibling above the scrollable content (rather than
 * `position: sticky`), so the close button can never be scrolled away.
 * Every section is omitted (not shown empty) when the corresponding data is
 * absent, so an older stored evaluation (missing these fields entirely)
 * still opens without error, just with fewer sections.
 */
// Deliberately no backdrop-blur (or any other filter/opacity) here — this
// is the Dialog surface, not the Backdrop, and must stay 100% opaque. A
// `backdrop-filter` on this element previously let the YouTube iframe
// behind it bleed through despite the solid --surface background: iframes
// get their own compositing layer, and Chromium doesn't reliably composite
// backdrop-filter over that layer the way it does over ordinary painted
// content, even when the element's own background-color has alpha=1. See
// the Backdrop layer below for the (intentionally translucent) dimming.
const PANEL_SIZE_CLASS =
  "fixed inset-0 z-[75] flex flex-col overflow-hidden bg-[var(--surface)] text-[var(--text)] sm:inset-0 sm:m-auto sm:h-[min(85vh,850px)] sm:w-[min(900px,calc(100vw-64px))] sm:max-w-[1000px] sm:rounded-3xl sm:border sm:border-[var(--border)] sm:shadow-2xl";

export function PronunciationReportModal({
  open,
  onClose,
  result,
}: {
  open: boolean;
  onClose: () => void;
  result: TrueEvaluationResult;
}) {
  const [mounted, setMounted] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  // The portal target (document.body) only exists client-side — this flips
  // true on the first client render so the initial server-rendered markup
  // never tries to portal (avoids a hydration mismatch), matching the
  // standard SSR-safe portal pattern.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, []);

  // The whole point of this modal is a page-level overlay — the underlying
  // practice page (video, script, control bar) must not scroll behind it.
  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    const firstFocusable = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    firstFocusable?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;

      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      previouslyFocusedRef.current?.focus?.();
    };
  }, [open, onClose]);

  const words = result.words ?? [];

  if (!mounted) return null;

  return createPortal(
    // The `player-dark-theme` class carries the --surface/--text/--border/etc.
    // custom properties this component's Tailwind arbitrary-value classes
    // (bg-[var(--surface)], text-[var(--text)], ...) all depend on — it's
    // normally provided by an ancestor further up the practice page (see
    // player-theme.css: "scoped under this class so it never leaks into the
    // rest of the app"). Portaling to document.body moves this subtree
    // outside that ancestor, so those variables would otherwise be
    // undefined and every background using one of these tokens would
    // resolve to its CSS initial value (transparent) — which is what
    // actually caused the video to show through the "opaque" surface, not
    // backdrop-filter. Re-declaring
    // the class here gives the portalled subtree its own copy of the same
    // tokens, independent of where in the DOM it landed.
    <div className="player-dark-theme">
      <AnimatePresence>
        {open && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="fixed inset-0 z-[70] bg-black/70 backdrop-blur-sm"
              onClick={onClose}
            />
            <motion.div
              ref={panelRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby="pronunciation-report-title"
              initial={{ opacity: 0, y: 12, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 12, scale: 0.98 }}
              transition={{ type: "tween", ease: "easeOut", duration: 0.2 }}
              className={PANEL_SIZE_CLASS}
            >
              {/* Header is a non-scrolling flex sibling above the scrollable
                  content below — not `position: sticky` — so the close
                  button can never end up scrolled out of view (acceptance:
                  header stays accessible while scrolling). */}
              <div className="flex shrink-0 items-center justify-between border-b border-[var(--border)] bg-[var(--surface)] px-5 pb-3 pt-[max(1rem,env(safe-area-inset-top))] sm:pt-5">
                <h2 id="pronunciation-report-title" className="text-sm font-semibold text-[var(--text)]">
                  Detailed report
                </h2>
                <button
                  type="button"
                  onClick={onClose}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-white/10"
                  aria-label="Close detailed report"
                >
                  <X size={16} />
                </button>
              </div>

              <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
                <section className="flex flex-col gap-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-faint)]">Overview</h3>
                  {result.pronunciationScore !== undefined && (
                    <p className="text-sm font-semibold text-[var(--text)]">
                      {Math.round(result.pronunciationScore)}/100 ·{" "}
                      <span className={SEMANTIC_TEXT_CLASS[semanticTierFor(result.pronunciationScore)]}>
                        {tierLabel(scoreTierFor(result.pronunciationScore))}
                      </span>
                    </p>
                  )}
                  <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                    <ScoreRow label="Accuracy" value={result.accuracyScore} />
                    <ScoreRow label="Fluency" value={result.fluencyScore} />
                    <ScoreRow label="Completeness" value={result.completenessScore} />
                    <ScoreRow label="Prosody" value={result.prosodyScore} />
                  </div>
                </section>

                <WhatToImproveSection words={words} />

                {words.length > 0 && (
                  <section className="flex flex-col gap-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-faint)]">Word analysis</h3>
                    <div className="flex flex-col gap-1.5">
                      {words.map((w, i) => (
                        <WordAnalysisRow key={`${w.word}-${i}`} word={w} />
                      ))}
                    </div>
                  </section>
                )}

                <AdvancedDetailsSection words={words} />

                {result.rawAzureResult && <RawResponseSection rawResult={result.rawAzureResult} />}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>,
    document.body
  );
}
