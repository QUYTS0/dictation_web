/**
 * What a round report offers next (Learning Reports plan §5.3–§5.4) — ONE
 * decision for the completion view, the full report and History, so the same
 * round never shows differently-behaving buttons in different places.
 *
 * Same-round actions keep practising INSIDE the selected round: its pinned
 * script, its own coverage, its completion untouched (a completed round never
 * re-completes, and nothing here creates a round). Starting a new round is a
 * separate, explicitly labelled action that always says "new round".
 *
 * Pure: no network, no writes.
 */
import type { RoundReport, ReportSentence } from "@/lib/types/learning";

export type ShadowingContinuationKind =
  /** Some eligible sentences have no practice-valid Shadowing recording yet. */
  | "continue_recording"
  /** Every eligible sentence is recorded, some have no saved Azure score. */
  | "continue_scoring"
  /** Every recorded sentence has a saved Azure score. */
  | "all_scored";

export interface ShadowingContinuation {
  kind: ShadowingContinuationKind;
  /** Sentences still to record / to score (0 for all_scored). */
  remaining: number;
}

/** Why a round can't be continued (its report stays viewable). */
export type ContinuationBlock = "newer_active_round" | "abandoned" | "no_pin" | "unknown_size";

const unscored = (s: ReportSentence) => s.eligible && (s.shadowing?.validTakes ?? 0) > 0 && !s.shadowing?.latestAzure;

/** The round's Shadowing state, from the report alone (the counts are server coverage). */
export function shadowingContinuation(report: RoundReport): ShadowingContinuation | null {
  const required = report.progress.requiredSentenceCount;
  if (!required || required <= 0) return null;
  const recorded = report.progress.coveredSentences.shadowing;
  if (recorded < required) return { kind: "continue_recording", remaining: required - recorded };
  const toScore = report.sentences.filter(unscored).length;
  return toScore > 0 ? { kind: "continue_scoring", remaining: toScore } : { kind: "all_scored", remaining: 0 };
}

export function continuationBlock(report: RoundReport, newerActiveRoundId: string | null | undefined): ContinuationBlock | null {
  if (newerActiveRoundId && newerActiveRoundId !== report.round.roundId) return "newer_active_round";
  if (report.round.status === "abandoned") return "abandoned";
  if (!report.round.transcriptId) return "no_pin";
  if (!report.progress.requiredSentenceCount) return "unknown_size";
  return null;
}

/** The start rule carried in a continuation link; resolved on the practice page (it has the full pinned script). */
export type ContinuationStart = "unrecorded" | "unscored" | "first";

export function continuationStartFor(kind: ShadowingContinuationKind): ContinuationStart {
  return kind === "continue_recording" ? "unrecorded" : kind === "continue_scoring" ? "unscored" : "first";
}

export function continueShadowingHref(videoId: string, roundId: string, start: ContinuationStart): string {
  return `/dictation/${encodeURIComponent(videoId)}?round=${encodeURIComponent(roundId)}&mode=shadowing&start=${start}`;
}

/** A continuation request read from the practice page's URL (ignored when malformed). */
export interface ContinuationRequest {
  roundId: string;
  mode: "shadowing";
  start: ContinuationStart;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseContinuationRequest(search: string): ContinuationRequest | null {
  const q = new URLSearchParams(search);
  const roundId = q.get("round");
  const start = q.get("start");
  if (!roundId || !UUID.test(roundId) || q.get("mode") !== "shadowing") return null;
  if (start !== "unrecorded" && start !== "unscored" && start !== "first") return null;
  return { roundId, mode: "shadowing", start };
}

/** Same rule as the server's eligibility (non-empty normalized text): a blank cue is never a practice target. */
const eligibleText = (text: string) => text.replace(/[^\p{L}\p{N}]+/gu, "").length > 0;

/**
 * Where a continuation starts — RE-DERIVED from server data every time (not
 * a saved playhead): the first eligible sentence of the pinned script that
 * still needs this step. Falls back to the first eligible sentence.
 */
export function resolveContinuationStart(
  start: ContinuationStart,
  segments: { text: string }[],
  sentences: ReportSentence[]
): number {
  const by = new Map(sentences.map((s) => [s.segmentIndex, s]));
  const firstEligible = segments.findIndex((s) => eligibleText(s.text));
  const fallback = Math.max(firstEligible, 0);
  if (start === "first") return fallback;
  for (let i = 0; i < segments.length; i++) {
    if (!eligibleText(segments[i].text)) continue;
    const s = by.get(i);
    const valid = s?.shadowing?.validTakes ?? 0;
    if (start === "unrecorded" && valid === 0) return i;
    if (start === "unscored" && valid > 0 && !s?.shadowing?.latestAzure) return i;
  }
  return fallback;
}

// ------------------------------------------------------------- the table

export type RoundActionKind =
  | "continue_practice"
  | "continue_shadowing"
  | "continue_scoring"
  | "view_shadowing_summary"
  | "practise_shadowing_same_round"
  | "go_to_current_round"
  | "view_report"
  | "practice_again_new_round";

export interface RoundAction {
  kind: RoundActionKind;
  label: string;
  primary: boolean;
  /** For continuation kinds: the start rule (resolved on the practice page). */
  start?: ContinuationStart;
  /** Shown under the button where an action needs explaining. */
  note?: string;
}

export interface RoundActionContext {
  /** An active round of the same video other than this one (from the report route). */
  newerActiveRound?: { roundId: string; roundNumber: number } | null;
}

/**
 * The unified decision table (plan §5.4). Order = display order; at most one
 * primary action.
 */
export function roundActions(report: RoundReport, ctx: RoundActionContext = {}): RoundAction[] {
  const newer = ctx.newerActiveRound ?? null;
  const block = continuationBlock(report, newer?.roundId);
  const newRound: RoundAction = { kind: "practice_again_new_round", label: "Practice again — new round", primary: false };
  if (block === "newer_active_round" && newer) {
    return [
      { kind: "go_to_current_round", label: `Go to current round (Round ${newer.roundNumber})`, primary: true },
      { kind: "view_report", label: "Review report", primary: false },
    ];
  }
  if (report.round.status === "active") {
    return [{ kind: "continue_practice", label: "Continue practice", primary: true }, newRound];
  }
  if (block) return [{ kind: "view_report", label: "Review report", primary: true }, newRound];

  const sh = shadowingContinuation(report);
  if (!sh) return [{ kind: "view_report", label: "Review report", primary: true }, newRound];
  if (sh.kind === "continue_recording") {
    return [
      {
        kind: "continue_shadowing",
        label: `Continue Shadowing in this round (${sh.remaining} ${sh.remaining === 1 ? "sentence" : "sentences"} left)`,
        primary: true,
        start: "unrecorded",
      },
      { kind: "view_report", label: "Review report", primary: false },
      newRound,
    ];
  }
  if (sh.kind === "continue_scoring") {
    return [
      {
        kind: "continue_scoring",
        label: `Continue pronunciation scoring in this round (${sh.remaining} left)`,
        primary: true,
        start: "unscored",
        note: "You'll record these sentences again — recordings aren't kept.",
      },
      { kind: "view_report", label: "Review report", primary: false },
      newRound,
    ];
  }
  return [
    { kind: "view_shadowing_summary", label: "View Shadowing summary", primary: true },
    { kind: "practise_shadowing_same_round", label: "Practise Shadowing in this round", primary: false, start: "first" },
    newRound,
  ];
}
