/**
 * Learning Reports P5 — pure units: the server-built input (metrics, evidence,
 * budgets, targets, fingerprint), batching (80 targets → 35 / 35 / 10, never a
 * loop), output validation, recovery sealing, and a static guard that every
 * Gemini call goes through the admitted gateway. No network, no provider.
 */
import fs from "fs";
import path from "path";
import { buildAssessmentInput, explanationBatchSize, selectBatch, type AssessmentAttemptRow } from "@/lib/ai/assessmentInput";
import { validateNotes, validateOverview } from "@/lib/ai/assessmentValidate";
import { targetIds } from "@/lib/ai/assessmentPrompt";
import { canonicalJson, contentHash, openAiRecovery, sealAiRecovery } from "@/lib/ai/aiRecovery";
import type { RoundReport, ReportSentence } from "@/lib/types/learning";
import type { StoredExplanation } from "@/lib/practice/explanationIdentity";

let n = 0;
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const at = (s: number) => `2026-10-01T00:${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}Z`;

function attempt(seg: number, expected: string, user: string, isCorrect: boolean, mode: string | null = "relaxed", t = ++n, valid = true): AssessmentAttemptRow {
  return { id: id(), segment_index: seg, expected_text: expected, user_text: user, is_correct: isCorrect, is_practice_valid: valid, match_mode: mode, created_at: at(t) };
}
function sentence(seg: number, text: string, category: ReportSentence["category"]): ReportSentence {
  return { segmentIndex: seg, text, eligible: true, category, dictation: { submissions: 1, practiceSubmissions: 1, first: null, latest: null, everIncorrect: category === "needs_review" || category === "corrected" }, shadowing: null };
}
function report(sentences: ReportSentence[], over: Partial<RoundReport["dictation"]> = {}, historyComplete = true): RoundReport {
  return {
    round: { transcriptId: "tr-1" },
    historyComplete,
    progress: { requiredSentenceCount: sentences.length },
    dictation: {
      practicedSentences: sentences.length,
      latestCorrect: sentences.filter((s) => s.category !== "needs_review").length,
      needsReview: 0,
      corrected: 0,
      submissions: 0,
      invalidSubmissions: 0,
      bestStreak: 4,
      firstTry: { available: true, correct: 2, correctWithHint: 0, correctHintUnknown: 0 },
      accuracy: {},
      ...over,
    },
    sentences,
  } as unknown as RoundReport;
}

