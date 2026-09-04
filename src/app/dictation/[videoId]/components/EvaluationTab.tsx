"use client";

import { useEffect, useState } from "react";
import { ClipboardCheck, Mic, AlertCircle } from "lucide-react";
import { checkAnswer } from "@/lib/utils/text";
import type { CheckResult } from "@/lib/types";
import type { AudioRecorderStatus, RecordedClip } from "@/hooks/useAudioRecorder";
import type { SpeechRecognitionStatus } from "@/hooks/useSpeechRecognition";
import { ComparedSentenceText } from "./ComparedSentenceText";
import { EvaluationSessionSummary } from "./EvaluationSessionSummary";
import { buildComparedTokens, splitSentenceIntoWords } from "../helpers";
import type { ShadowingEvaluationSummary } from "../useShadowingEvaluations";
import type { SentenceEvaluation } from "../types";

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

/**
 * Word Match result surface — see "Shadowing and Pronunciation Practice
 * Plan.md" §10. Always visible while Shadowing (not hidden until Evaluate is
 * pressed) since the Evaluate action itself lives here rather than in
 * ControlBar. A 3-tier bucket, never a precise-looking percentage — this
 * reuses the recognizer's raw text, which is noisy enough that a number like
 * "73%" would overstate the precision on offer (§8.1).
 */
export function EvaluationTab({
  currentSegIdx,
  currentSegment,
  recorderStatus,
  recordingClip,
  speechStatus,
  transcript,
  onEvaluated,
  onEvaluationRecorded,
  evaluationSummary,
  onJumpToSegment,
}: {
  currentSegIdx: number;
  currentSegment: { text: string } | undefined;
  recorderStatus: AudioRecorderStatus;
  recordingClip: RecordedClip | null;
  speechStatus: SpeechRecognitionStatus;
  transcript: string | null;
  onEvaluated?: () => void;
  onEvaluationRecorded: (evaluation: SentenceEvaluation) => void;
  evaluationSummary: ShadowingEvaluationSummary;
  onJumpToSegment: (segmentIndex: number) => void;
}) {
  const [result, setResult] = useState<CheckResult | null>(null);

  // A result only ever refers to the take it was computed from — a new
  // recording (or leaving the sentence) must not leave a stale one on screen.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setResult(null);
  }, [recordingClip, currentSegIdx]);

  const isRecording = recorderStatus === "recording" || recorderStatus === "requesting-permission";
  const hasClip = !!recordingClip;
  // The recorder's own stop() tends to resolve faster than speech
  // recognition's — recognition.stop() is async and only delivers the final
  // transcript for whatever was just said right before its `onend` fires.
  // Evaluating while still "listening" here would race that and read a
  // stale/incomplete transcript, so the button stays disabled until
  // recognition has actually finished finalizing.
  const transcriptPending = hasClip && speechStatus === "listening";
  const canEvaluate = hasClip && !isRecording && !transcriptPending && !!currentSegment && speechStatus !== "unsupported";

  const handleEvaluate = () => {
    if (!currentSegment) return;
    const checkResult = checkAnswer(currentSegment.text, transcript ?? "", "relaxed");
    setResult(checkResult);

    // Word Match doesn't produce true accuracy/completeness scores — this
    // derives a stand-in from the same diff the tier badge above already
    // uses, so per-sentence evaluations can be aggregated into a session
    // summary (§11) even before a true evaluation engine (Phase 6) exists.
    const expectedCount = checkResult.diff.filter((t) => t.status !== "extra").length;
    const correctCount = checkResult.diff.filter((t) => t.status === "correct").length;
    const missingCount = checkResult.diff.filter((t) => t.status === "missing").length;
    const problemWords = checkResult.diff
      .filter((t) => t.status === "missing" || t.status === "wrong")
      .map((t) => ({ word: t.word, errorType: t.status }));

    onEvaluationRecorded({
      segmentIndex: currentSegIdx,
      referenceText: currentSegment.text,
      wordCount: splitSentenceIntoWords(currentSegment.text).length,
      audioDuration: recordingClip?.durationSec ?? 0,
      accuracy: expectedCount > 0 ? (correctCount / expectedCount) * 100 : 0,
      completeness: expectedCount > 0 ? ((expectedCount - missingCount) / expectedCount) * 100 : 0,
      problemWords,
    });

    onEvaluated?.();
  };

  if (speechStatus === "unsupported") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-8 text-center">
        <AlertCircle size={26} className="text-[var(--text-faint)]" />
        <p className="text-sm font-semibold text-[var(--text)]">Word Match isn&apos;t available here</p>
        <p className="max-w-[26ch] text-xs text-[var(--text-muted)]">
          Your browser doesn&apos;t support live speech recognition. Try Chrome, Edge, or Android Chrome to evaluate
          your recordings.
        </p>
      </div>
    );
  }

  const tier = result ? tierFor(result) : null;
  const { expectedTokens, userTokens } = result
    ? buildComparedTokens({ diff: result.diff, expectedText: result.normalizedExpected, userText: result.normalizedUser })
    : { expectedTokens: [], userTokens: [] };
  const noSpeechDetected = result && result.normalizedUser.length === 0;

  return (
    <div className="flex flex-1 flex-col gap-3">
      {!hasClip ? (
        <div className="flex flex-col items-center justify-center gap-2 px-4 py-8 text-center">
          <Mic size={26} className="text-[var(--text-faint)]" />
          <p className="text-sm font-semibold text-[var(--text)]">No recording yet</p>
          <p className="max-w-[26ch] text-xs text-[var(--text-muted)]">
            Record a take below, then evaluate it here — how closely your words matched the script.
          </p>
        </div>
      ) : (
        <>
          {result && tier && (
            <div className="flex flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-2.5">
              <div className="flex items-center justify-between">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-faint)]">Word Match</p>
                <span className={`rounded-full border px-2 py-0.5 text-[11px] font-bold ${TIER_CLASS[tier]}`}>
                  {TIER_LABEL[tier]}
                </span>
              </div>

              {noSpeechDetected ? (
                <p className="text-xs text-[var(--text-muted)]">
                  No speech was recognized in this recording — try again a little closer to the mic.
                </p>
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
                </div>
              )}

              <p className="text-[10px] text-[var(--text-faint)]">
                Word Match — your browser&apos;s speech recognition, compared against the script. Not a pronunciation
                score.
              </p>
            </div>
          )}

          <button
            type="button"
            onClick={handleEvaluate}
            disabled={!canEvaluate}
            className="flex items-center justify-center gap-1.5 rounded-xl border border-[var(--accent-border)] bg-[var(--accent-soft)] px-3 py-2 text-sm font-semibold text-[var(--accent)] transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ClipboardCheck size={15} />
            {transcriptPending ? "Finishing up transcript…" : result ? "Check again" : "Evaluate my recording"}
          </button>

          {speechStatus === "error" && !result && (
            <p className="flex items-center gap-1.5 text-xs text-[var(--red)]">
              <AlertCircle size={12} className="shrink-0" /> Couldn&apos;t access speech recognition for this take —
              you can still try Evaluate.
            </p>
          )}
        </>
      )}

      {evaluationSummary.evaluatedCount > 1 && (
        <EvaluationSessionSummary summary={evaluationSummary} onJumpToSegment={onJumpToSegment} />
      )}
    </div>
  );
}
