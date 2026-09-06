"use client";

import { useMemo, useState } from "react";
import { AlertCircle, Check, ChevronDown, Gauge, Loader2, Mic, RotateCcw } from "lucide-react";
import { checkAnswer } from "@/lib/utils/text";
import type { CheckResult } from "@/lib/types";
import type { AudioRecorderStatus, RecordedClip } from "@/hooks/useAudioRecorder";
import { ComparedSentenceText } from "./ComparedSentenceText";
import { EvaluationSessionSummary } from "./EvaluationSessionSummary";
import { MetricBar } from "./MetricBar";
import { MetricInfoPopover } from "./MetricInfoPopover";
import { buildComparedTokens } from "../helpers";
import type { ShadowingEvaluationSummary } from "../useShadowingEvaluations";
import type { PracticeQuotaState } from "../usePracticeEvaluation";
import type { SentenceEvaluation, TrueEvaluationResult, TrueEvaluationWord } from "../types";
import {
  currentSentenceProblemWords,
  deriveEvaluationUiState,
  feedbackFor,
  scoreTierFor,
  tierLabel,
  weakestMetric,
} from "../evaluationFeedback";

type MatchTier = "needs-work" | "getting-there" | "solid";

const TIER_LABEL: Record<MatchTier, string> = {
  "needs-work": "Needs work",
  "getting-there": "Getting there",
  solid: "Solid",
};

const TIER_CLASS: Record<MatchTier, string> = {
  "needs-work": "bg-[var(--red)]/15 text-[var(--red)] border-[var(--red)]/30",
  "getting-there": "bg-[var(--accent-soft)] text-[var(--accent)] border-[var(--accent-border)]",
  solid: "bg-[var(--green)]/15 text-[var(--green)] border-[var(--green)]/30",
};

function tierFor(result: CheckResult): MatchTier {
  const expectedCount = result.diff.filter((t) => t.status !== "extra").length;
  const correctCount = result.diff.filter((t) => t.status === "correct").length;
  const ratio = expectedCount > 0 ? correctCount / expectedCount : 0;
  if (ratio >= 0.85) return "solid";
  if (ratio >= 0.5) return "getting-there";
  return "needs-work";
}

/** Every expected token matched with nothing missing/wrong and nothing
 *  extra recognized — a stricter bar than the "solid" tier (which allows up
 *  to 15% mismatch), used to decide whether the diff view can start
 *  collapsed. */
function isExactMatch(result: CheckResult): boolean {
  return result.diff.length > 0 && result.diff.every((t) => t.status === "correct");
}

/** Compact "{h}h {m}m"/"{m}m {ss}s"/"{s}s" duration, e.g. 18000 -> "5h",
 *  188 -> "3m 08s". Used for both the used and limit halves of the Azure
 *  usage line so "3m 08s / 5h" reads as one consistent unit system. */
function formatCompactDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    const remSeconds = seconds % 60;
    return remSeconds === 0 ? `${minutes}m` : `${minutes}m ${remSeconds.toString().padStart(2, "0")}s`;
  }
  const hours = Math.floor(seconds / 3600);
  const remMinutes = Math.floor((seconds % 3600) / 60);
  return remMinutes === 0 ? `${hours}h` : `${hours}h ${remMinutes}m`;
}

function formatErrorType(errorType: string): string {
  return errorType.replace(/([A-Z])/g, " $1").trim();
}