describe("buildAssessmentInput — metrics and evidence", () => {
  it("uses the report's canonical metrics (never learning_sessions.accuracy) and labels evidence kinds", () => {
    const rows = [
      attempt(0, "Alpha beta.", "alpha bet", false),
      attempt(1, "Gamma delta.", "gama delta", false),
      attempt(1, "Gamma delta.", "gamma delta", true),
      attempt(2, "Epsilon zeta.", "epsilon zeta", true),
      attempt(3, "Eta theta.", "", false, "relaxed", ++n, false), // invalid (empty) answer
    ];
    const input = buildAssessmentInput({
      report: report([sentence(0, "Alpha beta.", "needs_review"), sentence(1, "Gamma delta.", "corrected"), sentence(2, "Epsilon zeta.", "first_try")]),
      attempts: rows,
      notes: [],
    });
    expect(input.metrics).toMatchObject({
      eligibleSentences: 3,
      latestAnswerCorrect: { correct: 2, practiced: 3 },
      validSubmissionCorrectness: { correct: 2, valid: 4 },
      currentlyIncorrect: 1,
      corrected: 1,
      distinctEverIncorrect: 2,
      invalidSubmissions: 1,
      historyComplete: true,
      firstTry: { correct: 2, practiced: 3 },
      bestStreak: 4,
    });
    expect(JSON.stringify(input)).not.toMatch(/"accuracy"/);
    expect(input.evidence.map((e) => [e.id, e.kind])).toEqual([
      ["S1", "currently_incorrect"],
      ["S2", "corrected"],
      ["S3", "correct_evidence"],
    ]);
    expect(input.evidence[0].differences.length).toBeGreaterThan(0);
  });

  it("missing or unsupported metrics are null, legacy answers are 'unknown', and evidence without valid answers is 'unavailable'", () => {
    const legacy = attempt(0, "Alpha beta.", "alpa beta", false, null);
    const input = buildAssessmentInput({
      report: report([sentence(0, "Alpha beta.", "needs_review"), sentence(1, "Gamma delta.", "needs_review")], { firstTry: { available: false, correct: null, correctWithHint: null, correctHintUnknown: null } }, false),
      attempts: [legacy],
      notes: [],
    });
    expect(input.metrics.firstTry).toBeNull();
    expect(input.metrics.bestStreak).toBeNull();
    expect(input.metrics.historyComplete).toBe(false);
    expect(input.evidence.find((e) => e.id === "S1")).toMatchObject({ kind: "currently_incorrect", matchRule: "unknown", differences: [] });
    expect(input.evidence.find((e) => e.id === "S2")).toMatchObject({ kind: "unavailable", reference: null, answer: null });
  });

  it("over the input budget: the rest becomes aggregate-only counts, statistics stay complete", () => {
    const sentences = Array.from({ length: 40 }, (_, i) => sentence(i, `Sentence number ${i} is here.`, "needs_review"));
    const rows = sentences.map((s) => attempt(s.segmentIndex, s.text!, `sentence numbr ${s.segmentIndex}`, false));
    const input = buildAssessmentInput({ report: report(sentences), attempts: rows, notes: [], charBudget: 2500 });
    expect(input.individual.length).toBeGreaterThan(0);
    expect(input.individual.length + input.aggregates.sentences).toBe(input.evidence.length);
    expect(input.aggregates.sentences).toBeGreaterThan(0);
    expect(input.aggregates.byKind.currently_incorrect).toBe(input.aggregates.sentences);
    expect(input.metrics.currentlyIncorrect).toBe(40); // never reduced
  });

  it("the fingerprint changes with valid learning data, not with an invalid (empty) answer", () => {
    const base = [attempt(0, "Alpha beta.", "alpha bet", false)];
    const r = report([sentence(0, "Alpha beta.", "needs_review")]);
    const fp = buildAssessmentInput({ report: r, attempts: base, notes: [] }).fingerprint;
    expect(buildAssessmentInput({ report: r, attempts: [...base, attempt(0, "Alpha beta.", "", false, "relaxed", ++n, false)], notes: [] }).fingerprint).toBe(fp);
    expect(buildAssessmentInput({ report: r, attempts: [...base, attempt(0, "Alpha beta.", "alfa beta", false)], notes: [] }).fingerprint).not.toBe(fp);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("buildAssessmentInput — targets (P4 mode-aware identity) and batching", () => {
  it("groups the same mistake across sentences; keeps exact case/punctuation apart; unknown mode is its own target; spacing slips excluded", () => {
    const rows = [
      attempt(0, "Alpha beta.", "alpha bet", false),
      attempt(1, "Alpha beta.", "Alpha bet!", false), // same relaxed mistake
      attempt(2, "Epsilon zeta.", "epsilon zeta.", false, "exact"), // case only
      attempt(3, "Epsilon zeta.", "Epsilon zeta", false, "exact"), // punctuation only
      attempt(4, "Alpha beta.", "alpha bet", false, null), // unknown rule
      attempt(5, "Eta theta.", "etatheta", false), // spacing only
    ];
    const sentences = [0, 1, 2, 3, 4, 5].map((i) => sentence(i, rows[i].expected_text, "needs_review"));
    const input = buildAssessmentInput({ report: report(sentences), attempts: rows, notes: [] });
    expect(input.targets.map((t) => t.segmentIndexes)).toEqual([[0, 1], [2], [3], [4]]);
  });

  it("saved notes (own or same mistake) are covered; only missing targets are offered", () => {
    const rows = [attempt(0, "Alpha beta.", "alpha bet", false), attempt(1, "Alpha beta.", "alpha bet", false), attempt(2, "Gamma delta.", "gama", false)];
    const note: StoredExplanation = {
      id: "n1", attempt_id: rows[0].id, source: "batch", seq: 1, explanation: "x", corrected_text: null, example_text: null, tip: null, prompt_version: 2, model: "m", created_at: at(99),
    };
    const input = buildAssessmentInput({ report: report(rows.map((r) => sentence(r.segment_index, r.expected_text, "needs_review"))), attempts: rows, notes: [note] });
    expect(input.targets.map((t) => t.covered)).toEqual([true, false]);
    expect(input.missingTargets.map((t) => t.segmentIndexes)).toEqual([[2]]);
  });

  it("80 distinct targets → batches of at most 35 (35 / 35 / 10), one batch per request, smaller when the output budget is tighter", () => {
    expect(explanationBatchSize(8192, 1500, 180)).toBe(35);
    expect(explanationBatchSize(8192, 1500, 400)).toBe(16);
    expect(explanationBatchSize(1000, 1500, 180)).toBe(1);
    const sentences = Array.from({ length: 80 }, (_, i) => sentence(i, `Line ${i} words.`, "needs_review"));
    const rows = sentences.map((s) => attempt(s.segmentIndex, s.text!, `lin ${s.segmentIndex} word`, false));
    const notes: StoredExplanation[] = [];
    const sizes: number[] = [];
    for (let request = 0; request < 4; request++) {
      const input = buildAssessmentInput({ report: report(sentences), attempts: rows, notes });
      const batch = selectBatch(input, explanationBatchSize(8192, 1500, 180), { onlyMissing: true });
      sizes.push(batch.length);
      batch.forEach((t, i) =>
        notes.push({ id: `n${request}-${i}`, attempt_id: t.attemptId, source: "batch", seq: request + 1, explanation: "x", corrected_text: null, example_text: null, tip: null, prompt_version: 2, model: "m", created_at: at(500 + request) })
      );
    }
    expect(sizes).toEqual([35, 35, 10, 0]);
  });

  it("selected sentences pick their targets; re-explanation may include covered targets only when asked", () => {
    const rows = [attempt(0, "Alpha beta.", "alpha bet", false), attempt(1, "Gamma delta.", "gama", false)];
    const note: StoredExplanation = { id: "n1", attempt_id: rows[0].id, source: "batch", seq: 1, explanation: "x", corrected_text: null, example_text: null, tip: null, prompt_version: 2, model: "m", created_at: at(99) };
    const input = buildAssessmentInput({ report: report(rows.map((r) => sentence(r.segment_index, r.expected_text, "needs_review"))), attempts: rows, notes: [note] });
    expect(selectBatch(input, 35, { sentences: [0], onlyMissing: true })).toEqual([]);
    expect(selectBatch(input, 35, { sentences: [0], onlyMissing: false }).map((t) => t.attemptId)).toEqual([rows[0].id]);
  });
});

describe("validation of Gemini output", () => {
  const evidence = [
    { id: "S1", kind: "currently_incorrect" },
    { id: "S2", kind: "corrected" },
    { id: "S3", kind: "correct_evidence" },
  ] as never;

  it("drops unsupported strengths and priorities; no overview text → unusable", () => {
    const ok = validateOverview(
      {
        overview: "Good.",
        strengths: [
          { text: "Clear on short lines.", evidenceIds: ["S3"] },
          { text: "Unsupported.", evidenceIds: [] },
          { text: "Cites a mistake as a strength.", evidenceIds: ["S1"] },
          { text: "Cites nothing real.", evidenceIds: ["S99"] },
        ],
        priorities: [
          { title: "Endings", explanation: "Plural s.", evidenceIds: ["S1"], practice: "Listen." },
          { title: "No evidence", explanation: "x", evidenceIds: ["S77"], practice: "y" },
        ],
        practicePlan: ["a", "b", "c", "d"],
        limitations: [7, "Some sentences were only counted."],
      },
      evidence
    );
    expect(ok.payload?.strengths.map((s) => s.text)).toEqual(["Clear on short lines."]);
    expect(ok.payload?.priorities.map((p) => p.title)).toEqual(["Endings"]);
    expect(ok.payload?.practicePlan).toHaveLength(3);
    expect(ok.payload?.limitations).toEqual(["Some sentences were only counted."]);
    expect(ok).toMatchObject({ droppedStrengths: 3, droppedPriorities: 1 });
    expect(validateOverview({ overview: "   ", strengths: [] }, evidence).payload).toBeNull();
    expect(validateOverview("not an object", evidence).payload).toBeNull();
  });

  it("unknown ids never become notes, repeats can't inflate coverage, empty isn't explained, duplicates must reference a real explanation", () => {
    const t = (i: number) => ({ attemptId: `att-${i}`, segmentIndexes: [i], kind: "currently_incorrect", reference: `Ref ${i}.`, answer: "x", matchRule: "relaxed", covered: false }) as never;
    const ids = targetIds([t(1), t(2), t(3), t(4), t(5)]);
    const { notes, coverage } = validateNotes(
      [
        { targetId: "T1", kind: "explanation", explanation: "Real explanation." },
        { targetId: "T1", kind: "explanation", explanation: "A repeat that must not count." },
        { targetId: "T9", kind: "explanation", explanation: "Unknown id." },
        { targetId: "T2", kind: "explanation", explanation: "   " },
        { targetId: "T3", kind: "duplicate", explanation: "Same as T1.", duplicateOf: "T1" },
        { targetId: "T4", kind: "duplicate", explanation: "Same as T2.", duplicateOf: "T2" }, // T2 isn't a valid explanation
        { targetId: "T5", kind: "minor", explanation: "A slip." },
      ],
      ids
    );
    expect(notes.map((x) => [x.attemptId, x.kind, x.refAttemptId])).toEqual([
      ["att-1", "explanation", null],
      ["att-3", "duplicate", "att-1"],
      ["att-5", "minor", null],
    ]);
    expect(notes[0].explanation).toBe("Real explanation.");
    expect(coverage).toEqual({ requested: 5, returned: 7, valid: 3, unknownIds: 1, repeatedIds: 1, empty: 1, invalidDuplicates: 1, missing: 2 });
    expect(validateNotes("garbage", ids).coverage).toMatchObject({ valid: 0, missing: 5 });
  });
});

describe("recovery sealing (ai-recovery:v1, 24 h)", () => {
  const SECRET = "s".repeat(40);
  const claims = {
    op: "overview" as const, userId: "u1", roundId: "r1", generation: 3, token: "db-op-token-1234", fingerprint: "f".repeat(64),
    promptVersion: 1, model: "m", payloadHash: contentHash({ a: 1 }), metaHash: contentHash({ b: 2 }),
  };

  it("round-trips; the DB token is not readable in the sealed string", () => {
    const sealed = sealAiRecovery(SECRET, claims, 1000);
    expect(sealed).not.toContain("db-op-token");
    expect(Buffer.from(sealed.slice(3), "base64url").toString("latin1")).not.toContain("db-op-token");
    const opened = openAiRecovery(SECRET, sealed, 1001);
    expect(opened).toMatchObject({ ok: true, claims: { ...claims, v: 1, iat: 1000, exp: 1000 + 86_400 } });
  });

  it("tampered, wrong-secret, malformed and expired tokens are refused", () => {
    const sealed = sealAiRecovery(SECRET, claims, 1000);
    const flipped = sealed.slice(0, -4) + (sealed.slice(-4) === "AAAA" ? "BBBB" : "AAAA");
    expect(openAiRecovery(SECRET, flipped, 1001)).toEqual({ ok: false, reason: "bad_token" });
    expect(openAiRecovery("t".repeat(40), sealed, 1001)).toEqual({ ok: false, reason: "bad_token" });
    expect(openAiRecovery(SECRET, "nonsense", 1001)).toEqual({ ok: false, reason: "malformed" });
    expect(openAiRecovery(SECRET, sealed, 1000 + 86_400)).toEqual({ ok: false, reason: "expired" });
  });

  it("canonical hashing is key-order independent and value sensitive", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe('{"a":[2,{"c":4,"d":3}],"b":1}');
    expect(contentHash({ b: 1, a: 2 })).toBe(contentHash({ a: 2, b: 1 }));
    expect(contentHash({ a: 2 })).not.toBe(contentHash({ a: 3 }));
  });
});

describe("every Gemini call goes through the admitted gateway (static)", () => {
  const SRC = path.resolve(__dirname, "..");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "__tests__") walk(p);
      } else if (/\.(ts|tsx)$/.test(e.name)) files.push(p);
    }
  };
  walk(SRC);

  it("only src/lib/ai/geminiCall.ts calls generateContent / constructs the client", () => {
    const callers = files.filter((f) => /\.generateContent\(|new GoogleGenerativeAI\(/.test(fs.readFileSync(f, "utf8")));
    expect(callers.map((f) => path.relative(SRC, f).replace(/\\/g, "/"))).toEqual(["lib/ai/geminiCall.ts"]);
  });

  it("each provider route uses callGeminiAdmitted (directly or via the pipeline), and nothing uses the removed quota", () => {
    const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), "utf8");
    expect(read("app/api/ai/explain/route.ts")).toMatch(/callGeminiAdmitted\(/);
    expect(read("app/api/transcript/translate/route.ts")).toMatch(/callGeminiAdmitted\(/);
    expect(read("lib/ai/assessmentPipeline.ts")).toMatch(/callGeminiAdmitted/);
    expect(read("app/api/session/[sessionId]/explain-all/route.ts")).toMatch(/runGenerate\(/);
    expect(files.filter((f) => /checkGeminiQuota\(/.test(fs.readFileSync(f, "utf8")))).toEqual([]);
  });
});
