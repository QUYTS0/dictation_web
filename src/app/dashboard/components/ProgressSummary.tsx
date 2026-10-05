import { formatAggregateScore } from "@/lib/practice/scoreFormat";
import { formatDurationSeconds } from "@/lib/utils/time";
import type { DashboardSummary } from "@/lib/types/learning";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * "Your progress" — one surface for the six canonical summary metrics,
 * never recomputed here (§6.8, each its own number, never blended):
 *   primary   — est. active practice, sentence accuracy, pronunciation;
 *   secondary — in progress / listened through / completed video counts,
 *               mentioned only when non-zero.
 */
export function ProgressSummary({ summary }: { summary: DashboardSummary }) {
  const { activeTime, sentenceAccuracy: acc, shadowing } = summary;
  const azure = shadowing.azure;
  const primary = [
    {
      key: "active",
      label: "Est. active practice",
      value: activeTime.activeSec > 0 ? formatDurationSeconds(activeTime.activeSec) : "—",
      note: activeTime.trackedSince ? `since ${new Date(activeTime.trackedSince).toLocaleDateString()}` : "No practice tracked yet",
    },
    {
      key: "accuracy",
      label: "Sentence accuracy",
      value: acc.practiced > 0 ? `${Math.round((100 * acc.correct) / acc.practiced)}%` : "—",
      note: acc.practiced > 0 ? `${acc.correct}/${acc.practiced} latest answers` : "No Dictation answers yet",
    },
    {
      key: "pronunciation",
      label: "Pronunciation",
      value: formatAggregateScore(azure.pronunciation),
      note: azure.evaluatedSentences > 0 ? plural(azure.evaluatedSentences, "scored sentence", "scored sentences") : "No scored sentences yet",
    },
  ];
  const secondary = [
    summary.inProgressVideos > 0 && plural(summary.inProgressVideos, "video in progress", "videos in progress"),
    summary.listenedThroughVideos > 0 && `${summary.listenedThroughVideos} listened through`,
    summary.completedVideos > 0 && `${summary.completedVideos} completed`,
    summary.legacyCompletedVideos > 0 && `+${summary.legacyCompletedVideos} completed in rounds started before detailed tracking`,
  ].filter((s): s is string => !!s);

  return (
    <section aria-labelledby="progress-heading" data-testid="your-progress" className="rounded-3xl border border-slate-200/70 bg-white/60 p-5 sm:p-6">
      <h2 id="progress-heading" className="mb-4 text-base font-semibold text-slate-900">
        Your progress
      </h2>
      <dl className="grid grid-cols-3 divide-x divide-slate-200">
        {primary.map((m) => (
          <div key={m.key} data-testid={`progress-${m.key}`} className="flex min-w-0 flex-col px-3 first:pl-0 last:pr-0 sm:px-6">
            <dt className="order-2 text-xs font-medium text-slate-600 sm:text-sm">{m.label}</dt>
            <dd className="order-1 text-xl font-semibold tracking-tight text-slate-900 sm:text-3xl">{m.value}</dd>
            <dd className="order-3 mt-0.5 text-[11px] leading-snug text-slate-400 sm:text-xs">{m.note}</dd>
          </div>
        ))}
      </dl>
      {secondary.length > 0 && (
        <p data-testid="progress-videos" className="mt-5 border-t border-slate-200/70 pt-4 text-sm text-slate-600">
          {secondary.join(" · ")}
        </p>
      )}
    </section>
  );
}
