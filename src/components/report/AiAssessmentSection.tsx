"use client";

import { AlertTriangle, Lightbulb, Loader2, Sparkles, ThumbsUp } from "lucide-react";
import { clsx } from "clsx";
import type { ReportAiView } from "@/lib/ai/types";
import type { useAiAssessment } from "@/lib/ai/useAiAssessment";

const COST = "Uses up to 2 AI requests.";
const MAX_BATCH = 35;

type Ai = ReturnType<typeof useAiAssessment>;

function QuotaLine({ quota }: { quota: Ai["quota"] }) {
  if (!quota) return null;
  if (!quota.configured) return <p className="text-[11px] text-violet-500">AI usage isn&apos;t tracked on this server.</p>;
  const left = Math.max(quota.rpdLimit - quota.rpdUsed, 0);
  const userLeft = quota.userRpdLimit !== undefined ? Math.max(quota.userRpdLimit - (quota.userRpdUsed ?? 0), 0) : null;
  return (
    <p className="text-[11px] text-violet-500" data-testid="ai-quota">
      {left}/{quota.rpdLimit} AI requests left today (shared app limit)
      {userLeft !== null ? ` · ${userLeft}/${quota.userRpdLimit} for you` : ""} · resets {quota.resetsAt}
    </p>
  );
}

/**
 * The report page's AI block (Learning Reports P5). Shows the saved
 * assessment (or the legacy one, labelled), its freshness and version as two
 * separate facts, explicit costed actions, partial coverage and unsaved
 * output. Never starts anything by itself.
 */
