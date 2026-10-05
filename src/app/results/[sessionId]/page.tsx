"use client";

import { use, useMemo, useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { BookOpen } from "lucide-react";
import AppHeader from "@/components/AppHeader";
import VocabularySaveButton from "@/components/VocabularySaveButton";
import AIFeedbackCard from "@/components/AIFeedbackCard";
import { RoundReportPanel, parseReportSection } from "@/components/report/RoundReportPanel";
import { RoundActions } from "@/components/report/RoundActions";
import { RoundSelector, roundOptionLabel } from "@/components/report/RoundSelector";
import { useAuth } from "@/context/auth";
import { errorTypeLabel } from "@/lib/constants/errorTypes";
import { useRoundReportQuery } from "@/lib/queries/roundReport";
import { useAiAssessment } from "@/lib/ai/useAiAssessment";
import { AiAssessmentSection } from "@/components/report/AiAssessmentSection";
import type { SessionExplainAllItem, VocabularyItem } from "@/lib/types";
import type { VideoRoundList, VideoRoundOption } from "@/lib/types/learning";

interface PageProps {
  params: Promise<{ sessionId: string }>;
}

/**
 * One report per round URL (/results/<roundId>). Everything round-specific
 * below (AI explanations fetched this visit, the assessment override) lives
 * in a component keyed by the round, so switching rounds — selector,
 * Back/Forward — can never carry one round's state into another.
 */
export default function SessionResultsPage({ params }: PageProps) {
  const { sessionId } = use(params);
  const { user } = useAuth();
  // Keyed by account AND round: explanations fetched this visit can never
  // carry over to another signed-in account (Learning Reports P4).
  return <RoundResults key={`${user?.id ?? "signed-out"}:${sessionId}`} sessionId={sessionId} />;
}

/** The round being opened, from the round list already in the cache (shown while its report loads). */
function useCachedRoundOption(userId: string | undefined, roundId: string): { videoId: string; option: VideoRoundOption } | null {
  const queryClient = useQueryClient();
  if (!userId) return null;
  const lists = queryClient.getQueriesData<InfiniteData<VideoRoundList>>({ queryKey: ["history-sessions", userId, "round-list"] });
  for (const [, list] of lists) {
    for (const page of list?.pages ?? []) {
      const option = (Array.isArray(page?.items) ? page.items : []).find((r) => r.roundId === roundId);
      if (option) return { videoId: page.videoId, option };
    }
  }
  return null;
}

function RoundResults({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  // ?section= (e.g. "View Shadowing summary" links, or kept when switching rounds).
  const [initialSection] = useState(() => parseReportSection(searchParams?.get("section") ?? null));
  // The tab on screen — carried to another round so the same mode can be compared.
  const [section, setSection] = useState(initialSection);
  const { user, loading: authLoading, openAuthModal } = useAuth();

  // The whole-round report for THIS round id (never "the video's current
  // round"), user-scoped: the same query the practice page's completion view uses.
  const { data, isLoading, isError, refetch } = useRoundReportQuery(user?.id, sessionId);
  const cached = useCachedRoundOption(user?.id, sessionId);
  const videoId = data?.session.videoId ?? cached?.videoId ?? null;
  const selectedRound: VideoRoundOption | { roundId: string } = data
    ? {
        roundId: data.round.round.roundId,
        roundNumber: data.round.round.roundNumber,
        status: data.round.round.status,
        provenance: data.round.round.provenance,
        startedAt: data.round.round.startedAt,
        transcriptId: data.round.round.transcriptId,
      }
    : (cached?.option ?? { roundId: sessionId });
  // Read-only navigation to another round's canonical URL (keeps the tab).
  const goToRound = (roundId: string) => {
    const qs = section ? `?section=${section}` : "";
    router.push(`/results/${encodeURIComponent(roundId)}${qs}`);
  };

  const { data: vocabulary } = useQuery({
    queryKey: ["session-report-vocabulary", user?.id, data?.session.videoId],
    queryFn: async (): Promise<VocabularyItem[]> => {
      const res = await fetch(`/api/vocabulary?videoId=${encodeURIComponent(data!.session.videoId)}`);
      if (!res.ok) throw new Error("Failed to fetch vocabulary");
      const json = await res.json();
      return json.items ?? [];
    },
    enabled: !!user && !!data?.session.videoId,
  });

  // Learning Reports P5: explicit AI actions, unsaved output and recovery.
  // Mounted per (account, round) — this component is keyed by both.
  const ai = useAiAssessment({ userId: user?.id ?? "", roundId: sessionId, generating: !!data?.ai?.generating });

  // Saved explanations from the report (authoritative, with their relation to
  // each answer) first; generated-but-unsaved notes only fill gaps and are
  // flagged "Not saved".
  const segmentOfAttempt = useMemo(() => new Map((data?.mistakes ?? []).map((m) => [m.attemptId, m.segmentIndex])), [data]);
  const explanationByAttemptId = useMemo(() => {
    const map: Record<string, SessionExplainAllItem> = {};
    for (const mistake of data?.mistakes ?? []) {
      if (!mistake.aiFeedback) continue;
      const { via, viaSegmentIndex, historical, legacy, kind, refSegmentIndex, ...note } = mistake.aiFeedback;
      const context = via ? { context: { via, viaSegmentIndex, historical: !!historical, legacy: !!legacy } } : {};
      map[mistake.attemptId] =
        kind === "minor"
          ? { attemptId: mistake.attemptId, status: "minor", explanation: "", correctedText: "", example: "", note: note.explanation }
          : kind === "duplicate"
            ? { attemptId: mistake.attemptId, status: "duplicate", explanation: "", correctedText: "", example: "", note: note.explanation, duplicateOfSegmentIndex: refSegmentIndex }
            : { attemptId: mistake.attemptId, status: "explained", ...note, ...context };
    }
    for (const [attemptId, n] of Object.entries(ai.unsavedNotes)) {
      if (map[attemptId]) continue;
      map[attemptId] =
        n.kind === "explanation"
          ? { attemptId, status: "explained", explanation: n.explanation, correctedText: n.correctedText ?? "", example: n.example ?? "", unsaved: true }
          : n.kind === "duplicate"
            ? { attemptId, status: "duplicate", explanation: "", correctedText: "", example: "", note: n.explanation, duplicateOfSegmentIndex: n.refAttemptId ? segmentOfAttempt.get(n.refAttemptId) : undefined, unsaved: true }
            : { attemptId, status: "minor", explanation: "", correctedText: "", example: "", note: n.explanation, unsaved: true };
    }
    return map;
  }, [data, ai.unsavedNotes, segmentOfAttempt]);

  // Explicit re-explanation: the learner picks sentences with saved notes (≤ 35).
  const [reexplainSelection, setReexplainSelection] = useState<number[]>([]);
  const toggleReexplain = (segmentIndex: number) =>
    setReexplainSelection((prev) =>
      prev.includes(segmentIndex) ? prev.filter((s) => s !== segmentIndex) : prev.length >= 35 ? prev : [...prev, segmentIndex]
    );

  // Saved AI explanations, by sentence: a sentence's explained mistake is
  // its latest incorrect answer (the report route's `mistakes`).
  const mistakeBySegment = useMemo(() => new Map((data?.mistakes ?? []).map((m) => [m.segmentIndex, m])), [data]);
  const handleJumpToDuplicate = (segmentIndex: number) => {
    requestAnimationFrame(() => {
      document.getElementById(`report-sentence-${segmentIndex}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  };

  return (
    <div className="report-light-theme relative flex min-h-screen w-full flex-col overflow-hidden bg-[#f4f7ff] font-sans text-slate-900 antialiased">
      <div className="pointer-events-none absolute -left-[10%] -top-[10%] z-0 h-[40%] w-[40%] rounded-full bg-purple-200 opacity-60 blur-[120px]" />
      <div className="pointer-events-none absolute bottom-[10%] right-[0%] z-0 h-[40%] w-[40%] rounded-full bg-blue-200 opacity-60 blur-[120px]" />

      <div className="relative z-10 flex flex-1 flex-col">
        <AppHeader active="history" />

        <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-8 px-4 py-8">
          {authLoading ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : !user ? (
            <section className="rounded-3xl border border-white/60 bg-white/40 p-8 shadow-xl backdrop-blur-xl">
              <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Round Report</h1>
              <p className="mt-2 text-sm text-slate-500">Sign in to view this round&apos;s report.</p>
              <button
                onClick={openAuthModal}
                className="mt-4 rounded-xl bg-primary-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary-700"
              >
                Sign in
              </button>
            </section>
          ) : (
            <>
              <section className="flex flex-col items-start justify-between gap-4 border-b border-white/40 pb-6 md:flex-row md:items-end">
                <div className="min-w-0">
                  <p className="mb-1 text-xs font-semibold uppercase tracking-widest text-primary-600">Round report</p>
                  <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
                    {data ? (data.session.videoTitle ?? `Video ${data.session.videoId}`) : isError ? "Round report" : "Loading report…"}
                  </h1>
                  <p className="mt-1 text-sm text-slate-500" data-testid="results-round-line">
                    {data
                      ? `Round ${data.round.round.roundNumber} · last practiced ${new Date(data.session.updatedAt).toLocaleString()}`
                      : "startedAt" in selectedRound
                        ? roundOptionLabel(selectedRound)
                        : null}
                  </p>
                  {data && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Link
                        href={`/dictation/${data.session.videoId}`}
                        className="rounded-xl bg-primary-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-primary-700"
                      >
                        Open video
                      </Link>
                      <Link
                        href="/dashboard"
                        className="rounded-xl border border-white/60 bg-white/60 px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition-colors hover:bg-white"
                      >
                        Library
                      </Link>
                    </div>
                  )}
                </div>
                {videoId && <RoundSelector userId={user.id} videoId={videoId} selected={selectedRound} onSelect={goToRound} />}
              </section>

              {isLoading ? (
                <p className="text-sm text-slate-500">
                  {"startedAt" in selectedRound ? `Loading Round ${selectedRound.roundNumber}'s report…` : "Loading report…"}
                </p>
              ) : isError || !data ? (
                <p className="text-sm text-red-600" role="alert">
                  Failed to load this round&apos;s report.{" "}
                  <button type="button" onClick={() => refetch()} className="font-semibold underline">
                    Retry
                  </button>
                </p>
              ) : (
            <>
              <section className="rounded-3xl border border-white/60 bg-white/50 p-5 shadow-xl backdrop-blur-md">
                <RoundReportPanel
                  report={data.round}
                  dictationEvidence={data.dictationEvidence}
                  transcriptVersion={data.transcriptVersion ?? null}
                  listening={data.listening ?? null}
                  defaultSection={initialSection ?? undefined}
                  onSectionChange={(next) => {
                    setSection(next);
                    // Shareable/back-safe section without a navigation (?section=).
                    const url = new URL(window.location.href);
                    url.searchParams.set("section", next);
                    window.history.replaceState(window.history.state, "", url);
                  }}
                  userId={user.id}
                  shadowingFeedback="open"
                  actions={<RoundActions report={data.round} newerActiveRound={data.newerActiveRound ?? null} hideViewReport />}
                  renderSentenceExtra={(sentence) => {
                    const mistake = mistakeBySegment.get(sentence.segmentIndex);
                    const feedback = mistake ? explanationByAttemptId[mistake.attemptId] : undefined;
                    return (
                      <>
                        {feedback && <AIFeedbackCard feedback={feedback} onJumpToDuplicate={handleJumpToDuplicate} />}
                        {feedback && !feedback.unsaved && (
                          <label className="mt-1 inline-flex items-center gap-1.5 text-xs text-violet-600">
                            <input
                              type="checkbox"
                              checked={reexplainSelection.includes(sentence.segmentIndex)}
                              onChange={() => toggleReexplain(sentence.segmentIndex)}
                            />
                            Re-explain
                          </label>
                        )}
                        {sentence.text && (
                          <VocabularySaveButton
                            videoId={data.session.videoId}
                            segmentIndex={sentence.segmentIndex}
                            sentenceContext={sentence.text}
                          />
                        )}
                      </>
                    );
                  }}
                />
              </section>

              {data.explanationsUnavailable && (
                <p role="status" className="text-sm text-amber-700">
                  Saved AI explanations couldn&apos;t be loaded right now. The rest of this report is complete.
                </p>
              )}

              {(data.mistakes.length > 0 || data.ai?.accepted || data.ai?.legacy || ai.pending.length > 0) && (
                <AiAssessmentSection
                  view={data.ai ?? null}
                  ai={ai}
                  selectedForReexplain={reexplainSelection}
                  onClearSelection={() => setReexplainSelection([])}
                />
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
            </>
          )}
        </main>
      </div>
    </div>
  );
}
