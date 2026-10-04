"use client";

import { useState, type ReactNode } from "react";
import { clsx } from "clsx";
import { formatAggregateScore } from "@/lib/practice/scoreFormat";
import {
  SHADOWING_SUMMARY_RULES,
  type MetricKey,
  type SentenceImprovement,
  type SentenceRow,
  type ShadowingRoundSummary,
  type WordCategory,
  type WordImprovement,
  type WordPriority,
} from "@/lib/practice/shadowingSummary";

/**
 * The Shadowing summary of one round, rendered from the shared builder's
 * output (src/lib/practice/shadowingSummary.ts) — the same view in the
 * practice page's summary dialog and in every round report (completion
 * view, /results, History). Styled only with the design tokens, so the dark
 * practice page and the light report pages supply their own theme.
 *
 * Read-only: it never records, evaluates or navigates by itself. A sentence
 * opens through `onOpenSentence` when the host can show THAT round's pinned
 * sentence (the practice page's current round); otherwise the sentence list
 * offers a read-only preview of its saved feedback.
 */

const METRIC_LABEL: Record<"pronunciation" | MetricKey, string> = {
  pronunciation: "Pronunciation",
  accuracy: "Accuracy",
  fluency: "Fluency",
  completeness: "Completeness",
  prosody: "Prosody",
};
const RHYTHM_LABEL = { UnexpectedBreak: "Unexpected pause", MissingBreak: "Missing pause", Monotone: "Flat intonation" } as const;
const LEVEL_LABEL = { great: "Great improvement", nice: "Nice improvement", improving: "Improving" } as const;
const CATEGORY_LABEL: Record<WordCategory, string> = {
  ok: "",
  mispronounced: "mispronounced",
  low_score: "low score",
  not_recognized: "not recognized",
  extra: "extra",
  rhythm: "rhythm",
  uncertain: "no score",
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const whole = (v: number | null) => (v === null ? "—" : String(Math.round(v)));

/** "3 of 6 sentences" — or "3 sentences" when the denominator is unknown. */
export function ofEligible(count: number, eligible: number | null): string {
  return eligible !== null && eligible > 0 ? `${count} of ${plural(eligible, "sentence")}` : plural(count, "sentence");
}

export function coverageStatement(c: ShadowingRoundSummary["coverage"]): string {
  if (c.scoredSentences === 0) return "No sentences have been scored by Azure yet.";
  if (c.allScored) return "Every eligible sentence has an Azure score.";
  if (c.allRecorded) return `All sentences are recorded in Shadowing — ${ofEligible(c.scoredSentences, c.eligibleSentences)} scored by Azure.`;
  if (c.eligibleSentences === null || c.eligibleSentences <= 0) return `${plural(c.scoredSentences, "sentence")} scored by Azure so far.`;
  return `Partial: ${ofEligible(c.scoredSentences, c.eligibleSentences)} scored by Azure.`;
}

/** What the word-level feedback is based on — never "no issues" without evidence. */
export function detailStatement(summary: ShadowingRoundSummary): string | null {
  const d = summary.detail;
  const scored = summary.coverage.scoredSentences;
  if (d.availability === "no_scores") return null;
  if (d.availability === "none")
    return `Word-level feedback wasn't saved for the ${plural(scored, "scored sentence")}, so no words can be suggested. Scores still count.`;
  if (d.availability === "partial") return `Word-level feedback is available for ${d.scoredWithWordDetail} of ${plural(scored, "scored sentence")}.`;
  return null;
}

export function priorityEvidence(p: WordPriority): string {
  return `Flagged in ${p.affectedOccurrences} of ${plural(p.occurrences, "occurrence")} across ${p.affectedSentences} of ${plural(p.sentences, "sentence")}`;
}

function Section({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <section className="flex flex-col gap-1.5" data-testid={testId}>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-faint)]">{title}</h4>
      {children}
    </section>
  );
}

