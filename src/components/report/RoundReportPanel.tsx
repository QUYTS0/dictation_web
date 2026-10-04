"use client";

import { KeyboardEvent, ReactNode, useMemo, useRef, useState } from "react";
import { clsx } from "clsx";
import { errorTypeLabel } from "@/lib/constants/errorTypes";
import { formatDurationSeconds } from "@/lib/utils/time";
import { formatAggregateScore } from "@/lib/practice/scoreFormat";
import type { ReportSentence, RoundReport } from "@/lib/types/learning";
import type { DiffToken, SessionReportResponse } from "@/lib/types";
import {
  analyzeDictationRound,
  describeObservation,
  type AnswerAnalysis,
  type DictationEvidence,
  type DictationPriority,
  type DictationRoundAnalysis,
} from "@/lib/practice/dictationAnalysis";
import { ShadowingFeedbackSection } from "./ShadowingFeedbackSection";
import { ofEligible } from "./ShadowingSummaryView";

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

/**
 * Status only. A round's ORIGIN (provenance) and its history's completeness
 * are reported separately (the history note) — neither says anything about
 * when or how the round was completed, so the headline never does either.
 */
function statusHeadline(report: RoundReport): string {
  const r = report.round;
  if (r.status === "completed") return "Round complete";
  if (r.status === "abandoned") return "Round ended — a newer round was started";
  return "Round in progress";
}

/** Corrected sentences shown before "Show more". */
const CORRECTED_INITIAL = 5;
/** Review priorities shown before "Show all". */
const PRIORITIES_INITIAL = 3;

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
  /** The signed-in viewer — enables the detailed Shadowing summary (loaded lazily). */
  userId?: string;
  /** Whether the detailed Shadowing summary starts open (loads at once) or collapsed (loads when opened). */
  shadowingFeedback?: "open" | "collapsed";
  /** Stored Dictation answers for the deterministic analysis (GET /api/session/[id]/report). */
  dictationEvidence?: DictationEvidence;
  /** Version number of the round's pinned script (shown in the round's identity line). */
  transcriptVersion?: number | null;
  /** Listening for the round's script version (video + script version scope, plus this round's sittings). */
  listening?: SessionReportResponse["listening"];
  /** Controlled section; omit to let the panel manage it from `defaultSection`. */
  section?: ReportSection;
  /** The section shown first (e.g. the mode the learner was practising, or ?section=). */
  defaultSection?: ReportSection;
  onSectionChange?: (section: ReportSection) => void;
}

export type ReportSection = "dictation" | "shadowing" | "listening";
export const REPORT_SECTIONS: readonly ReportSection[] = ["dictation", "shadowing", "listening"];
const SECTION_LABEL: Record<ReportSection, string> = { dictation: "Dictation", shadowing: "Shadowing", listening: "Listening" };

export function parseReportSection(value: string | null | undefined): ReportSection | null {
  return value && (REPORT_SECTIONS as readonly string[]).includes(value) ? (value as ReportSection) : null;
}

/** First section with this round's own evidence. */
function naturalSection(report: RoundReport, listening: RoundReportPanelProps["listening"]): ReportSection {
  if (report.dictation.practicedSentences > 0) return "dictation";
  if (report.shadowing.takes > 0) return "shadowing";
  if (listening) return "listening";
  return "dictation";
}

/** One plain sentence about what was accomplished — built only from the report's figures. */
function accomplishment(report: RoundReport): string {
  const { progress, dictation, shadowing, round } = report;
  const required = progress.requiredSentenceCount;
  const parts: string[] = [];
  if (round.status === "completed" && required) parts.push(`You completed ${required} ${required === 1 ? "sentence" : "sentences"}.`);
  else if (required) parts.push(`You've practised ${progress.coveredSentences.overall} of ${required} sentences.`);
  if (dictation.practicedSentences > 0) {
    const allCorrect = dictation.latestCorrect === dictation.practicedSentences;
    const latest = allCorrect
      ? `All ${dictation.practicedSentences} Dictation ${dictation.practicedSentences === 1 ? "sentence is" : "sentences are"} correct on your latest answer`
      : `${dictation.latestCorrect} of ${dictation.practicedSentences} Dictation sentences are correct on your latest answer`;
    parts.push(dictation.corrected > 0 ? `${latest}; ${dictation.corrected} ${dictation.corrected === 1 ? "was" : "were"} corrected after earlier mistakes.` : `${latest}.`);
  }
  if (shadowing.takes > 0 && required) {
    parts.push(
      `Shadowing: ${progress.coveredSentences.shadowing} of ${required} recorded, ${shadowing.azure.evaluatedSentences} scored by Azure.`
    );
  }
  return parts.join(" ");
}

