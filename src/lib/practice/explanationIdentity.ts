/**
 * Learning Reports P4 — saved explanation identity, ordering and reuse.
 * SERVER-ONLY (node:crypto). Mirrors migration 043:
 *   - explanationPatternKey  ⇔ fn_explanation_pattern_key (version "p1")
 *   - compareEffective       ⇔ "seq desc nulls last, created_at desc, id desc"
 *   - coveredAttemptIds      ⇔ the 'missing' filter in fn_explanations_begin
 *
 * Two DIFFERENT identities exist on purpose:
 *   - legacy grouping (explain-all's `buildPatterns`, relaxed-normalized):
 *     only for the overview prompt's pattern list, unchanged until P5;
 *   - the reuse identity here: mode-aware, conservative. Two attempts share
 *     a note only when the SAME matching rule makes them the same mistake.
 *     An unknown (legacy null) mode has no key — such an attempt only shows
 *     the note attached to itself.
 */
import { createHash } from "crypto";
import { normalizeText } from "@/lib/utils/text";
import type { MatchMode } from "@/lib/types";

export const EXPLANATION_KEY_VERSION = "p1";
const KNOWN_MODES = new Set(["exact", "relaxed", "learning"]);

export function explanationPatternKey(
  expected: string | null | undefined,
  user: string | null | undefined,
  mode: string | null | undefined
): string | null {
  if (!mode || !KNOWN_MODES.has(mode) || expected == null || user == null) return null;
  const e = normalizeText(expected, mode as MatchMode);
  const u = normalizeText(user, mode as MatchMode);
  return createHash("sha256")
    .update(`${EXPLANATION_KEY_VERSION}|${mode}|${Buffer.byteLength(e, "utf8")}|${e}|${u}`, "utf8")
    .digest("hex");
}

/** A row of attempt_explanations as read by the app. */
export interface StoredExplanation {
  id: string;
  attempt_id: string;
  source: "legacy_ai_feedback" | "batch" | "single";
  seq: number | string | null;
  explanation: string;
  corrected_text: string | null;
  example_text: string | null;
  tip: string | null;
  prompt_version: number | null;
  model: string | null;
  created_at: string;
  /** P5 (044): "minor" and "duplicate" notes; absent/"explanation" for P4 rows. */
  note_kind?: "explanation" | "minor" | "duplicate" | null;
  /** For a "duplicate": the attempt whose explanation (same operation) it points at. */
  ref_attempt_id?: string | null;
}

/** The attempt fields the reuse identity needs (immutable attempt row). */
export interface ExplanationAttempt {
  id: string;
  segment_index: number;
  expected_text: string;
  user_text: string;
  match_mode: string | null;
  is_correct: boolean;
  created_at: string;
}