function PriorityRow({ p, onOpenSentence }: { p: WordPriority; onOpenSentence?: (segmentIndex: number) => void }) {
  const example = p.examples[0];
  return (
    <li className="flex flex-col gap-0.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm" data-testid="ss-priority">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="font-semibold text-[var(--red)]">
          {p.label}
          {p.focusPhoneme && <span className="ml-1 font-mono text-xs text-[var(--text-muted)]">/{p.focusPhoneme}/</span>}
        </span>
        <span className="text-[11px] font-semibold text-[var(--text-faint)]">{p.recurring ? "Recurring" : "One sentence"}</span>
      </div>
      <span className="text-xs text-[var(--text-muted)]">{priorityEvidence(p)}</span>
      <span className="text-xs text-[var(--text-muted)]">
        {p.averageScore !== null ? `Average ${formatAggregateScore(p.averageScore)} over its scored occurrences` : "No numeric score — flagged by Azure as mispronounced"}
        {example && (
          <>
            {" · "}
            {onOpenSentence ? (
              <button type="button" onClick={() => onOpenSentence(example.segmentIndex)} className="font-semibold text-[var(--accent)] underline">
                sentence {example.segmentIndex + 1}
              </button>
            ) : (
              `sentence ${example.segmentIndex + 1}`
            )}
            {example.score !== null ? `: ${whole(example.score)}` : ": not scored"}
          </>
        )}
      </span>
    </li>
  );
}

export function PriorityList({
  priorities,
  onOpenSentence,
  initial = SHADOWING_SUMMARY_RULES.INITIAL_PRIORITIES,
}: {
  priorities: WordPriority[];
  onOpenSentence?: (segmentIndex: number) => void;
  initial?: number;
}) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? priorities : priorities.slice(0, initial);
  return (
    <>
      <ul className="flex flex-col gap-1.5">
        {visible.map((p) => (
          <PriorityRow key={p.key} p={p} onOpenSentence={onOpenSentence} />
        ))}
      </ul>
      {priorities.length > initial && (
        <button
          type="button"
          aria-expanded={showAll}
          onClick={() => setShowAll((v) => !v)}
          className="self-start rounded-lg px-1.5 text-xs font-semibold text-[var(--accent)] hover:underline"
        >
          {showAll ? "Show fewer" : `Show ${priorities.length - initial} more`}
        </button>
      )}
    </>
  );
}

function improvementScope(i: SentenceImprovement | WordImprovement): string {
  return i.sinceFirstResult
    ? `first → latest of ${plural(i.resultsCompared, "scored recording")}`
    : `recent comparison of your last ${i.resultsCompared} scored recordings`;
}

function ImprovementRow({ i }: { i: SentenceImprovement | WordImprovement }) {
  return (
    <li className="rounded-lg border border-[var(--green)]/25 bg-[var(--green)]/[0.08] px-3 py-2 text-xs" data-testid="ss-improvement">
      <span className="font-semibold text-[var(--green)]">{LEVEL_LABEL[i.level]}</span>{" "}
      <span className="text-[var(--text)]">
        {i.kind === "word" ? `“${i.word}” in sentence ${i.segmentIndex + 1}` : `Sentence ${i.segmentIndex + 1}`}: {whole(i.fromScore)} → {whole(i.toScore)}
      </span>{" "}
      <span className="text-[var(--text-faint)]">({improvementScope(i)})</span>
    </li>
  );
}

function SentencePreview({ row }: { row: SentenceRow }) {
  return (
    <div className="mt-1.5 flex flex-col gap-1 border-t border-[var(--border)] pt-1.5" data-testid={`ss-sentence-preview-${row.segmentIndex}`}>
      <p className="text-sm text-[var(--text)]">{row.referenceText || "(sentence text unavailable)"}</p>
      {row.hasWordDetail ? (
        <p className="flex flex-wrap gap-1">
          {row.words.map((w, idx) => (
            <span
              key={idx}
              className={clsx(
                "rounded px-1.5 py-0.5 text-[11px]",
                w.category === "ok" ? "bg-[var(--surface-2)] text-[var(--text-muted)]" : "bg-[var(--red)]/10 text-[var(--red)]"
              )}
              title={CATEGORY_LABEL[w.category] || undefined}
            >
              {w.word}
              {w.score !== null && ` ${whole(w.score)}`}
              {w.category !== "ok" && ` · ${CATEGORY_LABEL[w.category]}`}
            </span>
          ))}
        </p>
      ) : row.pronunciationScore !== null ? (
        <p className="text-xs text-[var(--text-faint)]">Word-level feedback wasn&apos;t saved for this result.</p>
      ) : null}
    </div>
  );
}