function TrueEvaluationWordRow({ word }: { word: TrueEvaluationWord }) {
  const hasDetail = (word.syllables?.length ?? 0) > 0 || (word.phonemes?.length ?? 0) > 0;

  const summaryContent = (
    <summary className="flex cursor-pointer list-none items-center justify-between gap-2 [&::-webkit-details-marker]:hidden">
      <span className="font-medium text-[var(--red)]">{word.word}</span>
      <span className="flex items-center gap-1.5 text-[var(--text-faint)]">
        {word.errorType && word.errorType !== "None" && <span>{formatErrorType(word.errorType)}</span>}
        {word.accuracyScore !== null && (
          <span className="font-semibold text-[var(--red)]">{Math.round(word.accuracyScore)}</span>
        )}
        {hasDetail && <ChevronDown size={12} className="shrink-0 transition-transform group-open:rotate-180" />}
      </span>
    </summary>
  );

  if (!hasDetail) {
    return (
      <div className="rounded-lg border border-[var(--red)]/25 bg-[var(--red)]/[0.06] px-2 py-1.5 text-[11px]">
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium text-[var(--red)]">{word.word}</span>
          <span className="flex items-center gap-1.5 text-[var(--text-faint)]">
            {word.errorType && word.errorType !== "None" && <span>{formatErrorType(word.errorType)}</span>}
            {word.accuracyScore !== null && (
              <span className="font-semibold text-[var(--red)]">{Math.round(word.accuracyScore)}</span>
            )}
          </span>
        </div>
      </div>
    );
  }

  return (
    <details className="group rounded-lg border border-[var(--red)]/25 bg-[var(--red)]/[0.06] px-2 py-1.5 text-[11px]">
      {summaryContent}
      <div className="mt-1.5 flex flex-col gap-1 border-t border-[var(--red)]/20 pt-1.5">
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
      </div>
    </details>
  );
}

/** Renders the full score card (headline + bars + feedback + words to
 *  improve) for a completed TrueEvaluationResult — reused both for the
 *  live "success" state and for showing a preserved previous result
 *  alongside a failed retry's error message. */