export function AiAssessmentSection({
  view,
  ai,
  selectedForReexplain,
  onClearSelection,
}: {
  view: ReportAiView | null;
  ai: Ai;
  selectedForReexplain: number[];
  onClearSelection: () => void;
}) {
  const accepted = ai.unsavedOverview?.payload
    ? { payload: ai.unsavedOverview.payload, meta: ai.unsavedOverview.meta ?? null, unsaved: true as const }
    : view?.accepted
      ? { payload: view.accepted.payload, meta: view.accepted.meta, unsaved: false as const }
      : null;
  const legacy = !accepted ? view?.legacy ?? null : null;
  const quotaExhausted = Boolean(
    ai.quota?.configured && (ai.quota.rpdUsed >= ai.quota.rpdLimit || (ai.quota.userRpdLimit !== undefined && (ai.quota.userRpdUsed ?? 0) >= ai.quota.userRpdLimit))
  );
  const disabled = ai.busy !== null || quotaExhausted || ai.polling;

  // Two separate facts, two separate labels — never merged, never automatic.
  let state: { label: string; action: string | null } = { label: "No AI assessment yet.", action: "Generate assessment" };
  if (view?.accepted && !ai.unsavedOverview) {
    if (!view.accepted.fresh) state = { label: "Practice changed since this assessment.", action: "Update assessment" };
    else if (!view.accepted.contentCurrent) state = { label: "Made with an earlier assessment version.", action: "Regenerate assessment" };
    else state = { label: "Based on your current answers.", action: null };
  } else if (legacy) {
    state = { label: "Earlier assessment (earlier format, freshness unknown).", action: "Generate assessment" };
  } else if (ai.unsavedOverview) {
    state = { label: "Not saved yet.", action: null };
  }
  const missing = view?.targets.missing ?? 0;

  return (
    <section className="rounded-3xl border border-violet-200 bg-violet-50/60 p-5 shadow-xl backdrop-blur-md" aria-labelledby="ai-assessment-heading">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="ai-assessment-heading" className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-violet-900">
            <Sparkles size={16} className="text-violet-600" />
            AI Assessment
          </h2>
          <p className="mt-1 text-xs text-violet-700" data-testid="ai-state">
            {ai.polling ? (
              <span className="inline-flex items-center gap-1">
                <Loader2 size={12} className="animate-spin" /> Generating a new assessment…
                {accepted || legacy ? " The last saved one stays shown until then." : ""}
              </span>
            ) : (
              state.label
            )}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          {state.action && (
            <button
              type="button"
              onClick={ai.generate}
              disabled={disabled}
              className={clsx(
                "flex items-center gap-1.5 rounded-full px-4 py-1.5 text-xs font-semibold transition-colors",
                disabled ? "cursor-not-allowed bg-violet-100 text-violet-300" : "bg-violet-600 text-white hover:bg-violet-700"
              )}
            >
              <Sparkles size={13} />
              {ai.busy === "generate" ? "Generating…" : state.action}
            </button>
          )}
          {state.action && <p className="text-[11px] text-violet-500">{COST}</p>}
          <QuotaLine quota={ai.quota} />
        </div>
      </div>

      {ai.messages.length > 0 && (
        <ul className="mb-3 flex flex-col gap-1" aria-live="polite">
          {ai.messages.map((m, i) => (
            <li key={i} role={m.tone === "error" ? "alert" : undefined} className={clsx("text-sm", m.tone === "error" ? "text-red-600" : m.tone === "warn" ? "text-amber-700" : "text-violet-800")}>
              {m.text}
            </li>
          ))}
        </ul>
      )}

      {ai.pending.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800" role="status">
          <span>Not saved yet — {ai.pending.length === 1 ? "1 result" : `${ai.pending.length} results`} waiting.</span>
          <button type="button" onClick={ai.saveNow} disabled={ai.busy !== null} className="rounded-full bg-amber-600 px-3 py-1 text-xs font-semibold text-white disabled:opacity-50">
            {ai.busy === "save" ? "Saving…" : "Save"}
          </button>
          {ai.storageWarning && <span className="text-xs">This browser can&apos;t keep it across a reload — save before leaving.</span>}
        </div>
      )}

      {accepted ? (
        <div className="flex flex-col gap-4">
          {accepted.meta && (
            <p className="text-xs font-medium text-violet-500" data-testid="ai-disclosure">
              Gemini saw {accepted.meta.evidence.individual} sentence{accepted.meta.evidence.individual === 1 ? "" : "s"} individually
              {accepted.meta.evidence.aggregateOnly > 0 ? ` and ${accepted.meta.evidence.aggregateOnly} only as counts` : ""}; the statistics above cover every sentence.
              {accepted.meta.truncated ? " The response was cut off, so it may be incomplete." : ""}
              {accepted.meta.generatedAt ? ` Generated ${new Date(accepted.meta.generatedAt).toLocaleString()}.` : ""}
            </p>
          )}
          <p className="text-base font-medium leading-relaxed text-violet-950">{accepted.payload.overview}</p>
          <div className="grid gap-4 sm:grid-cols-2">
            {accepted.payload.strengths.length > 0 && (
              <div className="rounded-2xl border border-emerald-200 bg-white/70 p-4">
                <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-emerald-700">
                  <ThumbsUp size={14} /> Strengths
                </p>
                <ul className="flex flex-col gap-1.5 text-sm text-slate-700">
                  {accepted.payload.strengths.map((s, i) => (
                    <li key={i}>
                      {s.text} <span className="text-xs text-slate-400">({s.evidenceIds.join(", ")})</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {accepted.payload.priorities.length > 0 && (
              <div className="rounded-2xl border border-amber-200 bg-white/70 p-4">
                <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-amber-700">
                  <AlertTriangle size={14} /> Priorities
                </p>
                <ul className="flex flex-col gap-2 text-sm text-slate-700">
                  {accepted.payload.priorities.map((p, i) => (
                    <li key={i}>
                      <span className="font-semibold">{p.title}</span> — {p.explanation}{" "}
                      <span className="text-xs text-slate-400">({p.evidenceIds.join(", ")})</span>
                      <br />
                      <span className="text-xs text-slate-500">Practice: {p.practice}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          {accepted.payload.practicePlan.length > 0 && (
            <div className="flex items-start gap-2 rounded-2xl border border-primary-200 bg-white/70 p-4">
              <Lightbulb size={16} className="mt-0.5 shrink-0 text-primary-600" />
              <ol className="list-decimal pl-4 text-sm text-slate-700">
                {accepted.payload.practicePlan.map((step, i) => (
                  <li key={i}>{step}</li>
                ))}
              </ol>
            </div>
          )}
          {accepted.payload.limitations.length > 0 && (
            <p className="text-xs text-slate-500">Limitations: {accepted.payload.limitations.join(" ")}</p>
          )}
        </div>
      ) : legacy ? (
        <div className="flex flex-col gap-3">
          <p className="text-base font-medium leading-relaxed text-violet-950">{legacy.verdict}</p>
          {legacy.strengths.length > 0 && <p className="text-sm text-slate-700">Strengths: {legacy.strengths.join(" · ")}</p>}
          {legacy.weaknesses.length > 0 && <p className="text-sm text-slate-700">Areas to improve: {legacy.weaknesses.join(" · ")}</p>}
          {legacy.recommendation && <p className="text-sm text-slate-700">Recommendation: {legacy.recommendation}</p>}
        </div>
      ) : (
        <p className="text-sm text-violet-700">
          Reviews this round&apos;s answers and gives an overview, strengths, priorities and a short practice plan, plus explanations
          for up to {MAX_BATCH} distinct mistakes. Nothing is generated until you ask.
        </p>
      )}

      {(missing > 0 || selectedForReexplain.length > 0) && (
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-violet-200 pt-3">
          {missing > 0 && (
            <button
              type="button"
              onClick={ai.explainMore}
              disabled={disabled}
              className="rounded-full border border-violet-300 bg-white px-3 py-1 text-xs font-semibold text-violet-700 disabled:opacity-50"
            >
              {ai.busy === "explain" ? "Explaining…" : `Explain next ${Math.min(MAX_BATCH, missing)} of ${missing}`}
            </button>
          )}
          {selectedForReexplain.length > 0 && (
            <>
              <button
                type="button"
                onClick={() => {
                  void ai.reexplain(selectedForReexplain);
                  onClearSelection();
                }}
                disabled={disabled}
                className="rounded-full border border-violet-300 bg-white px-3 py-1 text-xs font-semibold text-violet-700 disabled:opacity-50"
              >
                Re-explain {selectedForReexplain.length} selected
              </button>
              <button type="button" onClick={onClearSelection} className="text-xs text-violet-500 underline">
                Clear selection
              </button>
            </>
          )}
          <span className="text-[11px] text-violet-500">{COST} Earlier explanations stay saved.</span>
        </div>
      )}
    </section>
  );
}
