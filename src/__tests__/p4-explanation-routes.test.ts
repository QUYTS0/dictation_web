/**
 * Learning Reports P4 — route contracts for saved explanations (Supabase and
 * Gemini mocked; no provider call is ever made). The database guarantees
 * themselves (tokens, idempotency, locking, RLS, legacy capture) are proven
 * on real PostgreSQL in integration/p4-saved-explanations.integration.test.ts.
 *
 * Covered here:
 *  - explain-all: begin BEFORE quota/provider; reuse → no explanation request
 *    (the unchanged overview still runs, as an assessment-only call); partial
 *    coverage → only missing targets are sent and saved; in_progress → 409 with
 *    no spend; quota denial / no usable notes → abandon; failed save → output
 *    flagged unsaved; never touches ai_feedback; mode-aware target grouping;
 *    explicit reexplain intent, validated.
 *  - /api/ai/explain: stored attempt texts only (body text ignored), owned
 *    attempt required, saved note reused with no spend, unsaved reported.
 *  - report GET: reads attempt_explanations read-only, labels pattern reuse
 *    and history, and stays usable when the notes can't be loaded.
 */
import { NextRequest } from "next/server";

const generateContent = jest.fn();
jest.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: () => ({ generateContent }),
  })),
  SchemaType: new Proxy({}, { get: (_t, k) => String(k) }),
}));
const checkGeminiQuota = jest.fn();
jest.mock("@/lib/rateLimit", () => ({
  checkRateLimit: jest.fn(async () => null),
  checkGeminiQuota: (...args: unknown[]) => checkGeminiQuota(...args),
}));

/** `single`: what .maybeSingle() returns when it differs from the list result. */
type TableResult = { data: unknown; error?: unknown; count?: number; single?: unknown };
const userTables: Record<string, TableResult> = {};
const serviceTables: Record<string, TableResult> = {};
const writes: string[] = [];
const reads: string[] = [];
const userRpc = jest.fn();
const serviceRpc = jest.fn();
const getUser = jest.fn();

function builder(source: Record<string, TableResult>, table: string, who: string) {
  const b: Record<string, unknown> = {};
  reads.push(`${who}.${table}`);
  for (const m of ["select", "eq", "in", "is", "order", "limit"]) b[m] = () => b;
  for (const m of ["insert", "update", "upsert", "delete"]) {
    b[m] = () => {
      writes.push(`${who}.${table}.${m}`);
      return b;
    };
  }
  const result = () => ({ error: null, ...(source[table] ?? { data: null }) });
  b.maybeSingle = async () => {
    const r = result();
    return "single" in r ? { ...r, data: r.single } : r;
  };
  b.then = (res: (v: unknown) => unknown) => Promise.resolve(result()).then(res);
  return b;
}

jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser },
    rpc: (fn: string, args: unknown) => userRpc(fn, args),
    from: (t: string) => builder(userTables, t, "user"),
  }),
  createServiceClient: () => ({
    rpc: (fn: string, args: unknown) => serviceRpc(fn, args),
    from: (t: string) => builder(serviceTables, t, "service"),
  }),
}));

import { POST as explainAllPOST } from "@/app/api/session/[sessionId]/explain-all/route";
import { POST as explainPOST } from "@/app/api/ai/explain/route";
import { GET as reportGET } from "@/app/api/session/[sessionId]/report/route";

const ROUND = "11111111-1111-4111-8111-111111111111";
const A = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ASSESSMENT = { verdict: "Good", strengths: ["s"], weaknesses: ["w"], recommendation: "r" };

const attempt = (n: number, seg: number, expected: string, user: string, mode: string | null = "relaxed") => ({
  id: A(n),
  segment_index: seg,
  expected_text: expected,
  user_text: user,
  match_mode: mode,
  created_at: `2026-09-01T00:00:${String(n).padStart(2, "0")}Z`,
});
const savedNote = (attemptId: string, explanation: string, seq: number | null = 1, source = "batch") => ({
  id: `note-${attemptId}-${seq}`,
  attempt_id: attemptId,
  source,
  seq,
  explanation,
  corrected_text: "Fixed.",
  example_text: "Ex.",
  tip: null,
  prompt_version: seq === null ? null : 1,
  model: seq === null ? null : "m",
  created_at: "2026-09-02T00:00:00Z",
});

