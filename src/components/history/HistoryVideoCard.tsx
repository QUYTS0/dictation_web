"use client";

import { useState } from "react";
import Link from "next/link";
import { clsx } from "clsx";
import { Calendar, ChevronDown, Clock, FileText, Headphones, PlayCircle } from "lucide-react";
import { RoundReportPanel } from "@/components/report/RoundReportPanel";
import { RoundActions } from "@/components/report/RoundActions";
import { useRoundReportQuery } from "@/lib/queries/roundReport";
import { useHistoryVideoRoundsQuery, useHistoryVideoSessionsQuery } from "@/lib/queries/historySessions";
import type { HistoryRound, HistoryVideo, HistoryVideoSession } from "@/lib/types/learning";
import { formatDurationSeconds } from "@/lib/utils/time";
import { pluralize } from "@/lib/utils/sessionLabels";

const MODE_LABEL: Record<string, string> = { dictation: "Dictation", listening: "Listening", shadowing: "Shadowing" };

type RoundLike = Pick<HistoryRound, "status" | "provenance">;

export function roundStatusLabel(r: RoundLike): string {
  // Provenance says when the round STARTED relative to detailed tracking —
  // never how or when it was completed.
  if (r.status === "completed") return r.provenance === "legacy_unverified" ? "Completed · started before detailed tracking" : "Completed";
  if (r.status === "abandoned") return "Replaced by a newer round";
  return "In progress";
}

function coverageText(progress: HistoryRound["progress"]): string {
  if (!progress?.requiredSentenceCount) return "coverage unavailable";
  return `${progress.coveredSentences.overall}/${progress.requiredSentenceCount} sentences practiced`;
}

