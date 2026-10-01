"use client";

import { ReactNode, useMemo } from "react";
import { clsx } from "clsx";
import { errorTypeLabel } from "@/lib/constants/errorTypes";
import { formatDurationSeconds } from "@/lib/utils/time";
import type { ReportSentence, RoundReport } from "@/lib/types/learning";

/**
 * The whole-round report (plan Phase 6 §8/§9): ONE component, fed by ONE
 * server contract (fn_round_report via GET /api/session/[id]/report), used by
 * both the practice page's completion view and the full report page — so the
 * two can never disagree after a reload. Scope: this user's round, its
 * pinned transcript, across every study session of the round.
 *
 * Styled only with the design tokens (--surface, --text, --accent, …) so the
 * dark practice page and the light report page each supply their own theme.
 */

const pct = (num: number, den: number) => (den > 0 ? `${Math.round((100 * num) / den)}%` : "—");
const score = (v: number | null | undefined) => (v === null || v === undefined ? "—" : String(Math.round(v)));

function Tile({ label, value, detail, testId }: { label: string; value: string; detail?: ReactNode; testId?: string }) {
  return (
    <div data-testid={testId} className="flex flex-col gap-0.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3">
      <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-faint)]">{label}</span>
      <span className="text-lg font-semibold tabular-nums text-[var(--text)]">{value}</span>
      {detail && <span className="text-[11px] leading-snug text-[var(--text-muted)]">{detail}</span>}
    </div>
  );
}

function statusHeadline(report: RoundReport): string {
  const r = report.round;
  if (r.status === "completed") return r.provenance === "legacy_unverified" ? "Completed earlier (unverified)" : "Round complete";
  if (r.status === "abandoned") return "Round ended — a newer round was started";
  return "Round in progress";
}

const CATEGORY_LABEL: Record<ReportSentence["category"], string> = {
  needs_review: "Needs review",
  corrected: "Corrected",
  first_try: "First try",
  correct: "Correct",
  shadowing_only: "Shadowing",
};

export interface RoundReportPanelProps {
  report: RoundReport;
  /** Review a sentence in the practice view (selects it; never plays, saves or starts a round). */
  onReviewSentence?: (segmentIndex: number) => void;
  /** Extra per-sentence content (e.g. saved AI explanations on the full report page). */
  renderSentenceExtra?: (sentence: ReportSentence) => ReactNode;
  /** "Next actions" — supplied by the host page. */
  actions?: ReactNode;
}

