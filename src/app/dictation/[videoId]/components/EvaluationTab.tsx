"use client";

import { useMemo, useState } from "react";
import { AlertCircle, Check, ChevronDown, FileText, Loader2, Mic, RotateCcw } from "lucide-react";
import { checkAnswer } from "@/lib/utils/text";
import type { CheckResult } from "@/lib/types";
import type { AudioRecorderStatus, RecordedClip } from "@/hooks/useAudioRecorder";
import { ComparedSentenceText } from "./ComparedSentenceText";
import { EvaluationSessionSummary } from "./EvaluationSessionSummary";
import { MetricGrid } from "./MetricGrid";
import { MetricInfoPopover } from "./MetricInfoPopover";
import { PronunciationReportModal } from "./PronunciationReportModal";
import { WordMatchInfoPopover } from "./WordMatchInfoPopover";
import { buildComparedTokens, formatErrorTypeLabel, summarizeWordMatchDiff, type WordMatchChange } from "../helpers";
import type { ShadowingEvaluationSummary } from "../useShadowingEvaluations";
import type { PracticeQuotaState } from "../usePracticeEvaluation";
import type { SentenceEvaluation, TrueEvaluationResult, TrueEvaluationWord } from "../types";
import {
  deriveEvaluationUiState,
  focusFor,
  formatExpectedHeardLabel,
  formatWeakestSoundLabel,
  scoreTierFor,
  semanticTierFor,
  SEMANTIC_TEXT_CLASS,
  tierLabel,
  weakestSoundFor,
} from "../evaluationFeedback";

/** Every expected token matched with nothing missing/wrong and nothing
 *  extra recognized. */
function isExactMatch(result: CheckResult): boolean {
  return result.diff.length > 0 && result.diff.every((t) => t.status === "correct");
}

const COMPACT_DIFF_LIMIT = 3;

function formatChange(change: WordMatchChange): string {
  if (change.kind === "substitution") return `${change.expected} → ${change.got}`;
  if (change.kind === "missing") return `${change.expected} — Missing`;
  return `${change.got} — Extra`;
}

/** Score/error line shared by the collapsed Word details row and the Focus
 *  card — "Mispronunciation · 41/100", never a bare number. Omits the
 *  score suffix when there isn't one (a break/monotone issue has no
 *  per-word accuracy score attached). */
function ScoreLabel({ errorType, score }: { errorType?: string; score?: number | null }) {
  const parts: string[] = [];
  if (errorType && errorType !== "None") parts.push(formatErrorTypeLabel(errorType));
  if (score !== null && score !== undefined) parts.push(`${Math.round(score)}/100`);
  if (parts.length === 0) return null;
  return <>{parts.join(" · ")}</>;
}

function TrueEvaluationWordRow({ word }: { word: TrueEvaluationWord }) {
  const hasDetail = (word.syllables?.length ?? 0) > 0 || (word.phonemes?.length ?? 0) > 0;
  const weakestSound = weakestSoundFor(word.phonemes);
  const expectedHeard = weakestSound ? formatExpectedHeardLabel(weakestSound) : null;

  const wordHeader = (
    <div>
      <p className="font-medium text-[var(--red)]">{word.word}</p>
      <p className="text-[var(--text-faint)]">
        <ScoreLabel errorType={word.errorType} score={word.accuracyScore} />
      </p>
    </div>
  );

  if (!hasDetail) {
    return (
      <div className="rounded-lg border border-[var(--red)]/25 bg-[var(--red)]/[0.06] px-2 py-1.5 text-xs">
        {wordHeader}
      </div>
    );
  }

  return (
    <details className="group rounded-lg border border-[var(--red)]/25 bg-[var(--red)]/[0.06] px-2 py-1.5 text-xs">
      <summary className="flex cursor-pointer list-none items-start justify-between gap-2 [&::-webkit-details-marker]:hidden">
        {wordHeader}
        <ChevronDown size={12} className="mt-0.5 shrink-0 text-[var(--text-faint)] transition-transform group-open:rotate-180" />
      </summary>
      <div className="mt-1.5 flex flex-col gap-1.5 border-t border-[var(--red)]/20 pt-1.5">
        {weakestSound && <p className="text-[var(--text-faint)]">{formatWeakestSoundLabel(weakestSound)}</p>}
        {word.syllables && word.syllables.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {word.syllables.map((s, i) => (
              <span key={i} className="rounded bg-[var(--surface)] px-1.5 py-0.5 text-[var(--text-muted)]">
                {s.syllable}
                {s.accuracyScore !== null ? ` ${Math.round(s.accuracyScore)}` : ""}
              </span>
            ))}
          </div>
        )}
        {word.phonemes && word.phonemes.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {word.phonemes.map((p, i) => (
              <span key={i} className="rounded bg-[var(--surface)] px-1.5 py-0.5 font-mono text-[var(--text-muted)]">
                {p.phoneme}
                {p.accuracyScore !== null ? ` ${Math.round(p.accuracyScore)}` : ""}
              </span>
            ))}
          </div>
        )}
        {expectedHeard && <p className="text-[var(--text-faint)]">{expectedHeard}</p>}
      </div>
    </details>
  );
}