function SentenceList({ rows, onOpenSentence }: { rows: SentenceRow[]; onOpenSentence?: (segmentIndex: number) => void }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <ul className="flex flex-col gap-1.5">
      {rows.map((row) => {
        const flagged = row.words.filter((w) => w.category === "mispronounced" || w.category === "low_score").length;
        return (
          <li key={row.segmentIndex} className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-semibold text-[var(--text)]">Sentence {row.segmentIndex + 1}</span>
              <span className="text-[var(--text-muted)]">{row.pronunciationScore !== null ? `Pronunciation ${whole(row.pronunciationScore)}` : "Not scored by Azure"}</span>
              {row.wordMatchAccuracy !== null && <span className="text-[var(--text-muted)]">Word Match {whole(row.wordMatchAccuracy)}%</span>}
              {flagged > 0 && <span className="text-[var(--red)]">{plural(flagged, "flagged word")}</span>}
              <span className="ml-auto flex gap-2">
                <button
                  type="button"
                  aria-expanded={open === row.segmentIndex}
                  onClick={() => setOpen((o) => (o === row.segmentIndex ? null : row.segmentIndex))}
                  className="font-semibold text-[var(--accent)] hover:underline"
                >
                  {open === row.segmentIndex ? "Hide feedback" : "Show feedback"}
                </button>
                {onOpenSentence && (
                  <button type="button" onClick={() => onOpenSentence(row.segmentIndex)} className="font-semibold text-[var(--accent)] hover:underline">
                    Review sentence
                  </button>
                )}
              </span>
            </div>
            {open === row.segmentIndex && <SentencePreview row={row} />}
          </li>
        );
      })}
    </ul>
  );
}

