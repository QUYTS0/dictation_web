/**
 * Learning Reports P5 — validation of Gemini output (hand-written, no zod).
 *
 * - Structure, field types and lengths are checked; anything else is dropped.
 * - Only ids that belong to THIS request count: unknown target ids never
 *   become notes, a repeated target id keeps the first occurrence only (it
 *   can't inflate coverage), empty explanations don't count as explained.
 * - A strength must cite correct_evidence or corrected items; a priority must
 *   cite known evidence. Unsupported items are dropped and counted.
 * - A "duplicate" note survives only when it points at another target of this
 *   request whose note is a valid explanation (both are then saved together).
 * - No usable overview text → the overview is unusable (it must not replace
 *   a saved assessment).
 */
import type { EvidenceItem, ExplanationTarget } from "@/lib/ai/assessmentInput";

export interface OverviewPayload {
  overview: string;
  strengths: { text: string; evidenceIds: string[] }[];
  priorities: { title: string; explanation: string; evidenceIds: string[]; practice: string }[];
  practicePlan: string[];
  limitations: string[];
}

export interface ValidNote {
  attemptId: string;
  kind: "explanation" | "minor" | "duplicate";
  explanation: string;
  correctedText: string | null;
  example: string | null;
  tip: string | null;
  refAttemptId: string | null;
}

export interface NotesCoverage {
  requested: number;
  returned: number;
  valid: number;
  unknownIds: number;
  repeatedIds: number;
  empty: number;
  invalidDuplicates: number;
  /** Requested targets with no valid note. */
  missing: number;
}

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, max) : null);
const strList = (v: unknown, maxItems: number, maxLen: number): string[] =>
  Array.isArray(v) ? v.map((x) => str(x, maxLen)).filter((x): x is string => x !== null).slice(0, maxItems) : [];

export function validateOverview(
  raw: unknown,
  evidence: EvidenceItem[]
): { payload: OverviewPayload | null; droppedStrengths: number; droppedPriorities: number } {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const overview = str(o.overview, 1200);
  const kinds = new Map(evidence.map((e) => [e.id, e.kind]));
  const cite = (v: unknown, allowed: (k: string) => boolean) =>
    [...new Set(strList(v, 20, 12))].filter((id) => kinds.has(id) && allowed(kinds.get(id)!));

  let droppedStrengths = 0;
  const strengths: OverviewPayload["strengths"] = [];
  for (const s of Array.isArray(o.strengths) ? o.strengths.slice(0, 10) : []) {
    const text = str((s as Record<string, unknown>)?.text, 300);
    const ids = cite((s as Record<string, unknown>)?.evidenceIds, (k) => k === "correct_evidence" || k === "corrected");
    if (text && ids.length > 0 && strengths.length < 6) strengths.push({ text, evidenceIds: ids });
    else droppedStrengths++;
  }
  let droppedPriorities = 0;
  const priorities: OverviewPayload["priorities"] = [];
  for (const p of Array.isArray(o.priorities) ? o.priorities.slice(0, 10) : []) {
    const r = (p ?? {}) as Record<string, unknown>;
    const title = str(r.title, 120);
    const explanation = str(r.explanation, 600);
    const practice = str(r.practice, 300);
    const ids = cite(r.evidenceIds, (k) => k !== "unavailable");
    if (title && explanation && practice && ids.length > 0 && priorities.length < 3) priorities.push({ title, explanation, evidenceIds: ids, practice });
    else droppedPriorities++;
  }
  if (!overview) return { payload: null, droppedStrengths, droppedPriorities };
  return {
    payload: {
      overview,
      strengths,
      priorities,
      practicePlan: strList(o.practicePlan, 3, 300),
      limitations: strList(o.limitations, 5, 300),
    },
    droppedStrengths,
    droppedPriorities,
  };
}

export function validateNotes(raw: unknown, ids: Map<string, ExplanationTarget>): { notes: ValidNote[]; coverage: NotesCoverage } {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  const first: { id: string; r: Record<string, unknown> }[] = [];
  const coverage: NotesCoverage = { requested: ids.size, returned: list.length, valid: 0, unknownIds: 0, repeatedIds: 0, empty: 0, invalidDuplicates: 0, missing: 0 };
  for (const item of list) {
    const r = (item ?? {}) as Record<string, unknown>;
    const id = typeof r.targetId === "string" ? r.targetId.trim() : "";
    if (!ids.has(id)) {
      coverage.unknownIds++;
      continue;
    }
    if (seen.has(id)) {
      coverage.repeatedIds++;
      continue;
    }
    seen.add(id);
    first.push({ id, r });
  }

  const explained = new Map<string, ValidNote>();
  const pending: { id: string; r: Record<string, unknown> }[] = [];
  for (const { id, r } of first) {
    const kind = r.kind === "minor" || r.kind === "duplicate" ? r.kind : "explanation";
    const target = ids.get(id)!;
    if (kind === "explanation") {
      const explanation = str(r.explanation, 4000);
      if (!explanation) {
        coverage.empty++;
        continue;
      }
      explained.set(id, {
        attemptId: target.attemptId,
        kind,
        explanation,
        correctedText: str(r.correctedText, 2000) ?? target.reference,
        example: str(r.example, 2000),
        tip: null,
        refAttemptId: null,
      });
    } else pending.push({ id, r });
  }
  const notes: ValidNote[] = [...explained.values()];
  for (const { id, r } of pending) {
    const target = ids.get(id)!;
    const text = str(r.explanation, 500);
    if (!text) {
      coverage.empty++;
      continue;
    }
    if (r.kind === "minor") {
      notes.push({ attemptId: target.attemptId, kind: "minor", explanation: text, correctedText: null, example: null, tip: null, refAttemptId: null });
      continue;
    }
    const ref = typeof r.duplicateOf === "string" ? explained.get(r.duplicateOf.trim()) : undefined;
    if (!ref || r.duplicateOf === id) {
      coverage.invalidDuplicates++;
      continue;
    }
    notes.push({ attemptId: target.attemptId, kind: "duplicate", explanation: text, correctedText: null, example: null, tip: null, refAttemptId: ref.attemptId });
  }
  coverage.valid = notes.length;
  coverage.missing = ids.size - notes.length;
  return { notes, coverage };
}

/** The finish-RPC item for one note (ordinary explanations keep P4's exact shape). */
export function noteItem(n: ValidNote): Record<string, unknown> {
  const base = { attemptId: n.attemptId, explanation: n.explanation, correctedText: n.correctedText, example: n.example, tip: n.tip };
  return n.kind === "explanation" ? base : { ...base, kind: n.kind, refAttemptId: n.refAttemptId };
}