/** Renders the Pronunciation card's body (header score, metric grid, and —
 *  unless `stale` — the single FOCUS block + Word details disclosure) for
 *  a completed TrueEvaluationResult. Reused both for the live "success"
 *  state and for showing a preserved previous result alongside a failed
 *  retry's error message. */
function PronunciationScoreCard({ result, stale }: { result: TrueEvaluationResult; stale: boolean }) {
  const [showReport, setShowReport] = useState(false);
  const scores = {
    accuracy: result.accuracyScore ?? null,
    fluency: result.fluencyScore ?? null,
    completeness: result.completenessScore ?? null,
    prosody: result.prosodyScore ?? null,
  };
  const focus = focusFor(scores, result.words);
  const tier = result.pronunciationScore !== undefined ? scoreTierFor(result.pronunciationScore) : null;

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-faint)]">
          {stale ? "Previous score" : "Pronunciation"}
        </p>
        {!stale && <MetricInfoPopover />}
      </div>

      {result.pronunciationScore !== undefined && tier && (
        <div className="flex items-baseline gap-2">
          <p className="text-[28px] font-bold leading-none text-[var(--text)]">
            {Math.round(result.pronunciationScore)}
            <span className="text-lg font-semibold text-[var(--text-faint)]">/100</span>
          </p>
          <p className={`text-[15px] font-semibold ${SEMANTIC_TEXT_CLASS[semanticTierFor(result.pronunciationScore)]}`}>
            {tierLabel(tier)}
          </p>
        </div>
      )}

      <MetricGrid
        metrics={[
          { label: "Accuracy", value: scores.accuracy },
          { label: "Fluency", value: scores.fluency },
          { label: "Completeness", value: scores.completeness },
          { label: "Prosody", value: scores.prosody },
        ]}
      />

      {!stale && focus && (
        <div className="flex flex-col gap-1 rounded-lg border border-[var(--accent-border)] bg-[var(--accent-soft)] p-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--accent)]">Focus</p>
          {focus.kind === "word" ? (
            <>
              <p className="text-sm font-semibold text-[var(--text)]">{focus.word}</p>
              <p className="text-xs text-[var(--red)]">
                <ScoreLabel errorType={focus.errorType} score={focus.score} />
              </p>
              {focus.weakestSound ? (
                <>
                  <p className="text-xs text-[var(--text-muted)]">{formatWeakestSoundLabel(focus.weakestSound)}</p>
                  {formatExpectedHeardLabel(focus.weakestSound) && (
                    <p className="text-xs text-[var(--text-muted)]">{formatExpectedHeardLabel(focus.weakestSound)}</p>
                  )}
                </>
              ) : (
                focus.coaching && <p className="text-xs text-[var(--text-muted)]">{focus.coaching}</p>
              )}
            </>
          ) : focus.kind === "metric" ? (
            <>
              <p className="text-sm font-semibold text-[var(--text)]">{focus.title}</p>
              <p className="text-xs text-[var(--text-muted)]">{focus.body}</p>
            </>
          ) : (
            <p className="text-xs text-[var(--text-muted)]">{focus.message}</p>
          )}
        </div>
      )}

      {!stale && result.words && result.words.some((w) => w.errorType !== "None") && (
        <details className="group rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2 text-xs">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 font-semibold text-[var(--text-faint)] [&::-webkit-details-marker]:hidden">
            Word details
            <ChevronDown size={12} className="shrink-0 transition-transform group-open:rotate-180" />
          </summary>
          <div className="mt-1.5 flex flex-col gap-1">
            {result.words
              .filter((w) => w.errorType !== "None")
              .map((w, i) => (
                <TrueEvaluationWordRow key={`${w.word}-${i}`} word={w} />
              ))}
          </div>
        </details>
      )}

      {!stale && (
        <>
          <button
            type="button"
            onClick={() => setShowReport(true)}
            className="flex min-h-[36px] w-fit items-center gap-1.5 rounded-lg px-1.5 text-xs font-semibold text-[var(--accent)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          >
            <FileText size={13} /> Detailed report
          </button>
          <PronunciationReportModal open={showReport} onClose={() => setShowReport(false)} result={result} />
        </>
      )}
    </div>
  );
}

