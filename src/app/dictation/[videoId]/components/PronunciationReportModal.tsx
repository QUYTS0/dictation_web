"use client";

import { useState } from "react";
import { ChevronDown, Copy } from "lucide-react";
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
import { ReportDialogShell } from "./ReportDialogShell";

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
 * The portal/focus-trap/backdrop-opacity chrome lives in ReportDialogShell
 * (shared with VideoPracticeSummaryModal) — see that file's doc comment for
 * why this must be a portal at all. Every section here is omitted (not
 * shown empty) when the corresponding data is absent, so an older stored
 * evaluation (missing these fields entirely) still opens without error,
 * just with fewer sections.
 */
export function PronunciationReportModal({
  open,
  onClose,
  result,
}: {
  open: boolean;
  onClose: () => void;
  result: TrueEvaluationResult;
}) {
  const words = result.words ?? [];

  return (
    <ReportDialogShell open={open} onClose={onClose} titleId="pronunciation-report-title" title="Detailed report">
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
    </ReportDialogShell>
  );
}