function rpcResults(map: Record<string, unknown>) {
  serviceRpc.mockImplementation(async (fn: string) => {
    if (fn in map) return { data: map[fn], error: null };
    if (fn === "fn_persist_session_assessment") return { data: true, error: null };
    if (fn === "fn_explanations_abandon") return { data: { status: "abandoned" }, error: null };
    return { data: null, error: { message: `unexpected rpc ${fn}` } };
  });
}
const rpcNames = () => serviceRpc.mock.calls.map(([fn]) => fn);
const rpcArgs = (fn: string) => serviceRpc.mock.calls.find(([name]) => name === fn)?.[1] as Record<string, unknown> | undefined;
const started = (targets: string[], covered: string[] = []) => ({
  status: "started",
  operationId: "op-1",
  token: "tok-1",
  seq: 1,
  targets,
  covered,
});
const mergedResponse = (items: unknown[]) => ({ response: { text: () => JSON.stringify({ assessment: ASSESSMENT, items }) } });
const assessmentOnlyResponse = { response: { text: () => JSON.stringify({ assessment: ASSESSMENT }) } };

const explainAll = (body?: unknown) =>
  explainAllPOST(
    new NextRequest(`http://localhost/api/session/${ROUND}/explain-all`, {
      method: "POST",
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    { params: Promise.resolve({ sessionId: ROUND }) } as never
  );
const explainOne = (body: unknown) =>
  explainPOST(new NextRequest("http://localhost/api/ai/explain", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  jest.clearAllMocks();
  for (const t of [userTables, serviceTables]) for (const k of Object.keys(t)) delete t[k];
  writes.length = 0;
  reads.length = 0;
  process.env.GEMINI_API_KEY = "test";
  getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  checkGeminiQuota.mockResolvedValue({ allowed: true });
  userTables.learning_sessions = { data: { id: ROUND, transcript_id: "tr", accuracy: 50, total_attempts: 4 } };
  userTables.transcript_segments = { data: null, count: 4 };
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("POST /api/session/[id]/explain-all (P4)", () => {
  it("everything already saved: no begin, no explanation request — the unchanged overview runs as ONE assessment-only call", async () => {
    userTables.attempt_logs = { data: [attempt(1, 0, "Alpha beta.", "alpha bet"), attempt(2, 2, "Alpha beta.", "Alpha bet!")] };
    serviceTables.attempt_explanations = { data: [savedNote(A(1), "Saved alpha.")] }; // A(2) is the same relaxed mistake
    rpcResults({});
    generateContent.mockResolvedValue(assessmentOnlyResponse);

    const res = await explainAll();
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(rpcNames()).toEqual(["fn_persist_session_assessment"]);
    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(generateContent.mock.calls[0][0]).not.toContain('"items"');
    expect(json.assessment).toEqual(ASSESSMENT);
    expect(json.explanations).toEqual({ status: "reused", requested: 0, saved: 0, alreadySaved: 1, remaining: 0 });
    expect(json.items).toEqual([]);
  });

  it("a save that finished after our read is honoured: begin says reuse → still no explanation request", async () => {
    userTables.attempt_logs = { data: [attempt(1, 0, "Alpha beta.", "alpha bet")] };
    serviceTables.attempt_explanations = { data: [] };
    rpcResults({ fn_explanations_begin: { status: "reuse", covered: [A(1)], targets: [] } });
    generateContent.mockResolvedValue(assessmentOnlyResponse);

    const json = await (await explainAll()).json();
    expect(rpcNames()).toEqual(["fn_explanations_begin", "fn_persist_session_assessment"]);
    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(generateContent.mock.calls[0][0]).not.toContain('"items"');
    expect(json.explanations).toMatchObject({ status: "reused", alreadySaved: 1 });
  });

  it("partial coverage: begin happens before quota; only the authoritative remaining targets are sent and saved", async () => {
    userTables.attempt_logs = {
      data: [attempt(1, 0, "Alpha beta.", "alpha bet"), attempt(2, 1, "Gamma delta.", "gamma delt"), attempt(3, 2, "Epsilon.", "epsilo")],
    };
    serviceTables.attempt_explanations = { data: [savedNote(A(1), "Saved alpha.")] };
    // The pre-read leaves A(2), A(3); the DB says A(2) was saved meanwhile.
    rpcResults({
      fn_explanations_begin: started([A(3)], [A(2)]),
      fn_explanations_finish: { status: "saved", count: 1, seq: 1 },
    });
    const order: string[] = [];
    serviceRpc.mockImplementationOnce(async (fn: string) => {
      order.push(fn);
      return { data: started([A(3)], [A(2)]), error: null };
    });
    checkGeminiQuota.mockImplementation(async () => {
      order.push("quota");
      return { allowed: true };
    });
    generateContent.mockImplementation(async (prompt: string) => {
      order.push("provider");
      expect(prompt).toContain("epsilo");
      expect(prompt).not.toMatch(/ONLY for these \d+ distinct patterns[\s\S]*gamma delt/);
      return mergedResponse([{ index: 1, status: "explained", explanation: "Epsilon note.", correctedText: "Epsilon.", example: "E." }]);
    });

    const json = await (await explainAll()).json();
    expect(order).toEqual(["fn_explanations_begin", "quota", "provider"]);
    expect(rpcArgs("fn_explanations_begin")).toMatchObject({ p_target_attempt_ids: [A(2), A(3)], p_intent: "missing", p_kind: "batch" });
    expect(rpcArgs("fn_explanations_finish")).toMatchObject({
      p_operation_id: "op-1",
      p_token: "tok-1",
      p_items: [{ attemptId: A(3), explanation: "Epsilon note.", correctedText: "Epsilon.", example: "E.", tip: null }],
    });
    expect(json.explanations).toEqual({ status: "saved", requested: 1, saved: 1, alreadySaved: 2, remaining: 0 });
    expect(writes).toEqual([]); // never a direct table write — in particular no ai_feedback DELETE/INSERT
    expect(reads).not.toContain("service.ai_feedback");
  });

  it("another request is generating: 409, no quota check, no provider call", async () => {
    userTables.attempt_logs = { data: [attempt(1, 0, "Alpha beta.", "alpha bet")] };
    serviceTables.attempt_explanations = { data: [] };
    for (const status of ["in_progress", "busy"]) {
      rpcResults({ fn_explanations_begin: status === "busy" ? { status } : { status, operationId: "op-0" } });
      const res = await explainAll();
      expect(res.status).toBe(409);
    }
    expect(checkGeminiQuota).not.toHaveBeenCalled();
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("quota denied after begin: the operation is abandoned and nothing is called", async () => {
    userTables.attempt_logs = { data: [attempt(1, 0, "Alpha beta.", "alpha bet")] };
    serviceTables.attempt_explanations = { data: [] };
    rpcResults({ fn_explanations_begin: started([A(1)]) });
    checkGeminiQuota.mockResolvedValue({ allowed: false, reason: "rpd" });
    const res = await explainAll();
    expect(res.status).toBe(429);
    expect(rpcArgs("fn_explanations_abandon")).toMatchObject({ p_operation_id: "op-1", p_token: "tok-1", p_reason: "quota_denied" });
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("a response without usable notes is abandoned and reported as none_usable — never as saved", async () => {
    userTables.attempt_logs = { data: [attempt(1, 0, "Alpha beta.", "alpha bet")] };
    serviceTables.attempt_explanations = { data: [] };
    rpcResults({ fn_explanations_begin: started([A(1)]) });
    generateContent.mockResolvedValue(mergedResponse([{ index: 1, status: "explained", explanation: "  " }]));
    const json = await (await explainAll()).json();
    expect(rpcNames()).not.toContain("fn_explanations_finish");
    expect(rpcArgs("fn_explanations_abandon")).toMatchObject({ p_reason: "no_usable_notes" });
    expect(json.explanations).toMatchObject({ status: "none_usable", saved: 0 });
    expect(json.items.find((i: { attemptId: string }) => i.attemptId === A(1))).toMatchObject({ status: "minor" });
  });

  it("a failed save keeps earlier notes untouched and flags the new output as unsaved", async () => {
    userTables.attempt_logs = { data: [attempt(1, 0, "Alpha beta.", "alpha bet")] };
    serviceTables.attempt_explanations = { data: [] };
    rpcResults({ fn_explanations_begin: started([A(1)]) });
    serviceRpc.mockImplementation(async (fn: string) => {
      if (fn === "fn_explanations_begin") return { data: started([A(1)]), error: null };
      if (fn === "fn_explanations_finish") return { data: null, error: { message: "connection reset" } };
      if (fn === "fn_persist_session_assessment") return { data: true, error: null };
      return { data: { status: "abandoned" }, error: null };
    });
    generateContent.mockResolvedValue(mergedResponse([{ index: 1, status: "explained", explanation: "New alpha.", correctedText: "Alpha beta.", example: "E." }]));
    const json = await (await explainAll()).json();
    expect(json.explanations).toMatchObject({ status: "not_saved", saved: 0 });
    expect(json.items[0]).toMatchObject({ attemptId: A(1), status: "explained", unsaved: true });
    // A DB error leaves the operation for its lease to expire (a later recovery could finish it).
    expect(rpcNames()).not.toContain("fn_explanations_abandon");
    expect(writes).toEqual([]);
  });

  it("targets use the mode-aware identity: exact case-only and punctuation-only mistakes stay separate", async () => {
    userTables.attempt_logs = {
      data: [attempt(1, 0, "Epsilon zeta.", "epsilon zeta.", "exact"), attempt(2, 1, "Epsilon zeta.", "Epsilon zeta", "exact")],
    };
    serviceTables.attempt_explanations = { data: [] };
    rpcResults({ fn_explanations_begin: started([A(1), A(2)]), fn_explanations_finish: { status: "saved", count: 2 } });
    generateContent.mockResolvedValue(
      mergedResponse([
        { index: 1, status: "explained", explanation: "Capitalize." },
        { index: 2, status: "explained", explanation: "Add the period." },
      ])
    );
    await explainAll();
    // The legacy (relaxed) grouping would have collapsed these into one target.
    expect(rpcArgs("fn_explanations_begin")?.p_target_attempt_ids).toEqual([A(1), A(2)]);
  });

  it("reexplain is explicit and validated: no saved-note filtering; an unknown intent is refused before anything runs", async () => {
    userTables.attempt_logs = { data: [attempt(1, 0, "Alpha beta.", "alpha bet")] };
    serviceTables.attempt_explanations = { data: [savedNote(A(1), "Saved alpha.")] };
    rpcResults({ fn_explanations_begin: started([A(1)]), fn_explanations_finish: { status: "saved", count: 1 } });
    generateContent.mockResolvedValue(mergedResponse([{ index: 1, status: "explained", explanation: "Fresh alpha." }]));
    await explainAll({ intent: "reexplain" });
    expect(rpcArgs("fn_explanations_begin")).toMatchObject({ p_intent: "reexplain", p_target_attempt_ids: [A(1)] });
    expect(reads).not.toContain("service.attempt_explanations");

    jest.clearAllMocks();
    const bad = await explainAll({ intent: "everything" });
    expect(bad.status).toBe(400);
    expect(serviceRpc).not.toHaveBeenCalled();
    expect(generateContent).not.toHaveBeenCalled();
  });
});

describe("POST /api/ai/explain (P4)", () => {
  const stored = { ...attempt(1, 0, "Alpha beta.", "alpha bet"), session_id: ROUND, is_correct: false };

  it("explains the STORED attempt texts; request-body texts are ignored", async () => {
    userTables.attempt_logs = { data: [stored], single: stored };
    serviceTables.attempt_explanations = { data: [] };
    rpcResults({ fn_explanations_begin: started([A(1)]), fn_explanations_finish: { status: "saved", count: 1 } });
    generateContent.mockResolvedValue({ response: { text: () => JSON.stringify({ explanation: "Beta, not bet.", correctedText: "Alpha beta.", example: "E." }) } });
    const res = await explainOne({ attemptId: A(1), expectedText: "Injected reference", userText: "injected answer" });
    const json = await res.json();
    expect(res.status).toBe(200);
    const prompt = generateContent.mock.calls[0][0] as string;
    expect(prompt).toContain('Expected sentence: "Alpha beta."');
    expect(prompt).toContain('Student wrote: "alpha bet"');
    expect(prompt).not.toContain("Injected");
    expect(rpcArgs("fn_explanations_begin")).toMatchObject({ p_round_id: ROUND, p_target_attempt_ids: [A(1)], p_kind: "single" });
    expect(json).toMatchObject({ explanation: "Beta, not bet.", saved: true, reused: false });
    expect(writes).toEqual([]);
  });

  it("requires an owned attempt: missing id → 400, someone else's (RLS hides it) → 404, both with no spend", async () => {
    expect((await explainOne({ expectedText: "a", userText: "b" })).status).toBe(400);
    userTables.attempt_logs = { data: [], single: null };
    expect((await explainOne({ attemptId: A(9) })).status).toBe(404);
    expect(serviceRpc).not.toHaveBeenCalled();
    expect(checkGeminiQuota).not.toHaveBeenCalled();
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("a saved note is returned with no begin, quota or provider call", async () => {
    userTables.attempt_logs = { data: [stored], single: stored };
    serviceTables.attempt_explanations = { data: [savedNote(A(1), "Saved alpha.")] };
    const json = await (await explainOne({ attemptId: A(1) })).json();
    expect(json).toMatchObject({ explanation: "Saved alpha.", saved: true, reused: true });
    expect(serviceRpc).not.toHaveBeenCalled();
    expect(checkGeminiQuota).not.toHaveBeenCalled();
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("a failed save is reported as saved:false (and a provider failure abandons the operation)", async () => {
    userTables.attempt_logs = { data: [stored], single: stored };
    serviceTables.attempt_explanations = { data: [] };
    serviceRpc.mockImplementation(async (fn: string) => {
      if (fn === "fn_explanations_begin") return { data: started([A(1)]), error: null };
      if (fn === "fn_explanations_finish") return { data: null, error: { message: "timeout" } };
      return { data: { status: "abandoned" }, error: null };
    });
    generateContent.mockResolvedValue({ response: { text: () => JSON.stringify({ explanation: "Beta.", correctedText: "Alpha beta.", example: "" }) } });
    expect(await (await explainOne({ attemptId: A(1) })).json()).toMatchObject({ explanation: "Beta.", saved: false });

    jest.clearAllMocks();
    serviceRpc.mockImplementation(async (fn: string) =>
      fn === "fn_explanations_begin" ? { data: started([A(1)]), error: null } : { data: { status: "abandoned" }, error: null }
    );
    generateContent.mockRejectedValue(new Error("provider down"));
    expect((await explainOne({ attemptId: A(1) })).status).toBe(502);
    expect(rpcArgs("fn_explanations_abandon")).toMatchObject({ p_reason: "provider_failed" });
  });
});

describe("GET /api/session/[id]/report — saved explanations (P4)", () => {
  beforeEach(() => {
    userTables.learning_sessions = {
      data: { id: ROUND, youtube_video_id: "vid", transcript_id: "tr", status: "completed", accuracy: 50, total_attempts: 4, current_segment_index: 0, started_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-02T00:00:00Z" },
    };
    userTables.videos = { data: { title: "T" } };
    userTables.transcripts = { data: { version: 1 } };
    userTables.study_sessions = { data: [] };
    userRpc.mockResolvedValue({ data: { round: { roundId: ROUND }, historyComplete: true, sentences: [] }, error: null });
  });
  const row = (n: number, seg: number, expected: string, user: string, isCorrect = false, mode: string | null = "relaxed") => ({
    ...attempt(n, seg, expected, user, mode),
    is_correct: isCorrect,
    error_type: isCorrect ? "none" : "wrong_form",
    is_practice_valid: true,
  });
  const get = async () => (await reportGET(new NextRequest(`http://localhost/api/session/${ROUND}/report`), { params: Promise.resolve({ sessionId: ROUND }) } as never)).json();

  it("own note, same-round pattern reuse and corrected (historical) answers — read-only, no provider", async () => {
    userTables.attempt_logs = {
      data: [
        row(1, 0, "Alpha beta.", "alpha bet"),
        row(2, 0, "Alpha beta.", "alpha beta", true), // corrected later
        row(3, 1, "Gamma delta.", "gamma delt"),
        row(4, 2, "Alpha beta.", "Alpha bet!"), // same relaxed mistake as sentence 1
        row(5, 3, "Eta.", "et", false, null), // unknown mode: no cross-attempt reuse
      ],
    };
    userTables.attempt_explanations = {
      data: [savedNote(A(1), "Alpha note."), savedNote(A(3), "Legacy gamma.", null, "legacy_ai_feedback")],
    };
    const body = await get();
    const bySeg = Object.fromEntries(body.mistakes.map((m: { segmentIndex: number; aiFeedback: unknown }) => [m.segmentIndex, m.aiFeedback]));
    expect(bySeg[0]).toMatchObject({ explanation: "Alpha note.", via: "attempt", historical: true, legacy: false });
    expect(bySeg[1]).toMatchObject({ explanation: "Legacy gamma.", via: "attempt", legacy: true });
    expect(bySeg[2]).toMatchObject({ explanation: "Alpha note.", via: "pattern", viaSegmentIndex: 0 });
    expect(bySeg[3]).toBeNull();
    expect(userRpc.mock.calls.map(([fn]) => fn)).toEqual(["fn_round_report"]);
    expect(serviceRpc).not.toHaveBeenCalled();
    expect(generateContent).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(reads).not.toContain("user.ai_feedback");
  });

  it("notes that can't be loaded leave the deterministic report intact", async () => {
    userTables.attempt_logs = { data: [row(1, 0, "Alpha beta.", "alpha bet")] };
    userTables.attempt_explanations = { data: null, error: { code: "42P01", message: "relation does not exist" } };
    const body = await get();
    expect(body.explanationsUnavailable).toBe(true);
    expect(body.mistakes).toHaveLength(1);
    expect(body.mistakes[0].aiFeedback).toBeNull();
    expect(body.dictationEvidence.sentences).toHaveLength(1);
  });
});