export function RoundReportPanel({ report, onReviewSentence, renderSentenceExtra, actions }: RoundReportPanelProps) {
  const { round, dictation, shadowing, progress } = report;
  const needsReview = useMemo(() => report.sentences.filter((s) => s.category === "needs_review"), [report.sentences]);
  const corrected = useMemo(() => report.sentences.filter((s) => s.category === "corrected"), [report.sentences]);
  const required = progress.requiredSentenceCount;
  const firstTry = dictation.firstTry;
  const hasDictation = dictation.practicedSentences > 0;
  const hasShadowing = shadowing.takes > 0;

  return (
    <div className="flex flex-col gap-5 text-[var(--text)]" data-testid="round-report">
      {/* 1. Outcome and essential metrics */}
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-bold text-[var(--accent)]">{statusHeadline(report)}</h2>
          <p className="text-xs text-[var(--text-muted)]">
            Round {round.roundNumber} · started {new Date(round.startedAt).toLocaleDateString()}
            {round.completedAt && (
              <>
                {" "}· completed {round.completedAtApproximate ? "around " : ""}
                {new Date(round.completedAt).toLocaleDateString()}
              </>
            )}
            {report.activity.sessionCount > 1 && <> · {report.activity.sessionCount} study sessions</>}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Tile
            testId="report-coverage"
            label="Practice coverage"
            value={required ? `${progress.coveredSentences.overall}/${required}` : String(progress.coveredSentences.overall)}
            detail={
              <>
                sentences practiced (Dictation {progress.coveredSentences.dictation} · Shadowing {progress.coveredSentences.shadowing})
              </>
            }
          />
          <Tile
            testId="report-accuracy"
            label="Sentence accuracy"
            value={hasDictation ? pct(dictation.latestCorrect, dictation.practicedSentences) : "—"}
            detail={
              hasDictation
                ? `${dictation.latestCorrect}/${dictation.practicedSentences} Dictation sentences correct on your latest answer`
                : "No Dictation answers in this round"
            }
          />
          <Tile
            testId="report-first-try"
            label="First try"
            value={!firstTry.available ? "—" : hasDictation ? `${firstTry.correct}/${dictation.practicedSentences}` : "—"}
            detail={
              !firstTry.available
                ? "Not enough historical data for this round"
                : hasDictation
                  ? [
                      "correct on your first answer",
                      firstTry.correctWithHint ? `${firstTry.correctWithHint} with a hint` : null,
                      firstTry.correctHintUnknown ? `hint use unknown for ${firstTry.correctHintUnknown}` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")
                  : undefined
            }
          />
          <Tile
            testId="report-submissions"
            label="Answers submitted"
            value={String(dictation.submissions)}
            detail="Dictation answers in this round (a retried request counts once)"
          />
          {dictation.bestStreak !== null && dictation.bestStreak > 1 && (
            <Tile
              testId="report-best-streak"
              label="Best run in this round"
              value={`${dictation.bestStreak} in a row`}
              detail="Longest run of correct answers across the whole round — not your daily streak"
            />
          )}
          <Tile
            testId="report-active-time"
            label="Estimated active time"
            value={report.activity.activeSec > 0 ? formatDurationSeconds(report.activity.activeSec) : "—"}
            detail={report.activity.activeSec > 0 ? "engaged time across this round's sessions" : "Not tracked for this round"}
          />
        </div>
        {hasShadowing && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" data-testid="report-shadowing">
            <Tile label="Shadowing takes" value={String(shadowing.takes)} detail={`${shadowing.practicedSentences} sentences practiced`} />
            <Tile
              label="Pronunciation (Azure)"
              value={score(shadowing.azure.pronunciation)}
              detail={
                shadowing.azure.evaluatedSentences > 0
                  ? `${shadowing.azure.evaluatedSentences}/${shadowing.attemptedSentences} evaluated sentences`
                  : "No saved pronunciation scores"
              }
            />
            <Tile
              label="Word Match"
              value={shadowing.wordMatch.accuracy === null ? "—" : `${Math.round(shadowing.wordMatch.accuracy)}%`}
              detail={
                shadowing.wordMatch.evaluatedSentences > 0
                  ? `${shadowing.wordMatch.evaluatedSentences}/${shadowing.attemptedSentences} sentences`
                  : "No saved Word Match results"
              }
            />
          </div>
        )}
        {!report.historyComplete && (
          <p className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-2.5 text-xs text-[var(--text-muted)]">
            Part of this round was recorded before answers were verified, so first-try results and runs of correct answers can&apos;t be
            proven and aren&apos;t shown. Your latest answers are shown as recorded.
          </p>
        )}
        {round.status !== "completed" && required !== null && progress.coveredSentences.overall < required && (
          <p className="text-xs text-[var(--text-muted)]">
            {required - progress.coveredSentences.overall} sentence{required - progress.coveredSentences.overall === 1 ? "" : "s"} still to
            practice to complete this round.
          </p>
        )}
      </section>

      {/* 2. Still needs review */}
      <section className="flex flex-col gap-2" aria-labelledby="report-needs-review">
        <h3 id="report-needs-review" className="text-sm font-semibold">
          Still needs review ({needsReview.length})
        </h3>
        {needsReview.length === 0 ? (
          <p className="text-xs text-[var(--text-muted)]">
            {hasDictation ? "Every Dictation sentence is correct on your latest answer." : "No Dictation answers to review."}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {needsReview.map((s) => (
              <SentenceRow key={s.segmentIndex} sentence={s} onReview={onReviewSentence} extra={renderSentenceExtra?.(s)} />
            ))}
          </ul>
        )}
      </section>

      {/* 3. Corrected after earlier mistakes */}
      {corrected.length > 0 && (
        <section className="flex flex-col gap-2" aria-labelledby="report-corrected">
          <h3 id="report-corrected" className="text-sm font-semibold">
            Corrected after mistakes ({corrected.length})
          </h3>
          <ul className="flex flex-col gap-2">
            {corrected.map((s) => (
              <SentenceRow key={s.segmentIndex} sentence={s} onReview={onReviewSentence} extra={renderSentenceExtra?.(s)} />
            ))}
          </ul>
        </section>
      )}

      {/* 4. Every practiced sentence */}
      {report.sentences.length > 0 && (
        <details className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3">
          <summary className="cursor-pointer text-sm font-semibold">All practiced sentences ({report.sentences.length})</summary>
          <ul className="mt-3 flex flex-col gap-2">
            {report.sentences.map((s) => (
              <SentenceRow key={s.segmentIndex} sentence={s} onReview={onReviewSentence} detailed />
            ))}
          </ul>
        </details>
      )}

      {/* 5. Next actions */}
      {actions && <section className="flex flex-wrap items-center gap-2">{actions}</section>}
    </div>
  );
}