export function ShadowingSummaryView({
  summary,
  onOpenSentence,
}: {
  summary: ShadowingRoundSummary;
  /** Opens a sentence of THIS round in the practice view (current round only). */
  onOpenSentence?: (segmentIndex: number) => void;
}) {
  const { coverage, metrics, detail } = summary;
  const scored = coverage.scoredSentences;
  const detailText = detailStatement(summary);
  const hasWords = detail.scoredWithWordDetail > 0;
  const metricEntries = (["pronunciation", "accuracy", "fluency", "completeness", "prosody"] as const)
    .map((k) => ({ k, m: metrics[k] }))
    .filter((x) => x.m !== null);
  const improvements = [...summary.wordImprovements, ...summary.sentenceImprovements];
  const hasMore =
    summary.sounds.length > 0 ||
    summary.rhythm.length > 0 ||
    summary.notRecognized.length > 0 ||
    summary.extraWords.length > 0 ||
    improvements.length > 0 ||
    summary.wellPronounced.length > 0 ||
    summary.sentences.length > 0;

  return (
    <div className="flex flex-col gap-4 text-[var(--text)]" data-testid="shadowing-summary">
      <section className="flex flex-col gap-1 text-xs text-[var(--text-muted)]" data-testid="ss-coverage">
        {coverage.recordedSentences !== null && (
          <p>
            Recorded in Shadowing: <span className="font-semibold text-[var(--text)]">{ofEligible(coverage.recordedSentences, coverage.eligibleSentences)}</span>{" "}
            (valid recordings)
          </p>
        )}
        <p>
          Scored by Azure: <span className="font-semibold text-[var(--text)]">{ofEligible(scored, coverage.eligibleSentences)}</span>
        </p>
        <p className="font-medium text-[var(--text)]" data-testid="ss-state">
          {coverageStatement(coverage)}
        </p>
      </section>

      {metricEntries.length > 0 && (
        <Section title="Azure scores (round averages)" testId="ss-metrics">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
            {metricEntries.map(({ k, m }) => (
              <div key={k} className="flex items-baseline justify-between gap-2">
                <dt className="text-xs text-[var(--text-muted)]">{METRIC_LABEL[k]}</dt>
                <dd className="text-sm font-semibold tabular-nums" title={`From ${plural(m!.sentences, "sentence")}`}>
                  {formatAggregateScore(m!.value)}
                  <span className="ml-1 text-[10px] font-normal text-[var(--text-faint)]">({m!.sentences})</span>
                </dd>
              </div>
            ))}
          </dl>
        </Section>
      )}

      {scored > 0 && (
        <Section title="Practice next" testId="ss-priorities">
          <p className="text-[11px] text-[var(--text-faint)]">
            Based only on the {plural(scored, "sentence")} scored by Azure. Words below {SHADOWING_SUMMARY_RULES.LOW_WORD_SCORE} or marked mispronounced are
            flagged; these are practice suggestions, not a diagnosis.
          </p>
          {detailText && <p className="text-xs text-[var(--text-muted)]">{detailText}</p>}
          {!hasWords ? null : summary.priorities.length === 0 ? (
            <p className="text-xs text-[var(--text-muted)]">
              No words were flagged in the {plural(detail.scoredWithWordDetail, "sentence")} with word-level feedback.
            </p>
          ) : (
            <PriorityList priorities={summary.priorities} onOpenSentence={onOpenSentence} />
          )}
        </Section>
      )}

      {coverage.wordMatchSentences > 0 && summary.wordMatchAccuracy && (
        <p className="text-xs text-[var(--text-muted)]" data-testid="ss-word-match">
          Browser recognition (Word Match): {formatAggregateScore(summary.wordMatchAccuracy.value)}% over{" "}
          {ofEligible(coverage.wordMatchSentences, coverage.eligibleSentences)} — your browser&apos;s speech recognition, not a pronunciation score.
        </p>
      )}

      {hasMore && (
        <details className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3" data-testid="ss-more">
          <summary className="cursor-pointer text-sm font-semibold">More feedback</summary>
          <div className="mt-3 flex flex-col gap-4">
            {hasWords && (
              <Section title="Sounds" testId="ss-sounds">
                {summary.sounds.length > 0 ? (
                  <ul className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
                    {summary.sounds.map((s) => (
                      <li key={s.phoneme}>
                        <span className="font-mono font-semibold text-[var(--text)]">/{s.phoneme}/</span> low in {s.lowObservations} of{" "}
                        {plural(s.observations, "observation")} (average of the low ones {formatAggregateScore(s.averageLowScore)}) · in {s.exampleWords.join(", ")}
                      </li>
                    ))}
                  </ul>
                ) : detail.scoredWithPhonemeDetail === 0 ? (
                  <p className="text-xs text-[var(--text-faint)]">Sound-level detail isn&apos;t available for these results.</p>
                ) : (
                  <p className="text-xs text-[var(--text-faint)]">
                    No low-scoring sounds in the {plural(detail.scoredWithPhonemeDetail, "sentence")} with sound-level detail.
                  </p>
                )}
              </Section>
            )}
            {summary.rhythm.length > 0 && (
              <Section title="Rhythm and intonation" testId="ss-rhythm">
                <ul className="flex flex-col gap-1 text-xs text-[var(--text-muted)]">
                  {summary.rhythm.map((r) => (
                    <li key={r.type}>
                      {RHYTHM_LABEL[r.type]}: {plural(r.occurrences, "word")} in {plural(r.sentences, "sentence")} (e.g.{" "}
                      {r.examples.map((e) => `“${e.word}”, sentence ${e.segmentIndex + 1}`).join("; ")})
                    </li>
                  ))}
                </ul>
              </Section>
            )}
            {summary.notRecognized.length > 0 && (
              <Section title="Not recognized in the recording" testId="ss-not-recognized">
                <p className="text-[11px] text-[var(--text-faint)]">
                  Azure didn&apos;t recognize these words in your recording — they may have been skipped or unclear. Not counted as pronunciation errors.
                </p>
                <p className="text-xs text-[var(--text-muted)]">
                  {summary.notRecognized.map((g) => `${g.label} (${plural(g.sentences, "sentence")})`).join(" · ")}
                </p>
              </Section>
            )}
            {summary.extraWords.length > 0 && (
              <Section title="Extra recognized words" testId="ss-extra">
                <p className="text-[11px] text-[var(--text-faint)]">Heard in your recording but not in the sentence. Not counted as pronunciation errors.</p>
                <p className="text-xs text-[var(--text-muted)]">{summary.extraWords.map((g) => g.label).join(" · ")}</p>
              </Section>
            )}
            {improvements.length > 0 && (
              <Section title="Improvement on the same sentence" testId="ss-improvements">
                <ul className="flex flex-col gap-1">
                  {improvements.map((i) => (
                    <ImprovementRow key={`${i.kind === "word" ? `w${i.position}` : "s"}-${i.segmentIndex}`} i={i} />
                  ))}
                </ul>
              </Section>
            )}
            {summary.wellPronounced.length > 0 && (
              <Section title="Consistently strong words" testId="ss-strong">
                <p className="text-xs text-[var(--text-muted)]">
                  {summary.wellPronounced.map((w) => `${w.word} ${formatAggregateScore(w.averageScore)}`).join(" · ")}
                </p>
              </Section>
            )}
            {summary.sentences.length > 0 && (
              <Section title="Sentences" testId="ss-sentences">
                <SentenceList rows={summary.sentences} onOpenSentence={onOpenSentence} />
              </Section>
            )}
          </div>
        </details>
      )}
    </div>
  );
}