/** Negative when `a` is MORE effective than `b`. Ordered by seq (allocated at begin), never by insert time. */
export function compareEffective(a: StoredExplanation, b: StoredExplanation): number {
  const sa = a.seq === null ? null : Number(a.seq);
  const sb = b.seq === null ? null : Number(b.seq);
  if (sa !== sb) {
    if (sa === null) return 1;
    if (sb === null) return -1;
    return sb - sa;
  }
  const ta = Date.parse(a.created_at);
  const tb = Date.parse(b.created_at);
  if (ta !== tb) return tb - ta;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** Each attempt's effective (winning) note. */
export function effectiveByAttempt(rows: StoredExplanation[]): Map<string, StoredExplanation> {
  const out = new Map<string, StoredExplanation>();
  for (const row of rows) {
    const current = out.get(row.attempt_id);
    if (!current || compareEffective(row, current) < 0) out.set(row.attempt_id, row);
  }
  return out;
}

interface PatternHolder {
  attempt: ExplanationAttempt;
  note: StoredExplanation;
}

/** Per pattern key (same round): the most effective note among attempts carrying that key. */
function notesByPattern(
  attempts: ExplanationAttempt[],
  effective: Map<string, StoredExplanation>
): Map<string, PatternHolder> {
  const out = new Map<string, PatternHolder>();
  for (const attempt of attempts) {
    const note = effective.get(attempt.id);
    if (!note) continue;
    const key = explanationPatternKey(attempt.expected_text, attempt.user_text, attempt.match_mode);
    if (!key) continue;
    const current = out.get(key);
    if (!current || compareEffective(note, current.note) < 0) out.set(key, { attempt, note });
  }
  return out;
}

/**
 * Attempt ids that already have a saved note — their own, or a same-round
 * attempt's with the same pattern key. `attempts` and `rows` MUST be one
 * round's. Used by the routes as a pre-filter; the database repeats this
 * decision under the per-round lock in fn_explanations_begin.
 */
export function coveredAttemptIds(
  targets: ExplanationAttempt[],
  roundAttempts: ExplanationAttempt[],
  rows: StoredExplanation[]
): Set<string> {
  const effective = effectiveByAttempt(rows);
  const byPattern = notesByPattern(roundAttempts, effective);
  const covered = new Set<string>();
  for (const t of targets) {
    if (effective.has(t.id)) {
      covered.add(t.id);
      continue;
    }
    const key = explanationPatternKey(t.expected_text, t.user_text, t.match_mode);
    if (key && byPattern.has(key)) covered.add(t.id);
  }
  return covered;
}

export type ExplanationVia = "attempt" | "pattern" | "earlier_answer";

export interface ResolvedExplanation {
  explanation: string;
  correctedText: string;
  example: string;
  tip?: string;
  /** "attempt": this answer's own note; "pattern": the same mistake in another sentence of this round; "earlier_answer": an earlier wrong answer to this sentence. */
  via: ExplanationVia;
  /** 0-based segment of the attempt that carries the note (for "pattern"). */
  viaSegmentIndex?: number;
  /** The explained answer is not the sentence's latest answer (corrected or answered again since). */
  historical: boolean;
  /** Copied from the pre-P4 ai_feedback table: generation rules/version unknown. */
  legacy: boolean;
  promptVersion: number | null;
  model: string | null;
  /** P5: how the model classified it. "minor"/"duplicate" carry a short note in `explanation`. */
  kind: "explanation" | "minor" | "duplicate";
  /** For "duplicate": the 0-based sentence whose explanation it refers to (when known). */
  refSegmentIndex?: number;
}

/**
 * Resolves the note shown for one sentence's displayed wrong attempt:
 *   1. its own effective note;
 *   2. else a same-round attempt with the same pattern key ("Same mistake as sentence N");
 *   3. else the newest note of an earlier wrong answer to the same sentence (historical).
 * `roundAttempts` must be ALL attempts of this one round (incl. correct ones, to know the latest answer).
 */
export function resolveExplanation(
  attempt: ExplanationAttempt,
  roundAttempts: ExplanationAttempt[],
  rows: StoredExplanation[],
  ctx?: { effective?: Map<string, StoredExplanation>; byPattern?: Map<string, PatternHolder> }
): ResolvedExplanation | null {
  const effective = ctx?.effective ?? effectiveByAttempt(rows);
  const latestOfSegment = latestAttemptOfSegment(roundAttempts, attempt.segment_index);
  const historical = latestOfSegment !== null && latestOfSegment.id !== attempt.id;

  const own = effective.get(attempt.id);
  if (own) return toResolved(own, attempt.expected_text, "attempt", historical);

  const key = explanationPatternKey(attempt.expected_text, attempt.user_text, attempt.match_mode);
  if (key) {
    const byPattern = ctx?.byPattern ?? notesByPattern(roundAttempts, effective);
    const holder = byPattern.get(key);
    if (holder && holder.attempt.id !== attempt.id) {
      const sameSentence = holder.attempt.segment_index === attempt.segment_index;
      return {
        ...toResolved(holder.note, attempt.expected_text, sameSentence ? "earlier_answer" : "pattern", historical),
        ...(sameSentence ? {} : { viaSegmentIndex: holder.attempt.segment_index }),
      };
    }
  }

  let earlier: StoredExplanation | null = null;
  for (const other of roundAttempts) {
    if (other.id === attempt.id || other.segment_index !== attempt.segment_index || other.is_correct) continue;
    if (!isBefore(other, attempt)) continue; // only answers given BEFORE the shown one

    const note = effective.get(other.id);
    if (note && (!earlier || compareEffective(note, earlier) < 0)) earlier = note;
  }
  if (earlier) return toResolved(earlier, attempt.expected_text, "earlier_answer", true);
  return null;
}

/** Resolves many attempts of one round at once (shared indexes). */
export function resolveExplanations(
  attempts: ExplanationAttempt[],
  roundAttempts: ExplanationAttempt[],
  rows: StoredExplanation[]
): Map<string, ResolvedExplanation> {
  const effective = effectiveByAttempt(rows);
  const byPattern = notesByPattern(roundAttempts, effective);
  const out = new Map<string, ResolvedExplanation>();
  const segmentOf = new Map(roundAttempts.map((a) => [a.id, a.segment_index]));
  const refOf = new Map(rows.map((r) => [r.id, r.ref_attempt_id ?? null]));
  for (const attempt of attempts) {
    const r = resolveExplanation(attempt, roundAttempts, rows, { effective, byPattern });
    if (!r) continue;
    if (r.kind === "duplicate") {
      const note = effective.get(attempt.id) ?? null;
      const ref = note ? refOf.get(note.id) : null;
      const seg = ref ? segmentOf.get(ref) : undefined;
      if (seg !== undefined) r.refSegmentIndex = seg;
    }
    out.set(attempt.id, r);
  }
  return out;
}

function isBefore(a: ExplanationAttempt, b: ExplanationAttempt): boolean {
  const ta = Date.parse(a.created_at);
  const tb = Date.parse(b.created_at);
  return ta < tb || (ta === tb && a.id < b.id);
}

function latestAttemptOfSegment(attempts: ExplanationAttempt[], segmentIndex: number): ExplanationAttempt | null {
  let latest: ExplanationAttempt | null = null;
  for (const a of attempts) {
    if (a.segment_index !== segmentIndex) continue;
    if (!latest || Date.parse(a.created_at) > Date.parse(latest.created_at) || (a.created_at === latest.created_at && a.id > latest.id)) {
      latest = a;
    }
  }
  return latest;
}

function toResolved(note: StoredExplanation, expectedText: string, via: ExplanationVia, historical: boolean): ResolvedExplanation {
  return {
    explanation: note.explanation,
    correctedText: note.corrected_text ?? expectedText,
    example: note.example_text ?? "",
    ...(note.tip ? { tip: note.tip } : {}),
    via,
    historical,
    legacy: note.source === "legacy_ai_feedback",
    promptVersion: note.prompt_version,
    model: note.model,
    kind: note.note_kind === "minor" || note.note_kind === "duplicate" ? note.note_kind : "explanation",
  };
}