/**
 * Evaluation result surface — presentational only. Word Match and True
 * Evaluation are both driven, stored, and kept alive (across tab switches,
 * sentence changes, and a same-tab refresh) by page.tsx + useShadowingEvaluations;
 * this component just renders whatever `entry` currently holds for the
 * active sentence. Record, Play my recording, and Evaluate/Retry all live
 * on the control bar — this component never triggers a network request.
 */
export function EvaluationTab({
  entry,
  recorderStatus,
  recordingClip,
  autoWordMatchEnabled,
  onRetryWordMatch,
  quota,
  evaluationSummary,
  onJumpToSegment,
}: {
  entry: SentenceEvaluation | undefined;
  recorderStatus: AudioRecorderStatus;
  recordingClip: RecordedClip | null;
  autoWordMatchEnabled: boolean;
  onRetryWordMatch: () => void;
  quota: PracticeQuotaState;
  evaluationSummary: ShadowingEvaluationSummary;
  onJumpToSegment: (segmentIndex: number) => void;
}) {
  const isRecording = recorderStatus === "recording" || recorderStatus === "requesting-permission";
  const hasClip = !!recordingClip;

  const wordMatch = entry?.wordMatch;
  const trueEvaluation = entry?.trueEvaluation;
  const lastSuccessful = entry?.lastSuccessfulTrueEvaluation;

  // The persisted WordMatchResult intentionally only keeps recognizedText +
  // derived numbers (not the full diff) — the word-by-word comparison view
  // is cheap to recompute deterministically from referenceText +
  // recognizedText rather than persisting a redundant, larger structure.
  const wordMatchCheck = useMemo(() => {
    if (!entry || !wordMatch || wordMatch.status !== "completed") return null;
    return checkAnswer(entry.referenceText, wordMatch.recognizedText ?? "", "relaxed");
  }, [entry, wordMatch]);

  const exactMatch = wordMatchCheck ? isExactMatch(wordMatchCheck) : false;
  const wordMatchChanges = wordMatchCheck ? summarizeWordMatchDiff(wordMatchCheck.diff) : [];
  const noSpeechDetected = wordMatchCheck && wordMatchCheck.normalizedUser.length === 0;

  // Word Match diff detail always starts collapsed (a compact "crop → grub"
  // line + Details toggle instead), regardless of exact/mismatched — a
  // manual toggle always wins until a genuinely new recognized result
  // arrives (a new recording), which resets it. Reset happens during
  // render (React's documented pattern for "adjusting state when a prop
  // changes") rather than in an effect.
  const [wordMatchExpandedOverride, setWordMatchExpandedOverride] = useState(false);
  const [lastSeenRecognizedText, setLastSeenRecognizedText] = useState(wordMatch?.recognizedText);
  if (wordMatch?.recognizedText !== lastSeenRecognizedText) {
    setLastSeenRecognizedText(wordMatch?.recognizedText);
    setWordMatchExpandedOverride(false);
  }

  const { expectedTokens, userTokens } = wordMatchCheck
    ? buildComparedTokens({
        diff: wordMatchCheck.diff,
        expectedText: wordMatchCheck.normalizedExpected,
        userText: wordMatchCheck.normalizedUser,
      })
    : { expectedTokens: [], userTokens: [] };

  const evaluationUiState = deriveEvaluationUiState({
    hasClip,
    recordingClipId: recordingClip?.url ?? null,
    trueEvaluation,
    lastSuccessful,
  });

  return (
    <div className="flex flex-1 flex-col gap-3">
      {!hasClip ? (
        <div className="flex flex-col items-center justify-center gap-2 px-4 py-8 text-center">
          <Mic size={26} className="text-[var(--text-faint)]" />
          <p className="text-sm font-semibold text-[var(--text)]">No recording yet</p>
          <p className="max-w-[26ch] text-xs text-[var(--text-muted)]">
            Record a take below — Word Match runs automatically, and you can request a Pronunciation Assessment once
            you have a recording.
          </p>
        </div>
      ) : (
        <>
          {/* ---- Word Match ---- */}
          {!autoWordMatchEnabled ? (
            <div className="flex items-start gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-2.5 text-xs text-[var(--text-muted)]">
              <AlertCircle size={14} className="mt-0.5 shrink-0 text-[var(--text-faint)]" />
              <p>Automatic Word Match is turned off. Turn it back on in Settings to see a result after recording.</p>
            </div>
          ) : wordMatch?.status === "unsupported" ? (
            <div className="flex items-start gap-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-2.5 text-xs text-[var(--text-muted)]">
              <AlertCircle size={14} className="mt-0.5 shrink-0 text-[var(--text-faint)]" />
              <p>Automatic Word Match is not available in this browser. Try Chrome, Edge, or Android Chrome.</p>
            </div>
          ) : wordMatch?.status === "processing" ? (
            <div className="flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-2.5 text-xs text-[var(--text-muted)]">
              <Loader2 size={14} className="shrink-0 animate-spin text-[var(--text-faint)]" />
              <p>Checking words…</p>
            </div>
          ) : wordMatch?.status === "failed" ? (
            <div className="flex flex-col gap-2 rounded-xl border border-[var(--red)]/25 bg-[var(--red)]/[0.08] p-2.5 text-xs">
              <p className="flex items-center gap-1.5 text-[var(--red)]">
                <AlertCircle size={12} className="shrink-0" />
                {wordMatch.error ?? "Couldn't access speech recognition for this take."}
              </p>
              <button
                type="button"
                onClick={onRetryWordMatch}
                disabled={isRecording}
                className="flex min-h-[36px] w-fit items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 text-xs font-semibold text-[var(--text)] transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <RotateCcw size={12} /> Retry Word Match
              </button>
            </div>
          ) : wordMatch?.status === "completed" && wordMatchCheck ? (
            <div className="flex flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-2.5">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5">
                  <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-faint)]">Word Match</p>
                  <WordMatchInfoPopover />
                </span>
                {exactMatch ? (
                  <span className="flex items-center gap-1 rounded-full border border-[var(--green)]/30 bg-[var(--green)]/15 px-2 py-0.5 text-xs font-bold text-[var(--green)]">
                    <Check size={11} /> Exact match
                  </span>
                ) : (
                  <span className="text-xs font-semibold text-[var(--text-muted)]">
                    {wordMatchChanges.length} difference{wordMatchChanges.length !== 1 ? "s" : ""}
                  </span>
                )}
              </div>

              {noSpeechDetected ? (
                <p className="text-xs text-[var(--text-muted)]">No speech was recognized. Try recording again.</p>
              ) : exactMatch ? null : !wordMatchExpandedOverride ? (
                <div className="flex items-center justify-between gap-2">
                  <p className="min-w-0 flex-1 truncate text-xs text-[var(--text-muted)]">
                    {wordMatchChanges
                      .slice(0, COMPACT_DIFF_LIMIT)
                      .map(formatChange)
                      .join(", ")}
                    {wordMatchChanges.length > COMPACT_DIFF_LIMIT
                      ? `, +${wordMatchChanges.length - COMPACT_DIFF_LIMIT} more`
                      : ""}
                  </p>
                  <button
                    type="button"
                    onClick={() => setWordMatchExpandedOverride(true)}
                    className="flex min-h-[36px] shrink-0 items-center rounded-lg px-2 text-xs font-semibold text-[var(--accent)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                  >
                    Details ›
                  </button>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <div className="rounded-lg border border-[var(--green)]/25 bg-[var(--green)]/[0.08] p-2 text-xs">
                    <p className="text-xs font-semibold text-[var(--green)]">Script</p>
                    <ComparedSentenceText tokens={expectedTokens} tone="expected" />
                  </div>
                  <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2 text-xs">
                    <p className="text-xs font-semibold text-[var(--text-faint)]">What we heard</p>
                    <ComparedSentenceText tokens={userTokens} tone="user" emptyFallback="(nothing recognized)" />
                  </div>
                  <p className="text-xs text-[var(--text-faint)]">
                    Word Match — your browser&apos;s speech recognition, compared against the script. Not a
                    pronunciation score.
                  </p>
                  <button
                    type="button"
                    onClick={() => setWordMatchExpandedOverride(false)}
                    className="flex min-h-[36px] w-fit items-center rounded-lg px-1.5 text-xs font-semibold text-[var(--accent)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                  >
                    Hide
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-2.5 text-xs text-[var(--text-muted)]">
              <Loader2 size={14} className="shrink-0 animate-spin text-[var(--text-faint)]" />
              <p>Checking words…</p>
            </div>
          )}

          {/* ---- Pronunciation (Azure) ---- */}
          {quota.engineConfigured && (
            <div className="flex flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-2.5">
              {/* PronunciationScoreCard renders its own "Pronunciation"/
                  "Previous score" header (with the info popover) once a
                  score card is shown — this header only covers the states
                  that precede any score card. */}
              {evaluationUiState !== "success" && !(evaluationUiState === "error" && lastSuccessful) && (
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-faint)]">
                    Pronunciation
                  </p>
                  <MetricInfoPopover />
                </div>
              )}

              {quota.limitReached &&
              evaluationUiState !== "success" &&
              !(evaluationUiState === "error" && lastSuccessful) ? (
                <div className="flex items-start gap-1.5 rounded-lg border border-[var(--red)]/25 bg-[var(--red)]/[0.08] p-2 text-xs text-[var(--red)]">
                  <AlertCircle size={13} className="mt-0.5 shrink-0" />
                  <p>
                    Monthly free evaluation limit reached.
                    <br />
                    You can still record and listen to your voice.
                  </p>
                </div>
              ) : (
                <>
                  {evaluationUiState === "recording-ready" && (
                    <p className="text-xs text-[var(--text-muted)]">
                      Press <span className="font-semibold text-[var(--text)]">Evaluate</span> on the control bar to
                      score your pronunciation.
                    </p>
                  )}

                  {evaluationUiState === "new-recording-not-evaluated" && lastSuccessful && (
                    <div className="flex flex-col gap-1">
                      <p className="text-xs font-medium text-[var(--text)]">New recording ready for evaluation</p>
                      {lastSuccessful.pronunciationScore !== undefined && (
                        <p className="text-xs text-[var(--text-faint)]">
                          Previous score: {Math.round(lastSuccessful.pronunciationScore)}
                        </p>
                      )}
                    </div>
                  )}

                  {evaluationUiState === "evaluating" && (
                    <p className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
                      <Loader2 size={14} className="shrink-0 animate-spin text-[var(--text-faint)]" />
                      Evaluating pronunciation…
                    </p>
                  )}

                  {evaluationUiState === "error" && (
                    <>
                      {lastSuccessful && (
                        <PronunciationScoreCard
                          result={lastSuccessful}
                          stale={lastSuccessful.clipId !== (recordingClip?.url ?? null)}
                        />
                      )}
                      <p className="flex items-center gap-1.5 text-xs text-[var(--red)]">
                        <AlertCircle size={12} className="shrink-0" /> {trueEvaluation?.error}
                      </p>
                      {trueEvaluation?.status !== "unavailable" && (
                        <p className="text-xs text-[var(--text-faint)]">
                          Press <span className="font-semibold text-[var(--text)]">Retry</span> on the control bar to
                          try again.
                        </p>
                      )}
                    </>
                  )}

                  {evaluationUiState === "success" && trueEvaluation && (
                    <PronunciationScoreCard result={trueEvaluation} stale={false} />
                  )}
                </>
              )}
            </div>
          )}
        </>
      )}

      {evaluationSummary.evaluatedCount > 1 && (
        <EvaluationSessionSummary summary={evaluationSummary} onJumpToSegment={onJumpToSegment} />
      )}
    </div>
  );
}