export function RoundReportPanel({
  report,
  onReviewSentence,
  renderSentenceExtra,
  actions,
  userId,
  shadowingFeedback = "collapsed",
  dictationEvidence,
  transcriptVersion,
  listening,
  section: controlledSection,
  defaultSection,
  onSectionChange,
}: RoundReportPanelProps) {
  const { round, dictation, shadowing, progress } = report;
  const needsReview = useMemo(() => report.sentences.filter((s) => s.category === "needs_review"), [report.sentences]);
  const corrected = useMemo(() => report.sentences.filter((s) => s.category === "corrected"), [report.sentences]);
  const required = progress.requiredSentenceCount;
  const firstTry = dictation.firstTry;
  const hasDictation = dictation.practicedSentences > 0;
  const hasShadowing = shadowing.takes > 0;
  const analysis = useMemo(() => analyzeDictationRound(report.sentences, dictationEvidence), [report.sentences, dictationEvidence]);
  const [showAllCorrected, setShowAllCorrected] = useState(false);
  const visibleCorrected = showAllCorrected ? corrected : corrected.slice(0, CORRECTED_INITIAL);
  const validCorrectness = analysis.validSubmissionCorrectness;

  const [ownSection, setOwnSection] = useState<ReportSection>(() => defaultSection ?? naturalSection(report, listening));
  const section = controlledSection ?? ownSection;
  const selectSection = (next: ReportSection) => {
    setOwnSection(next);
    onSectionChange?.(next);
  };
  const tabRefs = useRef<Partial<Record<ReportSection, HTMLButtonElement | null>>>({});
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = REPORT_SECTIONS.indexOf(section);
    const next =
      e.key === "ArrowRight" ? REPORT_SECTIONS[(i + 1) % REPORT_SECTIONS.length]
      : e.key === "ArrowLeft" ? REPORT_SECTIONS[(i + REPORT_SECTIONS.length - 1) % REPORT_SECTIONS.length]
      : e.key === "Home" ? REPORT_SECTIONS[0]
      : e.key === "End" ? REPORT_SECTIONS[REPORT_SECTIONS.length - 1]
      : null;
    if (!next) return;
    e.preventDefault();
    selectSection(next);
    tabRefs.current[next]?.focus();
  };
  const panelId = (sec: ReportSection) => `report-panel-${round.roundId}-${sec}`;
  const tabId = (sec: ReportSection) => `report-tab-${round.roundId}-${sec}`;

  return (
    <div className="flex flex-col gap-5 text-[var(--text)]" data-testid="round-report">
      {/* 1. Summary — what was accomplished, the key figures, what to do next */}
      <section className="flex flex-col gap-3" data-testid="report-summary">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-bold text-[var(--accent)]">{statusHeadline(report)}</h2>
          <p className="text-xs text-[var(--text-muted)]" data-testid="report-identity">
            Round {round.roundNumber}
            {transcriptVersion ? <> · script version {transcriptVersion}</> : null} · started {new Date(round.startedAt).toLocaleDateString()}
            {round.completedAt && (
              <>
                {" "}· completed {round.completedAtApproximate ? "around " : ""}
                {new Date(round.completedAt).toLocaleDateString()}
                {round.completedAtApproximate ? " (date estimated)" : ""}
              </>
            )}
            {report.activity.sessionCount > 1 && <> · {report.activity.sessionCount} study sessions</>}
          </p>
        </div>
        {accomplishment(report) && (
          <p className="text-sm leading-relaxed text-[var(--text)]" data-testid="report-accomplishment">
            {accomplishment(report)}
          </p>
        )}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
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
            label="Correct on latest answer"
            value={hasDictation ? pct(dictation.latestCorrect, dictation.practicedSentences) : "—"}
            detail={
              hasDictation
                ? `${dictation.latestCorrect}/${dictation.practicedSentences} Dictation sentences correct on your latest answer`
                : "No Dictation answers in this round"
            }
          />
          {hasShadowing && (
            <Tile
              testId="summary-shadowing-recorded"
              label="Shadowing recorded"
              value={required ? `${progress.coveredSentences.shadowing}/${required}` : String(progress.coveredSentences.shadowing)}
              detail="sentences with a valid recording"
            />
          )}
          {hasShadowing && (
            <Tile
              testId="summary-shadowing-azure"
              label="Scored by Azure"
              value={required ? `${shadowing.azure.evaluatedSentences}/${required}` : String(shadowing.azure.evaluatedSentences)}
              detail="sentences with a saved pronunciation score"
            />
          )}
        </div>
        {hasDictation && analysis.priorities.length > 0 && (
          <div className="flex flex-col gap-1" data-testid="summary-priorities">
            <p className="text-xs font-semibold text-[var(--text-faint)]">Practise next</p>
            <ol className="flex list-decimal flex-col gap-0.5 pl-5 text-sm">
              {analysis.priorities.slice(0, PRIORITIES_INITIAL).map((p, i) => (
                <li key={i}>{priorityText(p)}</li>
              ))}
            </ol>
          </div>
        )}
        {!report.historyComplete && (
          <p data-testid="report-history-note" className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-2.5 text-xs text-[var(--text-muted)]">
            Part of this round was practised before detailed tracking. First-try and best-run statistics aren&apos;t available; your
            latest answers are shown as recorded.
          </p>
        )}
        {round.status !== "completed" && required !== null && progress.coveredSentences.overall < required && (
          <p className="text-xs text-[var(--text-muted)]">
            {required - progress.coveredSentences.overall} sentence{required - progress.coveredSentences.overall === 1 ? "" : "s"} still to
            practice to complete this round.
          </p>
        )}
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </section>

      {/* 2. Mode sections — one round, separate metrics per mode */}
      <div role="tablist" aria-label="Report sections" className="flex gap-1 border-b border-[var(--border)]">
        {REPORT_SECTIONS.map((sec) => (
          <button
            key={sec}
            ref={(el) => {
              tabRefs.current[sec] = el;
            }}
            type="button"
            role="tab"
            id={tabId(sec)}
            aria-selected={section === sec}
            aria-controls={panelId(sec)}
            tabIndex={section === sec ? 0 : -1}
            onClick={() => selectSection(sec)}
            onKeyDown={onTabKey}
            className={clsx(
              "-mb-px min-h-[40px] border-b-2 px-3 py-2 text-sm font-semibold transition-colors",
              section === sec ? "border-[var(--accent)] text-[var(--accent)]" : "border-transparent text-[var(--text-muted)] hover:text-[var(--text)]"
            )}
          >
            {SECTION_LABEL[sec]}
          </button>
        ))}
      </div>

      {/* Dictation */}
      <div role="tabpanel" id={panelId("dictation")} aria-labelledby={tabId("dictation")} hidden={section !== "dictation"} className="flex flex-col gap-5">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {/* Unavailable first-try data is the history note above, never an empty tile. */}
          {firstTry.available && hasDictation && (
            <Tile
              testId="report-first-try"
              label="First try"
              value={`${firstTry.correct}/${dictation.practicedSentences}`}
              detail={[
                "correct on your first answer",
                firstTry.correctWithHint ? `${firstTry.correctWithHint} with a hint` : null,
                firstTry.correctHintUnknown ? `hint use unknown for ${firstTry.correctHintUnknown}` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            />
          )}
          <Tile
            testId="report-submissions"
            label="Answers submitted"
            value={String(dictation.submissions)}
            detail={[
              "a retried request counts once",
              dictation.invalidSubmissions > 0
                ? `${dictation.invalidSubmissions} empty answer${dictation.invalidSubmissions === 1 ? "" : "s"} not counted`
                : null,
              validCorrectness ? `correct across valid answers: ${pct(validCorrectness.correct, validCorrectness.valid)}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
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

        {hasDictation && analysis.priorities.length > 0 && <PrioritySection analysis={analysis} sentences={report.sentences} />}

        <section className="flex flex-col gap-2" aria-labelledby="report-needs-review">
          <h3 id="report-needs-review" className="text-sm font-semibold">
            Still needs review ({needsReview.length})
          </h3>
          {needsReview.length === 0 ? (
            <p className="text-xs text-[var(--text-muted)]" data-testid="report-nothing-to-review">
              {hasDictation ? "Nothing left to review — every sentence you answered is correct on your latest answer." : "No Dictation answers to review."}
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {needsReview.map((s) => (
                <SentenceRow
                  key={s.segmentIndex}
                  sentence={s}
                  analysis={analysis.bySentence.get(s.segmentIndex)}
                  onReview={onReviewSentence}
                  extra={renderSentenceExtra?.(s)}
                />
              ))}
            </ul>
          )}
        </section>

        {corrected.length > 0 && (
          <section className="flex flex-col gap-2" aria-labelledby="report-corrected">
            <h3 id="report-corrected" className="text-sm font-semibold">
              Corrected after mistakes ({corrected.length})
            </h3>
            <ul className="flex flex-col gap-2" id="report-corrected-list">
              {visibleCorrected.map((s) => (
                <SentenceRow
                  key={s.segmentIndex}
                  sentence={s}
                  analysis={analysis.bySentence.get(s.segmentIndex)}
                  onReview={onReviewSentence}
                  extra={renderSentenceExtra?.(s)}
                />
              ))}
            </ul>
            {corrected.length > CORRECTED_INITIAL && (
              <button
                type="button"
                aria-expanded={showAllCorrected}
                aria-controls="report-corrected-list"
                onClick={() => setShowAllCorrected((v) => !v)}
                className="self-start rounded-lg px-2 py-1 text-xs font-semibold text-[var(--accent)] hover:bg-[var(--accent-soft)]"
              >
                {showAllCorrected ? "Show fewer" : `Show ${corrected.length - CORRECTED_INITIAL} more`}
              </button>
            )}
          </section>
        )}

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
      </div>

      {/* Shadowing — the shared summary (rules unchanged), out of the round's ELIGIBLE sentences */}
      <div role="tabpanel" id={panelId("shadowing")} aria-labelledby={tabId("shadowing")} hidden={section !== "shadowing"} className="flex flex-col gap-3">
        {hasShadowing ? (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" data-testid="report-shadowing">
              <Tile
                testId="report-shadowing-recorded"
                label="Shadowing recordings"
                value={required ? `${progress.coveredSentences.shadowing}/${required}` : String(progress.coveredSentences.shadowing)}
                detail={`sentences with a valid recording · ${shadowing.takes} recording${shadowing.takes === 1 ? "" : "s"} in total`}
              />
              <Tile
                testId="report-shadowing-azure"
                label="Pronunciation (Azure)"
                value={formatAggregateScore(shadowing.azure.pronunciation)}
                detail={
                  shadowing.azure.evaluatedSentences > 0
                    ? `${ofEligible(shadowing.azure.evaluatedSentences, required)} scored by Azure`
                    : "No saved pronunciation scores"
                }
              />
              <Tile
                testId="report-shadowing-word-match"
                label="Word Match"
                value={shadowing.wordMatch.accuracy === null ? "—" : `${formatAggregateScore(shadowing.wordMatch.accuracy)}%`}
                detail={
                  shadowing.wordMatch.evaluatedSentences > 0
                    ? `${ofEligible(shadowing.wordMatch.evaluatedSentences, required)} · browser recognition, not a pronunciation score`
                    : "No saved Word Match results"
                }
              />
            </div>
            {userId && (
              <ShadowingFeedbackSection
                key={report.round.roundId}
                userId={userId}
                report={report}
                defaultOpen={shadowingFeedback === "open"}
                onReviewSentence={onReviewSentence}
              />
            )}
          </>
        ) : (
          <p className="text-sm text-[var(--text-muted)]">No Shadowing recordings in this round yet.</p>
        )}
      </div>

      {/* Listening — stored per video + script version, not per round */}
      <div role="tabpanel" id={panelId("listening")} aria-labelledby={tabId("listening")} hidden={section !== "listening"} className="flex flex-col gap-2">
        <ListeningSection listening={listening} transcriptVersion={transcriptVersion} />
      </div>
    </div>
  );
}

function ListeningSection({ listening, transcriptVersion }: { listening: RoundReportPanelProps["listening"]; transcriptVersion?: number | null }) {
  const scope = transcriptVersion ? `script version ${transcriptVersion}` : "this script version";
  if (!listening) {
    return (
      <p className="text-sm text-[var(--text-muted)]" data-testid="report-listening-empty">
        No Listening recorded for {scope} yet.
      </p>
    );
  }
  return (
    <section className="flex flex-col gap-2" data-testid="report-listening">
      <h3 className="text-sm font-semibold">Listening — {scope} (all sittings)</h3>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Tile
          testId="report-listening-coverage"
          label="Script listened to"
          value={listening.coverageRatio === null ? "—" : `${Math.round(listening.coverageRatio * 100)}%`}
          detail={listening.listenedThrough ? "listened through" : "of the script's spoken time"}
        />
        <Tile
          testId="report-listening-position"
          label="Saved position"
          value={listening.lastPositionSec === null ? "—" : formatDurationSeconds(Math.round(listening.lastPositionSec))}
          detail="where Listening resumes"
        />
        <Tile
          testId="report-listening-round"
          label="In this round's sittings"
          value={formatDurationSeconds(Math.round(listening.roundSittingsNewlyCoveredSec))}
          detail={`newly covered · ${formatDurationSeconds(Math.round(listening.roundSittingsObservedSec))} played, replays included`}
        />
      </div>
      <p className="text-[11px] text-[var(--text-faint)]">
        Coverage measures playback of the video, not attention. It belongs to the script version, so sittings in other rounds on this
        version count too; only the last figure is this round&apos;s own.
      </p>
    </section>
  );
}

function SentenceRow({
  sentence,
  analysis,
  onReview,
  extra,
  detailed = false,
}: {
  sentence: ReportSentence;
  /** The deterministic analysis of the answer this row is about (needs-review / corrected rows). */
  analysis?: RowAnalysis;
  onReview?: (segmentIndex: number) => void;
  extra?: ReactNode;
  detailed?: boolean;
}) {
  const d = sentence.dictation;
  const sh = sentence.shadowing;
  const showsComparison = !!analysis && !detailed;
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
        {/* The stored error type is only shown where no factual comparison is
            available (its "wrong form" covers ANY same-length difference). */}
        {!showsComparison && d?.latest?.errorType && !d.latest.correct && d.latest.errorType !== "wrong_form" && (
          <span>{errorTypeLabel(d.latest.errorType)}</span>
        )}
      </div>
      {showsComparison ? (
        <AnswerComparison sentence={sentence} row={analysis!} />
      ) : (
        <>
          <p className="text-sm text-[var(--text)]">{sentence.text ?? "(sentence text unavailable)"}</p>
          {d?.latest && !d.latest.correct && (
            <p className="text-xs text-[var(--red)]">
              Your latest answer: {d.latest.userText || <span className="italic text-[var(--text-faint)]">nothing</span>}
            </p>
          )}
        </>
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

// ----------------------------------------------------------------- pieces

type RowAnalysis = { analysis: AnswerAnalysis; incorrectAnswers: number; answer: { userText: string } };

/** Answer line and reference line, differences highlighted (comparison form). */
function DiffLine({ tokens, side }: { tokens: DiffToken[]; side: "answer" | "reference" }) {
  const shown = tokens.filter((t) => (side === "answer" ? t.status !== "missing" : t.status === "correct" || t.status === "missing"));
  return (
    <span>
      {shown.map((t, i) => {
        const changed = t.status !== "correct";
        return (
          <span key={i}>
            {i > 0 && " "}
            <span
              data-diff={changed ? (side === "answer" ? "answer-changed" : "reference-changed") : undefined}
              className={clsx(
                changed && side === "answer" && "rounded bg-[var(--red)]/15 px-0.5 text-[var(--red)] line-through decoration-[var(--red)]/60",
                changed && side === "reference" && "rounded bg-[var(--green)]/15 px-0.5 font-semibold text-[var(--green)]"
              )}
            >
              {t.word}
            </span>
          </span>
        );
      })}
    </span>
  );
}

function AnswerComparison({ sentence, row }: { sentence: ReportSentence; row: RowAnalysis }) {
  const { analysis, incorrectAnswers } = row;
  const corrected = sentence.category === "corrected";
  const lead = corrected
    ? `Corrected after ${incorrectAnswers} incorrect answer${incorrectAnswers === 1 ? "" : "s"} — your last mistake:`
    : null;
  return (
    <div className="flex flex-col gap-1 text-sm" data-testid="answer-comparison">
      {lead && <p className="text-xs text-[var(--text-muted)]">{lead}</p>}
      {analysis.status === "marked_incorrect_unexplained" ? (
        <>
          <p className="text-[var(--text)]">{sentence.text}</p>
          <p className="text-xs text-[var(--text-muted)]">
            You wrote: {row.answer.userText || <span className="italic">nothing</span>}. Marked incorrect when submitted; the difference
            isn&apos;t identifiable with the current matching rules.
          </p>
        </>
      ) : analysis.status === "accepted_as_correct" ? (
        <>
          <p className="text-[var(--text)]">{sentence.text}</p>
          <p className="text-xs text-[var(--text-muted)]">Accepted as correct when submitted.</p>
        </>
      ) : analysis.tokens.length === 0 ? (
        <>
          <p className="text-[var(--text)]">{sentence.text}</p>
          <p className="text-xs text-[var(--text-muted)]">
            You wrote: {row.answer.userText || <span className="italic">nothing</span>}
          </p>
        </>
      ) : (
        <>
          <p className="leading-relaxed">
            <span className="mr-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-faint)]">You wrote</span>
            <DiffLine tokens={analysis.tokens} side="answer" />
          </p>
          <p className="leading-relaxed">
            <span className="mr-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-faint)]">Reference</span>
            <DiffLine tokens={analysis.tokens} side="reference" />
          </p>
        </>
      )}
      {analysis.observations.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Observed differences">
          {analysis.observations.map((o, i) => (
            <li key={i} className="rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-[11px] text-[var(--text-muted)]">
              {describeObservation(o)}
            </li>
          ))}
        </ul>
      )}
      <p className="text-[10px] text-[var(--text-faint)]">
        {analysis.comparison === "ignores_case_and_punctuation"
          ? "Compared ignoring capitalization and punctuation, as when you answered."
          : analysis.comparison === "exact"
            ? "Exact matching: capitalization and punctuation count."
            : "Older answer — its matching rule wasn't recorded."}
      </p>
    </div>
  );
}

function priorityText(p: DictationPriority): string {
  switch (p.kind) {
    case "still_incorrect":
      return `Sentence ${p.segmentIndex + 1} is still incorrect${p.incorrectAnswers > 1 ? ` (${p.incorrectAnswers} incorrect answers)` : ""}`;
    case "recurring":
      return `You wrote “${p.answer}” for “${p.reference}” in ${p.segmentIndexes.length} sentences (${p.segmentIndexes
        .map((i) => i + 1)
        .join(", ")})`;
    case "hard_corrected":
      return `Sentence ${p.segmentIndex + 1} took ${p.incorrectAnswers} incorrect answers before it was right`;
  }
}

function PrioritySection({ analysis }: { analysis: DictationRoundAnalysis; sentences: ReportSentence[] }) {
  const [showAll, setShowAll] = useState(false);
  const list = showAll ? analysis.priorities : analysis.priorities.slice(0, PRIORITIES_INITIAL);
  return (
    <section className="flex flex-col gap-2" aria-labelledby="report-priorities" data-testid="report-priorities">
      <h3 id="report-priorities" className="text-sm font-semibold">
        Review priorities
      </h3>
      <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm" id="report-priorities-list">
        {list.map((p, i) => (
          <li key={i}>{priorityText(p)}</li>
        ))}
      </ol>
      {analysis.priorities.length > PRIORITIES_INITIAL && (
        <button
          type="button"
          aria-expanded={showAll}
          aria-controls="report-priorities-list"
          onClick={() => setShowAll((v) => !v)}
          className="self-start rounded-lg px-2 py-1 text-xs font-semibold text-[var(--accent)] hover:bg-[var(--accent-soft)]"
        >
          {showAll ? "Show fewer" : `Show all ${analysis.priorities.length}`}
        </button>
      )}
      <p className="text-[10px] text-[var(--text-faint)]">Observed in your answers — ordered by what is still incorrect, then repeated differences.</p>
    </section>
  );
}