function PronunciationScoreCard({ result, stale }: { result: TrueEvaluationResult; stale: boolean }) {
  const scores = {
    accuracy: result.accuracyScore ?? null,
    fluency: result.fluencyScore ?? null,
    completeness: result.completenessScore ?? null,
    prosody: result.prosodyScore ?? null,
  };
  const weakest = weakestMetric(scores);
  const feedback = feedbackFor(scores, weakest);
  const problemWords = currentSentenceProblemWords(result.words);
  const tier = result.pronunciationScore !== undefined ? scoreTierFor(result.pronunciationScore) : null;

  return (
    <div className="flex flex-col gap-2.5">
      {stale && (
        <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-faint)]">Previous score</p>
      )}
      {result.pronunciationScore !== undefined && tier && (
        <div className="flex items-baseline gap-2">
          <span className="text-3xl font-bold leading-none text-[var(--accent)]">
            {Math.round(result.pronunciationScore)}
          </span>
          <span className="text-sm font-medium text-[var(--text-faint)]">/ 100</span>
          <span className="text-xs font-semibold text-[var(--text-muted)]">{tierLabel(tier)}</span>
        </div>
      )}
      <div className="flex flex-col gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2">
        <MetricBar label="Accuracy" value={scores.accuracy} />
        <MetricBar label="Fluency" value={scores.fluency} />
        <MetricBar label="Completeness" value={scores.completeness} />
        <MetricBar label="Prosody" value={scores.prosody} />
      </div>
      {[scores.accuracy, scores.fluency, scores.completeness, scores.prosody].some((v) => v === null) && (
        <p className="text-[10px] text-[var(--text-faint)]">
          Some metrics may be unavailable depending on locale, configuration, and pricing tier.
        </p>
      )}

      {feedback && !stale && (
        <div className="rounded-lg border border-[var(--accent-border)] bg-[var(--accent-soft)] p-2">
          <p className="text-xs font-semibold text-[var(--accent)]">{feedback.title}</p>
          <p className="text-[11px] text-[var(--text-muted)]">{feedback.body}</p>
        </div>
      )}

      {!stale && (
        <div className="flex flex-col gap-1.5">
          <p className="text-[11px] font-semibold text-[var(--text-faint)]">Words to improve</p>
          {problemWords.length === 0 ? (
            <p className="text-[11px] text-[var(--text-faint)]">No major pronunciation issues detected.</p>
          ) : (
            <div className="flex flex-col gap-1">
              {problemWords.slice(0, 6).map((w) => (
                <div
                  key={w.word}
                  className="flex items-center justify-between gap-2 rounded-lg border border-[var(--red)]/25 bg-[var(--red)]/[0.06] px-2 py-1.5 text-[11px]"
                >
                  <span className="font-medium text-[var(--red)]">{w.word}</span>
                  <span className="font-semibold text-[var(--red)]">{Math.round(w.score)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {!stale && result.words && result.words.some((w) => w.errorType !== "None") && (
        <details className="group rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2 text-[11px]">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 font-semibold text-[var(--text-faint)] [&::-webkit-details-marker]:hidden">
            Word-level detail
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
    </div>
  );
}

/**
 * Evaluation result surface — presentational only. Word Match and True
 * Evaluation are both driven, stored, and kept alive (across tab switches,
 * sentence changes, and a same-tab refresh) by page.tsx + useShadowingEvaluations;
 * this component just renders whatever `entry` currently holds for the
 * active sentence and forwards user actions (retry, trigger) upward. See
 * "Shadowing Evaluation Improvement Plan" Part A.
 */
export function EvaluationTab({
  entry,
  recorderStatus,
  recordingClip,
  autoWordMatchEnabled,
  onRetryWordMatch,
  onTriggerTrueEvaluation,
  trueEvalBusy,
  quota,
  evaluationSummary,
  onJumpToSegment,
}: {
  entry: SentenceEvaluation | undefined;
  recorderStatus: AudioRecorderStatus;
  recordingClip: RecordedClip | null;
  autoWordMatchEnabled: boolean;
  onRetryWordMatch: () => void;
  onTriggerTrueEvaluation: () => void;
  trueEvalBusy: boolean;
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

  const tier = wordMatchCheck ? tierFor(wordMatchCheck) : null;
  const exactMatch = wordMatchCheck ? isExactMatch(wordMatchCheck) : false;
  const { expectedTokens, userTokens } = wordMatchCheck
    ? buildComparedTokens({
        diff: wordMatchCheck.diff,
        expectedText: wordMatchCheck.normalizedExpected,
        userText: wordMatchCheck.normalizedUser,
      })
    : { expectedTokens: [], userTokens: [] };
  const noSpeechDetected = wordMatchCheck && wordMatchCheck.normalizedUser.length === 0;

  // Compact/expanded Word Match diff view: defaults to collapsed on an
  // exact match and expanded otherwise, but a manual Show/Hide always wins
  // until a genuinely new recognized result arrives (a new recording),
  // which resets back to the default — switching right-panel tabs never
  // touches this. Reset happens during render (React's documented pattern
  // for "adjusting state when a prop changes") rather than in an effect, so
  // it takes effect before the stale-override paint rather than one tick
  // after it.
  const [wordMatchExpandedOverride, setWordMatchExpandedOverride] = useState<boolean | null>(null);
  const [lastSeenRecognizedText, setLastSeenRecognizedText] = useState(wordMatch?.recognizedText);
  if (wordMatch?.recognizedText !== lastSeenRecognizedText) {
    setLastSeenRecognizedText(wordMatch?.recognizedText);
    setWordMatchExpandedOverride(null);
  }
  const wordMatchExpanded = wordMatchExpandedOverride ?? !exactMatch;

  const evaluationUiState = deriveEvaluationUiState({
    hasClip,
    recordingClipId: recordingClip?.url ?? null,
    trueEvaluation,
    lastSuccessful,
  });

  const canRunTrueEvaluation = hasClip && !isRecording && !trueEvalBusy && !quota.limitReached;

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
                className="flex min-h-[36px] w-fit items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 text-[11px] font-semibold text-[var(--text)] transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <RotateCcw size={12} /> Retry Word Match
              </button>
            </div>
          ) : wordMatch?.status === "completed" && tier ? (
            <div className="flex flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-2.5">
              <div className="flex items-center justify-between">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-faint)]">
                  Word Match
                </p>
                {exactMatch ? (
                  <span className="flex items-center gap-1 rounded-full border border-[var(--green)]/30 bg-[var(--green)]/15 px-2 py-0.5 text-[11px] font-bold text-[var(--green)]">
                    <Check size={11} /> Exact match
                  </span>
                ) : (
                  <span className={`rounded-full border px-2 py-0.5 text-[11px] font-bold ${TIER_CLASS[tier]}`}>
                    {TIER_LABEL[tier]}
                  </span>
                )}
              </div>

              {noSpeechDetected ? (
                <p className="text-xs text-[var(--text-muted)]">
                  No speech was recognized. Try recording again.
                </p>
              ) : exactMatch && !wordMatchExpanded ? (
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs text-[var(--text-muted)]">All words were recognized correctly.</p>
                  <button
                    type="button"
                    onClick={() => setWordMatchExpandedOverride(true)}
                    className="min-h-[36px] shrink-0 rounded-lg px-2 text-[11px] font-semibold text-[var(--accent)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                  >
                    Show
                  </button>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <div className="rounded-lg border border-[var(--green)]/25 bg-[var(--green)]/[0.08] p-2 text-xs">
                    <p className="text-[11px] font-semibold text-[var(--green)]">Script</p>
                    <ComparedSentenceText tokens={expectedTokens} tone="expected" />
                  </div>
                  <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2 text-xs">
                    <p className="text-[11px] font-semibold text-[var(--text-faint)]">What we heard</p>
                    <ComparedSentenceText tokens={userTokens} tone="user" emptyFallback="(nothing recognized)" />
                  </div>
                  {exactMatch && (
                    <button
                      type="button"
                      onClick={() => setWordMatchExpandedOverride(false)}
                      className="min-h-[36px] w-fit rounded-lg px-1.5 text-[11px] font-semibold text-[var(--accent)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                    >
                      Hide
                    </button>
                  )}
                </div>
              )}

              <p className="text-[10px] text-[var(--text-faint)]">
                Word Match — your browser&apos;s speech recognition, compared against the script. Not a pronunciation
                score.
              </p>
            </div>
          ) : (
            <div className="flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-2.5 text-xs text-[var(--text-muted)]">
              <Loader2 size={14} className="shrink-0 animate-spin text-[var(--text-faint)]" />
              <p>Checking words…</p>
            </div>
          )}

          {/* ---- Pronunciation Assessment (Azure) ---- */}
          {quota.engineConfigured && (
            <div className="flex flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-2.5">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-faint)]">
                    Pronunciation Assessment
                  </p>
                  <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-faint)]/70">
                    Current sentence
                  </p>
                </div>
                <div className="flex items-center gap-1.5">
                  {quota.usedSec > 0 && (
                    <span className="text-[10px] font-medium text-[var(--text-faint)]">
                      Azure usage: {formatCompactDuration(quota.usedSec)} / {formatCompactDuration(quota.limitSec)}{" "}
                      this month
                    </span>
                  )}
                  <MetricInfoPopover />
                </div>
              </div>

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
                      Record a sentence, then evaluate your pronunciation.
                    </p>
                  )}

                  {evaluationUiState === "new-recording-not-evaluated" && lastSuccessful && (
                    <div className="flex flex-col gap-1">
                      <p className="text-xs font-medium text-[var(--text)]">New recording ready for evaluation</p>
                      {lastSuccessful.pronunciationScore !== undefined && (
                        <p className="text-[11px] text-[var(--text-faint)]">
                          Previous score: {Math.round(lastSuccessful.pronunciationScore)}
                        </p>
                      )}
                    </div>
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
                    </>
                  )}

                  {evaluationUiState === "success" && trueEvaluation && (
                    <PronunciationScoreCard result={trueEvaluation} stale={false} />
                  )}

                  {/* "unavailable" (engine dropped mid-session) gets no button — retrying can't help. */}
                  {evaluationUiState !== "success" && trueEvaluation?.status !== "unavailable" && (
                    <button
                      type="button"
                      onClick={onTriggerTrueEvaluation}
                      disabled={!canRunTrueEvaluation}
                      className="flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl border border-[var(--accent-border)] bg-[var(--accent-soft)] px-3 py-2 text-sm font-semibold text-[var(--accent)] transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {evaluationUiState === "evaluating" ? (
                        <Loader2 size={15} className="animate-spin" />
                      ) : (
                        <Gauge size={15} />
                      )}
                      {evaluationUiState === "evaluating"
                        ? "Evaluating pronunciation…"
                        : evaluationUiState === "error"
                          ? "Retry"
                          : "Evaluate pronunciation"}
                    </button>
                  )}
                </>
              )}

              <p className="text-[10px] text-[var(--text-faint)]">
                Powered by Azure AI Speech — your recording is sent for scoring only, never stored.
              </p>
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