/** One sitting — compact: no thumbnail, no report link (the card has those). */
function SessionRow({ s }: { s: HistoryVideoSession }) {
  const practiced = s.dictationSentences + s.shadowingSentences > 0;
  return (
    <li className="flex flex-col gap-1 rounded-xl border border-white/60 bg-white/50 p-3 text-xs text-slate-600" data-testid={`history-session-${s.studySessionId}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1 font-semibold text-slate-700">
          <Calendar size={12} className="text-slate-400" />
          {new Date(s.startedAt).toLocaleString()}
        </span>
        {s.modesUsed.map((m) => (
          <span key={m} className="rounded-full bg-purple-50 px-2 py-0.5 text-[10px] font-semibold text-purple-600">
            {MODE_LABEL[m] ?? m}
          </span>
        ))}
        <span title="Engaged time, estimated from your activity">Est. active {s.activeSec > 0 ? formatDurationSeconds(s.activeSec) : "—"}</span>
        <span className="text-slate-400" title="First to last activity — not practice time">
          · span {formatDurationSeconds(s.elapsedSpanSec)}
        </span>
      </div>
      {practiced && (
        <p data-testid="history-sentences">
          {pluralize(s.uniqueSentences, "sentence")} practiced (Dictation {s.dictationSentences} · Shadowing {s.shadowingSentences}
          {s.overlapSentences > 0 ? ` · ${s.overlapSentences} in both` : ""}) · {s.newlyCoveredInRound} new to the round
          {s.dictationLatest.practiced > 0 && ` · ${s.dictationLatest.correct}/${s.dictationLatest.practiced} correct on the latest answer this session`}
        </p>
      )}
      {s.listeningObservedSec > 0 && (
        <p className="flex items-center gap-1 text-sky-700">
          <Headphones size={12} />
          Listened to {formatDurationSeconds(s.listeningObservedSec)} of video (replays included) ·{" "}
          {formatDurationSeconds(s.listeningNewlyCoveredSec)} newly covered
        </p>
      )}
    </li>
  );
}

/** A collapsed, paged list of sittings — loaded only when opened. */
function SessionsSection({
  userId,
  videoId,
  roundId,
  title,
  count,
}: {
  userId: string;
  videoId: string;
  roundId: string | null;
  title: string;
  count: number;
}) {
  const [open, setOpen] = useState(false);
  const query = useHistoryVideoSessionsQuery(userId, videoId, roundId, open);
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <details
      className="rounded-2xl border border-white/60 bg-white/30 p-3"
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer select-none text-sm font-semibold text-slate-700">
        {title} ({count})
      </summary>
      {open && (
        <div className="mt-2 flex flex-col gap-2">
          {query.isError ? (
            <p className="text-xs text-red-600">
              Failed to load study sessions.{" "}
              <button type="button" onClick={() => query.refetch()} className="font-semibold underline">
                Retry
              </button>
            </p>
          ) : !query.data ? (
            <p className="text-xs text-slate-500">Loading…</p>
          ) : items.length === 0 ? (
            <p className="text-xs text-slate-500">No study sessions recorded.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {items.map((s) => (
                <SessionRow key={s.studySessionId} s={s} />
              ))}
            </ul>
          )}
          {query.hasNextPage && (
            <button
              type="button"
              onClick={() => query.fetchNextPage()}
              disabled={query.isFetchingNextPage}
              className="self-start rounded-lg border border-white/60 bg-white/60 px-3 py-1 text-xs font-semibold text-slate-600 hover:bg-white/80 disabled:opacity-50"
            >
              {query.isFetchingNextPage ? "Loading…" : "More sessions"}
            </button>
          )}
        </div>
      )}
    </details>
  );
}

/** The selected round's whole-round report — the same component and endpoint as everywhere else. */
function SelectedRoundReport({ userId, roundId }: { userId: string; roundId: string }) {
  const report = useRoundReportQuery(userId, roundId);
  if (report.isError) {
    return (
      <p className="text-xs text-red-600">
        Couldn&apos;t load this round&apos;s report.{" "}
        <button type="button" onClick={() => report.refetch()} className="font-semibold underline">
          Retry
        </button>
      </p>
    );
  }
  if (!report.data?.round) return <p className="text-xs text-slate-500">Loading the round report…</p>;
  return (
    <div className="report-light-theme rounded-2xl border border-white/60 bg-white/60 p-4" data-testid={`history-round-report-${roundId}`}>
      <RoundReportPanel
        report={report.data.round}
        dictationEvidence={report.data.dictationEvidence}
        transcriptVersion={report.data.transcriptVersion ?? null}
        listening={report.data.listening ?? null}
        userId={userId}
        shadowingFeedback="collapsed"
        actions={
          <>
            {/* The same next-step table as the completion view (links here: no writes from History). */}
            <RoundActions report={report.data.round} newerActiveRound={report.data.newerActiveRound ?? null} hideViewReport />
            <Link href={`/results/${roundId}`} className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold text-primary-600 hover:bg-white">
              <FileText size={14} /> Review report
            </Link>
          </>
        }
      />
    </div>
  );
}

function VideoDetails({
  userId,
  video,
  picked,
  onPick,
}: {
  userId: string;
  video: HistoryVideo;
  /** The round the learner chose on this card (the card's report link follows it). */
  picked: string | null;
  onPick: (roundId: string) => void;
}) {
  const roundsQuery = useHistoryVideoRoundsQuery(userId, video.videoId, true);
  const data = roundsQuery.data;
  const selectedId = picked ?? data?.defaultRoundId ?? video.round?.roundId ?? null;
  const selected = data?.rounds.find((r) => r.roundId === selectedId) ?? null;

  if (roundsQuery.isError) {
    return (
      <p className="text-xs text-red-600">
        Failed to load this video&apos;s rounds.{" "}
        <button type="button" onClick={() => roundsQuery.refetch()} className="font-semibold underline">
          Retry
        </button>
      </p>
    );
  }
  if (!data) return <p className="text-xs text-slate-500">Loading…</p>;

  return (
    <div className="flex flex-col gap-3 border-t border-white/50 pt-3">
      {data.rounds.length > 1 && (
        <div className="flex flex-col gap-1.5">
          <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Rounds</p>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Choose a round">
            {data.rounds.map((r) => (
              <button
                key={r.roundId}
                type="button"
                aria-pressed={r.roundId === selectedId}
                onClick={() => onPick(r.roundId)}
                className={clsx(
                  "rounded-xl border px-3 py-1.5 text-left text-xs",
                  r.roundId === selectedId ? "border-primary-400 bg-primary-50 text-primary-700" : "border-white/60 bg-white/50 text-slate-600 hover:bg-white/80"
                )}
              >
                <span className="font-semibold">Round {r.roundNumber}</span> · {roundStatusLabel(r)} · {coverageText(r.progress)}
              </button>
            ))}
          </div>
          {data.hasMore && <p className="text-[11px] text-slate-400">Showing the 50 most recent rounds.</p>}
        </div>
      )}

      {selected && (
        <>
          <p className="text-sm font-semibold text-slate-800" data-testid="history-selected-round">
            Round {selected.roundNumber} — {roundStatusLabel(selected)}
          </p>
          <SelectedRoundReport userId={userId} roundId={selected.roundId} />
          {(selected.unattributedAnswers > 0 || selected.unattributedTakes > 0) && (
            <p className="text-xs text-slate-500" data-testid="history-unattributed">
              Not grouped into a study session:{" "}
              {[
                selected.unattributedAnswers > 0 ? pluralize(selected.unattributedAnswers, "answer") : null,
                selected.unattributedTakes > 0 ? pluralize(selected.unattributedTakes, "recording") : null,
              ]
                .filter(Boolean)
                .join(" · ")}{" "}
              (recorded before sessions were tracked, or with no open session). They are included in the report above.
            </p>
          )}
          <SessionsSection
            key={selected.roundId}
            userId={userId}
            videoId={video.videoId}
            roundId={selected.roundId}
            title={`Study sessions in round ${selected.roundNumber}`}
            count={selected.sessionCount}
          />
        </>
      )}
      {data.roundlessSessionCount > 0 && (
        <SessionsSection
          userId={userId}
          videoId={video.videoId}
          roundId={null}
          title="Listening without a practice round"
          count={data.roundlessSessionCount}
        />
      )}
    </div>
  );
}

/**
 * One History entry per video (migration 042): what the user has studied,
 * when, and the current/latest round's own coverage — with that round's
 * report, the other rounds and the individual sittings one click away.
 */
export function HistoryVideoCard({ userId, video }: { userId: string; video: HistoryVideo }) {
  const [expanded, setExpanded] = useState(false);
  // A round chosen under "Rounds and sessions": the card's own "Review report"
  // then opens THAT round (otherwise the default round — active, else latest).
  const [picked, setPicked] = useState<string | null>(null);
  const r = video.round;
  const title = video.title ?? `Video ${video.videoId}`;
  const listeningOnly = !r;
  const continuing = r?.status === "active" || (listeningOnly && !video.listening.listenedThrough);
  const practiceHref = `/dictation/${video.videoId}${listeningOnly ? "?mode=listening" : ""}`;

  return (
    <article
      data-testid={`history-video-${video.videoId}`}
      className="flex flex-col gap-3 rounded-3xl border border-white/60 bg-white/40 p-4 shadow-lg backdrop-blur-xl sm:p-5"
    >
      <div className="flex flex-col gap-4 sm:flex-row">
        <Link
          href={practiceHref}
          className="relative w-full shrink-0 overflow-hidden rounded-2xl bg-slate-800 shadow-md sm:w-44"
          aria-label={`Open ${title}`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`https://img.youtube.com/vi/${video.videoId}/hqdefault.jpg`}
            alt=""
            className="aspect-[16/9] h-full w-full object-cover opacity-80"
            loading="lazy"
          />
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <PlayCircle className="fill-white/20 text-white" size={22} />
          </span>
        </Link>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <h3 className="font-bold leading-tight text-slate-900">{title}</h3>
          <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-semibold">
            {r ? (
              <span
                className={clsx(
                  "rounded-full px-2 py-0.5",
                  r.status === "completed" ? "bg-emerald-50 text-emerald-600" : r.status === "active" ? "bg-amber-50 text-amber-700" : "bg-slate-100 text-slate-500"
                )}
              >
                Round {r.roundNumber}: {roundStatusLabel(r)}
              </span>
            ) : (
              <span className="rounded-full bg-sky-50 px-2 py-0.5 text-sky-700">Listening only — no practice round</span>
            )}
            {!video.inLibrary && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-500">Not in your Library</span>}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-600">
            <span className="flex items-center gap-1">
              <Calendar size={13} className="text-slate-400" /> Last practiced {new Date(video.lastActivityAt).toLocaleDateString()}
            </span>
            <span>
              {pluralize(video.sessionCount, "study session")} · {pluralize(video.roundCount, "round")}
            </span>
            <span className="flex items-center gap-1" title="Engaged time across all of this video's sessions, overlaps counted once — an estimate">
              <Clock size={13} className="text-slate-400" /> Est. active {video.activeSec > 0 ? formatDurationSeconds(video.activeSec) : "—"} (all sessions)
            </span>
          </div>
          {r && (
            <p className="text-xs text-slate-700" data-testid="history-round-coverage">
              Round {r.roundNumber} coverage: {coverageText(r.progress)}
            </p>
          )}
          {video.listening.hasHistory && (
            <p className="flex items-center gap-1 text-xs text-sky-700">
              <Headphones size={12} />
              {video.listening.coverageRatio !== null
                ? `Listening (current script): ${Math.round(video.listening.coverageRatio * 100)}%${video.listening.listenedThrough ? " — listened through" : ""}`
                : "Listening history on an earlier script version"}
            </p>
          )}
          <div className="mt-1 flex flex-wrap gap-2">
            {r && (
              <Link
                href={`/results/${picked ?? r.roundId}`}
                className="inline-flex items-center gap-1 rounded-xl border border-white/60 bg-white/60 px-3 py-1.5 text-xs font-semibold text-primary-600 hover:bg-white/80"
              >
                <FileText size={13} /> Review report
              </Link>
            )}
            <Link
              href={practiceHref}
              className="inline-flex items-center gap-1 rounded-xl bg-primary-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-primary-700"
            >
              <PlayCircle size={13} /> {continuing ? "Continue" : "Open"}
            </Link>
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpanded((x) => !x)}
              className="inline-flex items-center gap-1 rounded-xl border border-white/60 bg-white/50 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-white/80"
            >
              <ChevronDown size={13} className={clsx("transition-transform", expanded && "rotate-180")} />
              {expanded ? "Hide details" : "Rounds and sessions"}
            </button>
          </div>
        </div>
      </div>
      {expanded && <VideoDetails userId={userId} video={video} picked={picked} onPick={setPicked} />}
    </article>
  );
}