function SentenceRow({
  sentence,
  onReview,
  extra,
  detailed = false,
}: {
  sentence: ReportSentence;
  onReview?: (segmentIndex: number) => void;
  extra?: ReactNode;
  detailed?: boolean;
}) {
  const d = sentence.dictation;
  const sh = sentence.shadowing;
  return (
    <li
      id={`report-sentence-${sentence.segmentIndex}`}
      className="flex flex-col gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3"
      data-category={sentence.category}
    >
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--text-faint)]">
        <span className="font-medium">Sentence {sentence.segmentIndex + 1}</span>
        <span
          className={clsx(
            "rounded-full px-2 py-0.5 font-semibold",
            sentence.category === "needs_review" && "bg-[var(--red)]/15 text-[var(--red)]",
            sentence.category === "corrected" && "bg-[var(--accent-soft)] text-[var(--accent)]",
            (sentence.category === "first_try" || sentence.category === "correct") && "bg-[var(--green)]/15 text-[var(--green)]",
            sentence.category === "shadowing_only" && "bg-[var(--surface-2)] text-[var(--text-muted)]"
          )}
        >
          {CATEGORY_LABEL[sentence.category]}
        </span>
        {d && d.practiceSubmissions > 1 && <span>{d.practiceSubmissions} answers</span>}
        {d?.latest?.errorType && !d.latest.correct && <span>{errorTypeLabel(d.latest.errorType)}</span>}
      </div>
      <p className="text-sm text-[var(--text)]">{sentence.text ?? "(sentence text unavailable)"}</p>
      {d?.latest && !d.latest.correct && (
        <p className="text-xs text-[var(--red)]">
          Your latest answer: {d.latest.userText || <span className="italic text-[var(--text-faint)]">nothing</span>}
        </p>
      )}
      {detailed && d?.first && (
        <p className="text-xs text-[var(--text-muted)]">
          First answer: {d.first.correct ? "correct" : `“${d.first.userText}”`}
          {d.first.hintLevel === null ? " (hint use unknown)" : d.first.hintLevel > 0 ? ` (hint level ${d.first.hintLevel})` : ""}
        </p>
      )}
      {detailed && sh && (
        <p className="text-xs text-[var(--text-muted)]">
          Shadowing: {sh.takes} take{sh.takes === 1 ? "" : "s"}
          {sh.latestAzure ? ` · pronunciation ${score(sh.latestAzure.pronunciationScore)}` : ""}
          {sh.latestWordMatch ? ` · Word Match ${score(sh.latestWordMatch.accuracy)}%` : ""}
        </p>
      )}
      {extra}
      {onReview && (
        <button
          type="button"
          onClick={() => onReview(sentence.segmentIndex)}
          className="self-start rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs font-semibold text-[var(--accent)] hover:bg-[var(--accent-soft)]"
        >
          Review sentence {sentence.segmentIndex + 1}
        </button>
      )}
    </li>
  );
}
