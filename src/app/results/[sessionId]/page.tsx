"use client";

import { use, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Lightbulb,
  ListChecks,
  Repeat,
  Sparkles,
  Target,
  ThumbsUp,
} from "lucide-react";
import { clsx } from "clsx";
import AppHeader from "@/components/AppHeader";
import MetricCard from "@/components/MetricCard";
import VocabularySaveButton from "@/components/VocabularySaveButton";
import AIFeedbackCard from "@/components/AIFeedbackCard";
import { useAuth } from "@/context/auth";
import { checkAnswer } from "@/lib/utils/text";
import { errorTypeLabel } from "@/lib/constants/errorTypes";
import { formatDurationSeconds } from "@/lib/utils/time";
import type {
  SessionAssessment,
  SessionExplainAllItem,
  SessionExplainAllResponse,
  SessionReportResponse,
  VocabularyItem,
} from "@/lib/types";

interface PageProps {
  params: Promise<{ sessionId: string }>;
}

interface GeminiQuotaStatus {
  configured: boolean;
  rpdUsed: number;
  rpdLimit: number;
}

export default function SessionResultsPage({ params }: PageProps) {
  const { sessionId } = use(params);
  const { user, loading: authLoading, openAuthModal } = useAuth();

  const { data, isLoading, isError } = useQuery({
    queryKey: ["session-report", sessionId],
    queryFn: async (): Promise<SessionReportResponse> => {
      const res = await fetch(`/api/session/${sessionId}/report`);
      if (!res.ok) throw new Error("Failed to fetch session report");
      return res.json();
    },
    enabled: !!user,
  });

  const { data: vocabulary } = useQuery({
    queryKey: ["session-report-vocabulary", data?.session.videoId],
    queryFn: async (): Promise<VocabularyItem[]> => {
      const res = await fetch(`/api/vocabulary?videoId=${encodeURIComponent(data!.session.videoId)}`);
      if (!res.ok) throw new Error("Failed to fetch vocabulary");
      const json = await res.json();
      return json.items ?? [];
    },
    enabled: !!user && !!data?.session.videoId,
  });

  // Explanations already cached (from the report load) merged with anything
  // this page's "Explain all" call has fetched since — a single bulk request
  // covers every mistake in the session instead of one AI call per row.
  const [bulkExplanations, setBulkExplanations] = useState<Record<string, SessionExplainAllItem>>({});
  const explanationByAttemptId = useMemo(() => {
    const map: Record<string, SessionExplainAllItem> = {};
    for (const mistake of data?.mistakes ?? []) {
      if (mistake.aiFeedback) {
        map[mistake.attemptId] = { attemptId: mistake.attemptId, status: "explained", ...mistake.aiFeedback };
      }
    }
    return { ...map, ...bulkExplanations };
  }, [data, bulkExplanations]);

  const attemptIdBySegmentIndex = useMemo(() => {
    const map = new Map<number, string>();
    for (const mistake of data?.mistakes ?? []) map.set(mistake.segmentIndex, mistake.attemptId);
    return map;
  }, [data]);

  // Overrides the persisted assessment once a fresh "Explain all" call
  // completes this visit; until then, whatever was saved from a previous
  // visit (loaded with the report) is what's shown.
  const [assessmentOverride, setAssessmentOverride] = useState<SessionAssessment | null>(null);
  const assessment = assessmentOverride ?? data?.session.assessment ?? null;
  const assessmentGeneratedAt = assessmentOverride ? null : (data?.session.assessmentGeneratedAt ?? null);
  const [mistakesReviewed, setMistakesReviewed] = useState<number | null>(null);
  const alreadyExplained = assessment !== null || Object.keys(bulkExplanations).length > 0;

  const [explainAllLoading, setExplainAllLoading] = useState(false);
  const [explainAllError, setExplainAllError] = useState<string | null>(null);
  const [explainAllNotice, setExplainAllNotice] = useState<string | null>(null);
  const [quota, setQuota] = useState<GeminiQuotaStatus | null>(null);

  const refreshQuota = () => {
    void fetch("/api/ai/quota")
      .then((res) => (res.ok ? (res.json() as Promise<GeminiQuotaStatus>) : null))
      .then(setQuota)
      .catch(() => {});
  };

  useEffect(() => {
    if (data && data.mistakes.length > 0) refreshQuota();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!data]);

  const quotaExhausted = Boolean(quota?.configured && quota.rpdUsed >= quota.rpdLimit);

  const handleExplainAll = async () => {
    if (explainAllLoading || quotaExhausted) return;
    setExplainAllLoading(true);
    setExplainAllError(null);
    setExplainAllNotice(null);
    try {
      const res = await fetch(`/api/session/${sessionId}/explain-all`, { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "AI request failed.");
      }
      const json: SessionExplainAllResponse = await res.json();
      setBulkExplanations((prev) => {
        const next = { ...prev };
        for (const item of json.items) next[item.attemptId] = item;
        return next;
      });
      setAssessmentOverride(json.assessment);
      setMistakesReviewed(json.mistakesReviewed);
      if (json.truncated) {
        setExplainAllNotice(
          `This session has more than ${json.uniquePatternsExplained} distinct kinds of mistakes — the first ${json.uniquePatternsExplained} got a full explanation (exact repeats and minor slips don't count against that).`
        );
      }
    } catch (err) {
      setExplainAllError(err instanceof Error ? err.message : "Failed to get AI explanations.");
    } finally {
      setExplainAllLoading(false);
      refreshQuota();
    }
  };

  const [expandedAttemptIds, setExpandedAttemptIds] = useState<Set<string>>(new Set());
  const toggleExpanded = (attemptId: string) => {
    setExpandedAttemptIds((prev) => {
      const next = new Set(prev);
      if (next.has(attemptId)) next.delete(attemptId);
      else next.add(attemptId);
      return next;
    });
  };

  const handleJumpToDuplicate = (segmentIndex: number) => {
    const attemptId = attemptIdBySegmentIndex.get(segmentIndex);
    if (!attemptId) return;
    setExpandedAttemptIds((prev) => new Set(prev).add(attemptId));
    requestAnimationFrame(() => {
      document.getElementById(`mistake-${segmentIndex}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  };

  return (
    <div className="relative flex min-h-screen w-full flex-col overflow-hidden bg-[#f4f7ff] font-sans text-slate-900 antialiased">
      <div className="pointer-events-none absolute -left-[10%] -top-[10%] z-0 h-[40%] w-[40%] rounded-full bg-purple-200 opacity-60 blur-[120px]" />
      <div className="pointer-events-none absolute bottom-[10%] right-[0%] z-0 h-[40%] w-[40%] rounded-full bg-blue-200 opacity-60 blur-[120px]" />

      <div className="relative z-10 flex flex-1 flex-col">
        <AppHeader active="history" />

        <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-8 px-4 py-8">
          {authLoading ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : !user ? (
            <section className="rounded-3xl border border-white/60 bg-white/40 p-8 shadow-xl backdrop-blur-xl">
              <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Session Report</h1>
              <p className="mt-2 text-sm text-slate-500">Sign in to view this session&apos;s results.</p>
              <button
                onClick={openAuthModal}
                className="mt-4 rounded-xl bg-primary-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary-700"
              >
                Sign in
              </button>
            </section>
          ) : isLoading ? (
            <p className="text-sm text-slate-500">Loading report…</p>
          ) : isError || !data ? (
            <p className="text-sm text-red-600">Failed to load this session&apos;s report.</p>
          ) : (
            <>
              <section className="flex flex-col items-start justify-between gap-4 border-b border-white/40 pb-6 md:flex-row md:items-end">
                <div>
                  <p className="mb-1 text-xs font-semibold uppercase tracking-widest text-primary-600">
                    {data.session.status === "completed" ? "Session complete" : "In progress"}
                  </p>
                  <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
                    {data.session.videoTitle ?? `Video ${data.session.videoId}`}
                  </h1>
                  <p className="mt-1 text-sm text-slate-500">
                    Last practiced {new Date(data.session.updatedAt).toLocaleString()}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Link
                    href={`/dictation/${data.session.videoId}`}
                    className="rounded-xl bg-primary-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-primary-700"
                  >
                    {data.session.status === "completed" ? "Practice again" : "Continue"}
                  </Link>
                </div>
              </section>

              <section className="grid grid-cols-2 gap-4 md:grid-cols-4">
                <MetricCard title="Accuracy" value={`${data.session.accuracy}%`} icon={<Target size={20} />} positive />
                <MetricCard title="Attempts" value={String(data.session.totalAttempts)} icon={<Repeat size={20} />} />
                <MetricCard
                  title="Segments"
                  value={
                    data.session.totalSegments
                      ? `${Math.min(data.session.currentSegmentIndex, data.session.totalSegments)}/${data.session.totalSegments}`
                      : String(data.session.currentSegmentIndex)
                  }
                  icon={<ListChecks size={20} />}
                />
                <MetricCard title="Time spent" value={formatDurationSeconds(data.session.durationSec)} icon={<Clock size={20} />} />
              </section>

              {data.mistakes.length > 0 && (
                <section className="rounded-3xl border border-violet-200 bg-violet-50/60 p-5 shadow-xl backdrop-blur-md">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                    <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-violet-900">
                      <Sparkles size={16} className="text-violet-600" />
                      AI Assessment
                    </h2>
                    <div className="flex flex-col items-end gap-1">
                      <button
                        onClick={handleExplainAll}
                        disabled={explainAllLoading || quotaExhausted}
                        title={quotaExhausted ? "Daily AI quota reached — try again tomorrow" : undefined}
                        className={clsx(
                          "flex items-center gap-1.5 rounded-full px-4 py-1.5 text-xs font-semibold transition-colors",
                          explainAllLoading
                            ? "bg-violet-200 text-violet-400 cursor-wait"
                            : quotaExhausted
                              ? "bg-violet-100 text-violet-300 cursor-not-allowed"
                              : "bg-violet-600 text-white hover:bg-violet-700"
                        )}
                      >
                        <Sparkles size={13} />
                        {explainAllLoading
                          ? "Analyzing session…"
                          : quotaExhausted
                            ? "Quota reached"
                            : alreadyExplained
                              ? "Re-run assessment"
                              : "Get AI assessment"}
                      </button>
                      {quota?.configured && !explainAllLoading && (
                        <p className="text-[11px] text-violet-500">
                          {quotaExhausted
                            ? "Daily AI quota reached — try again tomorrow."
                            : `${Math.max(quota.rpdLimit - quota.rpdUsed, 0)}/${quota.rpdLimit} AI calls left today`}
                        </p>
                      )}
                    </div>
                  </div>

                  {explainAllError && (
                    <p role="alert" className="mb-3 text-sm text-red-600">
                      ⚠ {explainAllError}
                    </p>
                  )}
                  {explainAllNotice && <p className="mb-3 text-sm text-amber-600">{explainAllNotice}</p>}

                  {!assessment ? (
                    <p className="text-sm text-violet-700">
                      Reviews every mistake in this session — however many there are — and gives you a full
                      performance review: strengths, recurring weaknesses, and a concrete next step. Distinct
                      mistakes also get a detailed explanation below; exact repeats and minor slips are tagged
                      instead of repeated.
                    </p>
                  ) : (
                    <div className="flex flex-col gap-4">
                      {mistakesReviewed !== null ? (
                        <p className="text-xs font-medium text-violet-500">
                          Based on all {mistakesReviewed} mistake{mistakesReviewed !== 1 ? "s" : ""} in this session.
                        </p>
                      ) : (
                        assessmentGeneratedAt && (
                          <p className="text-xs font-medium text-violet-500">
                            Generated {new Date(assessmentGeneratedAt).toLocaleString()}.
                          </p>
                        )
                      )}
                      <p className="text-base font-medium leading-relaxed text-violet-950">{assessment.verdict}</p>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <div className="rounded-2xl border border-emerald-200 bg-white/70 p-4">
                          <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-emerald-700">
                            <ThumbsUp size={14} /> Strengths
                          </p>
                          <ul className="flex flex-col gap-1.5 text-sm text-slate-700">
                            {assessment.strengths.map((strength, i) => (
                              <li key={i} className="flex gap-1.5">
                                <span className="text-emerald-500">•</span>
                                {strength}
                              </li>
                            ))}
                          </ul>
                        </div>
                        <div className="rounded-2xl border border-amber-200 bg-white/70 p-4">
                          <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-amber-700">
                            <AlertTriangle size={14} /> Areas to improve
                          </p>
                          <ul className="flex flex-col gap-1.5 text-sm text-slate-700">
                            {assessment.weaknesses.map((weakness, i) => (
                              <li key={i} className="flex gap-1.5">
                                <span className="text-amber-500">•</span>
                                {weakness}
                              </li>
                            ))}
                          </ul>
                        </div>
                      </div>
                      <div className="flex items-start gap-2 rounded-2xl border border-primary-200 bg-white/70 p-4">
                        <Lightbulb size={16} className="mt-0.5 shrink-0 text-primary-600" />
                        <p className="text-sm text-slate-700">
                          <span className="font-semibold text-primary-700">Recommendation: </span>
                          {assessment.recommendation}
                        </p>
                      </div>
                    </div>
                  )}
                </section>
              )}

              {data.errorBreakdown.length > 0 && (
                <section className="rounded-3xl border border-white/60 bg-white/50 p-5 shadow-xl backdrop-blur-md">
                  <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-900">
                    Mistake breakdown
                  </h2>
                  <ul className="flex flex-col gap-3">
                    {data.errorBreakdown.map((pattern) => (
                      <li key={pattern.errorType}>
                        <div className="mb-1 flex justify-between text-xs font-medium text-slate-600">
                          <span>{errorTypeLabel(pattern.errorType)}</span>
                          <span className="text-slate-400">{pattern.count}</span>
                        </div>
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                          <div
                            className="h-full rounded-full bg-primary-500"
                            style={{ width: `${Math.min(100, Math.max(0, pattern.percentage))}%` }}
                          />
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <section className="flex flex-col gap-3 pb-4">
                <div>
                  <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-slate-900">
                    <ListChecks size={16} className="text-primary-600" />
                    Mistakes ({data.mistakes.length})
                  </h2>
                  {data.mistakes.length > 0 && (
                    <p className="mt-1 text-xs text-slate-500">
                      In order of appearance
                      {data.session.totalSegments ? ` — out of ${data.session.totalSegments} sentences in the video` : ""}
                      . Click a sentence to see the details.
                    </p>
                  )}
                </div>
                {data.mistakes.length === 0 ? (
                  <div className="flex items-center gap-2 rounded-3xl border border-emerald-200 bg-emerald-50/60 p-4 text-sm font-medium text-emerald-700 shadow-sm backdrop-blur-md">
                    <CheckCircle2 size={18} /> Perfect session — no mistakes!
                  </div>
                ) : (
                  <ol className="flex flex-col">
                    {data.mistakes.map((mistake, idx) => {
                      const isLast = idx === data.mistakes.length - 1;
                      const isExpanded = expandedAttemptIds.has(mistake.attemptId);
                      const feedback = explanationByAttemptId[mistake.attemptId];
                      const diff = checkAnswer(mistake.expectedText, mistake.userText, "relaxed").diff;
                      return (
                        <li
                          key={mistake.segmentIndex}
                          id={`mistake-${mistake.segmentIndex}`}
                          className="flex gap-3 pb-3 last:pb-0 scroll-mt-4"
                        >
                          <div className="flex w-8 shrink-0 flex-col items-center">
                            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-primary-200 bg-primary-50 text-xs font-bold text-primary-700">
                              {mistake.segmentIndex + 1}
                            </div>
                            {!isLast && <div className="mt-1 w-px flex-1 bg-slate-200" />}
                          </div>

                          <div className="min-w-0 flex-1 rounded-xl border border-white/60 bg-white/50 shadow-sm backdrop-blur-md">
                            <button
                              type="button"
                              onClick={() => toggleExpanded(mistake.attemptId)}
                              aria-expanded={isExpanded}
                              className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
                            >
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400">
                                  <span>
                                    Sentence {mistake.segmentIndex + 1}
                                    {data.session.totalSegments ? ` of ${data.session.totalSegments}` : ""}
                                  </span>
                                  {mistake.errorType && (
                                    <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-600">
                                      {errorTypeLabel(mistake.errorType)}
                                    </span>
                                  )}
                                  {mistake.attempts > 1 && <span>{mistake.attempts} attempts</span>}
                                  {feedback?.status === "explained" && <span className="text-violet-500">🤖 explained</span>}
                                  {feedback?.status === "duplicate" && <span className="text-slate-400">🔁 duplicate</span>}
                                  {feedback?.status === "minor" && <span className="text-slate-400">◦ minor</span>}
                                </div>
                                <p className="mt-0.5 truncate text-sm text-slate-800">{mistake.expectedText}</p>
                              </div>
                              {isExpanded ? (
                                <ChevronDown size={16} className="shrink-0 text-slate-400" />
                              ) : (
                                <ChevronRight size={16} className="shrink-0 text-slate-400" />
                              )}
                            </button>

                            {isExpanded && (
                              <div className="flex flex-col gap-2 border-t border-white/60 px-3 pb-3 pt-2">
                                <p className="text-sm text-slate-800">
                                  {diff
                                    .filter((t) => t.status !== "extra")
                                    .map((t, i) => (
                                      <span
                                        key={i}
                                        className={
                                          t.status === "correct"
                                            ? undefined
                                            : "font-semibold text-red-600 underline decoration-red-300"
                                        }
                                      >
                                        {t.word}{" "}
                                      </span>
                                    ))}
                                </p>
                                <p className="text-xs text-red-500">
                                  You typed:{" "}
                                  {mistake.userText || <span className="italic text-slate-400">nothing</span>}
                                </p>
                                <VocabularySaveButton
                                  videoId={data.session.videoId}
                                  segmentIndex={mistake.segmentIndex}
                                  sentenceContext={mistake.expectedText}
                                />
                                {feedback && (
                                  <AIFeedbackCard feedback={feedback} onJumpToDuplicate={handleJumpToDuplicate} />
                                )}
                              </div>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </section>

              {vocabulary && vocabulary.length > 0 && (
                <section className="flex flex-col gap-3 rounded-3xl border border-white/60 bg-white/50 p-5 shadow-xl backdrop-blur-md mb-12">
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-slate-900">
                      <BookOpen size={16} className="text-primary-600" />
                      Vocabulary saved from this video ({vocabulary.length})
                    </h2>
                    <Link
                      href="/vocabulary/review"
                      className="shrink-0 rounded-xl bg-primary-600 px-4 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-primary-700"
                    >
                      Practice these words
                    </Link>
                  </div>
                  <ul className="flex flex-wrap gap-2">
                    {vocabulary.map((item) => (
                      <li
                        key={item.id}
                        className="rounded-full border border-white/60 bg-white/70 px-3 py-1 text-xs font-medium text-slate-700"
                        title={item.sentence_context}
                      >
                        {item.term}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
