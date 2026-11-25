import type { LucideIcon } from "lucide-react";
import { BarChart3, Clock, Mic2, Target } from "lucide-react";
import { formatAggregateScore } from "@/lib/practice/scoreFormat";
import { formatDurationSeconds } from "@/lib/utils/time";
import type { DashboardSummary } from "@/lib/types/learning";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const clampPct = (pct: number) => Math.min(100, Math.max(0, pct));

interface Metric {
  key: "active" | "accuracy" | "pronunciation";
  icon: LucideIcon;
  iconClass: string;
  label: string;
  value: string;
  suffix?: string;
  note: string;
  /** 0–100 bar, or null for none. */
  bar: { pct: number; className: string } | null;
}

/**
 * "Learning performance" — the three canonical outcome metrics, each its own
 * card and its own number (§6.8: never recomputed or blended here), plus the
 * non-zero video counts as one line. Descriptive only: no rankings, trends
 * or praise labels. Phase 4 adds the 7-day minute bars to the first card.
 */
export function LearningPerformance({ summary }: { summary: DashboardSummary }) {
  const { activeTime, sentenceAccuracy: acc, shadowing } = summary;
  const azure = shadowing.azure;
  const accuracyPct = acc.practiced > 0 ? Math.round((100 * acc.correct) / acc.practiced) : null;

  const metrics: Metric[] = [
    {
      key: "active",
      icon: Clock,
      iconClass: "text-primary-600",
      label: "Est. active practice",
      value: activeTime.activeSec > 0 ? formatDurationSeconds(activeTime.activeSec) : "—",
      note:
        activeTime.sessionCount > 0 ? `Across ${plural(activeTime.sessionCount, "study session", "study sessions")}` : "No practice tracked yet",
      bar: null,
    },
    {
      key: "accuracy",
      icon: Target,
      iconClass: "text-success",
      label: "Sentence accuracy",
      value: accuracyPct !== null ? `${accuracyPct}%` : "—",
      note: acc.practiced > 0 ? `${acc.correct}/${acc.practiced} latest answers` : "No Dictation answers yet",
      bar: accuracyPct !== null ? { pct: accuracyPct, className: "bg-success" } : null,
    },
    {
      key: "pronunciation",
      icon: Mic2,
      iconClass: "text-primary-600",
      label: "Pronunciation",
      value: formatAggregateScore(azure.pronunciation),
      suffix: azure.pronunciation !== null ? "/ 100" : undefined,
      note: azure.evaluatedSentences > 0 ? plural(azure.evaluatedSentences, "scored sentence", "scored sentences") : "No scored sentences yet",
      bar: azure.pronunciation !== null ? { pct: azure.pronunciation, className: "bg-primary-600" } : null,
    },
  ];

  const videos = [
    summary.inProgressVideos > 0 && plural(summary.inProgressVideos, "video in progress", "videos in progress"),
    summary.listenedThroughVideos > 0 && `${summary.listenedThroughVideos} listened through`,
    summary.completedVideos > 0 && `${summary.completedVideos} completed`,
    summary.legacyCompletedVideos > 0 && `+${summary.legacyCompletedVideos} completed in rounds started before detailed tracking`,
  ].filter((s): s is string => !!s);

  return (
    <section aria-labelledby="progress-heading" data-testid="your-progress" className="space-y-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="progress-heading" className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-ink">
          <BarChart3 size={16} className="text-primary-600" aria-hidden="true" />
          Learning performance
        </h2>
        {activeTime.trackedSince && (
          <p className="text-xs font-medium text-muted">
            Tracked since {new Date(activeTime.trackedSince).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
          </p>
        )}
      </div>

      <dl className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {metrics.map((m) => {
          const Icon = m.icon;
          return (
            <div key={m.key} data-testid={`progress-${m.key}`} className="flex flex-col gap-3 rounded-2xl border border-line bg-white p-5 shadow-xs">
              <dt className="flex items-center gap-1.5 text-xs font-semibold text-ink">
                <Icon size={14} className={m.iconClass} aria-hidden="true" />
                {m.label}
              </dt>
              <dd className="flex items-baseline gap-2">
                <span className="font-mono text-3xl font-bold tracking-tight tabular-nums text-ink">{m.value}</span>
                {m.suffix && <span className="font-mono text-xs text-muted">{m.suffix}</span>}
              </dd>
              <dd className="text-xs leading-relaxed text-muted">{m.note}</dd>
              {m.key === "active" && videos.length > 0 && (
                <dd data-testid="progress-videos" className="border-t border-line pt-3 text-xs leading-relaxed text-muted">
                  {videos.join(" · ")}
                </dd>
              )}
              {m.bar && (
                <dd className="mt-auto h-1.5 w-full overflow-hidden rounded-full bg-line" aria-hidden="true">
                  <div className={`h-full rounded-full ${m.bar.className}`} style={{ width: `${clampPct(m.bar.pct)}%` }} />
                </dd>
              )}
            </div>
          );
        })}
      </dl>
    </section>
  );
}
