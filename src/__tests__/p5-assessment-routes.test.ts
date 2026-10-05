/**
 * Learning Reports P5 — route contracts (Supabase, quota admission and Gemini
 * mocked; no provider call is ever made). The database rules themselves are
 * proven on real PostgreSQL (integration/p5-assessments) and the admission
 * script on real Redis (integration/p5-quota-redis).
 */
import { NextRequest } from "next/server";

// ---- Gemini (mocked) ------------------------------------------------------
const generateContent = jest.fn();
jest.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({ getGenerativeModel: () => ({ generateContent }) })),
  SchemaType: new Proxy({}, { get: (_t, k) => String(k) }),
}));
const gemini = (body: unknown, finishReason = "STOP") => ({
  response: {
    text: () => (typeof body === "string" ? body : JSON.stringify(body)),
    candidates: [{ finishReason }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 },
  },
});

// ---- quota admission (mocked) --------------------------------------------
const admit = jest.fn();
jest.mock("@/lib/ai/quota", () => ({ admitGeminiAttempt: (...a: unknown[]) => admit(...a) }));
jest.mock("@/lib/rateLimit", () => ({ checkRateLimit: jest.fn(async () => null) }));
// Translation's non-Gemini tiers find nothing, so its Gemini tier is exercised.
jest.mock("youtube-transcript", () => ({ YoutubeTranscript: { fetchTranscript: async () => [] } }));
jest.mock("@/lib/youtubeTranslatedCaptions", () => ({ fetchYoutubeTranslatedCaptions: async () => [] }));
jest.mock("@vitalets/google-translate-api", () => ({ translate: async () => Promise.reject(new Error("blocked")) }));

// ---- Supabase (mocked) ----------------------------------------------------
type TableResult = { data: unknown; error?: unknown; single?: unknown };
const userTables: Record<string, TableResult> = {};
const serviceTables: Record<string, TableResult> = {};
const writes: string[] = [];
const userRpc = jest.fn();
const serviceRpc = jest.fn();
const getUser = jest.fn();
function builder(source: Record<string, TableResult>, table: string, who: string) {
  const b: Record<string, unknown> = {};
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
  createClient: async () => ({ auth: { getUser }, rpc: (fn: string, a: unknown) => userRpc(fn, a), from: (t: string) => builder(userTables, t, "user") }),
  createServiceClient: () => ({ rpc: (fn: string, a: unknown) => serviceRpc(fn, a), from: (t: string) => builder(serviceTables, t, "service") }),
}));

import { POST as assessmentPOST } from "@/app/api/session/[sessionId]/assessment/route";
import { POST as explanationsPOST } from "@/app/api/session/[sessionId]/explanations/route";
import { POST as recoverPOST } from "@/app/api/session/[sessionId]/assessment/recover/route";
import { POST as translatePOST } from "@/app/api/transcript/translate/route";
import { GET as reportGET } from "@/app/api/session/[sessionId]/report/route";
import { runRecover } from "@/lib/ai/assessmentRecover";
import type { AiActionResponse } from "@/lib/ai/types";

const ROUND = "11111111-1111-4111-8111-111111111111";
const OTHER_ROUND = "22222222-2222-4222-8222-222222222222";
const A = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`;
const row = (n: number, seg: number, expected: string, user: string, ok: boolean, mode: string | null = "relaxed") => ({
  id: A(n), segment_index: seg, expected_text: expected, user_text: user, is_correct: ok, is_practice_valid: true, match_mode: mode,
  created_at: `2026-10-01T00:00:${String(n).padStart(2, "0")}Z`, error_type: ok ? "none" : "wrong_form",
});
const ATTEMPTS = [
  row(1, 0, "Alpha beta.", "alpha bet", false),
  row(2, 1, "Gamma delta.", "gama delta", false),
  row(3, 1, "Gamma delta.", "gamma delta", true),
  row(4, 2, "Epsilon zeta.", "epsilon zeta", true),
];
const sentence = (seg: number, text: string, category: string) => ({
  segmentIndex: seg, text, eligible: true, category,
  dictation: { submissions: 1, practiceSubmissions: 1, first: null, latest: null, everIncorrect: category === "needs_review" || category === "corrected" },
  shadowing: null,
});
const REPORT = {
  round: { roundId: ROUND, transcriptId: "tr-1" },
  historyComplete: true,
  progress: { requiredSentenceCount: 3 },
  dictation: { practicedSentences: 3, latestCorrect: 2, bestStreak: 2, firstTry: { available: true, correct: 1, correctWithHint: 0, correctHintUnknown: 0 } },
  sentences: [sentence(0, "Alpha beta.", "needs_review"), sentence(1, "Gamma delta.", "corrected"), sentence(2, "Epsilon zeta.", "first_try")],
};
const OVERVIEW_OK = {
  overview: "You fixed one sentence and one still needs work.",
  strengths: [{ text: "Sentence 3 was right first time.", evidenceIds: ["S3"] }],
  priorities: [{ title: "Word endings", explanation: "The final letters were cut off.", evidenceIds: ["S1"], practice: "Replay sentence 1." }],
  practicePlan: ["Replay sentence 1 twice."],
  limitations: [],
  sentenceNotes: [
    { targetId: "T1", kind: "explanation", explanation: "“bet” should be “beta”.", correctedText: "Alpha beta." },
    { targetId: "T2", kind: "explanation", explanation: "“gama” needs a second m." },
  ],
};

const started = { status: "started", generation: 7, token: "gen-token" };
const opStarted = (targets: string[]) => ({ status: "started", operationId: "op-1", token: "op-token", seq: 1, targets, covered: [] });
let rpcMap: Record<string, unknown> = {};
function setRpc(map: Record<string, unknown>) {
  rpcMap = map;
}
const order: string[] = [];
const names = () => serviceRpc.mock.calls.map(([fn]) => fn);
const argsOf = (fn: string) => serviceRpc.mock.calls.filter(([n]) => n === fn).map(([, a]) => a);

const post = (handler: typeof assessmentPOST, url: string, body: unknown, roundId = ROUND) =>
  handler(new NextRequest(`http://localhost${url}`, { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ sessionId: roundId }) } as never);
const generate = async () => {
  const res = await post(assessmentPOST, `/api/session/${ROUND}/assessment`, { action: "generate" });
  return { status: res.status, json: (await res.json()) as AiActionResponse & { code?: string; error?: string } };
};

beforeEach(() => {
  jest.clearAllMocks();
  for (const t of [userTables, serviceTables]) for (const k of Object.keys(t)) delete t[k];
  writes.length = 0;
  order.length = 0;
  process.env.GEMINI_API_KEY = "test-key";
  process.env.AI_RECOVERY_SIGNING_SECRET = "r".repeat(40);
  getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  userTables.learning_sessions = { data: null, single: { id: ROUND } };
  userTables.attempt_logs = { data: ATTEMPTS };
  serviceTables.attempt_explanations = { data: [] };
  userRpc.mockImplementation(async (fn: string) => (fn === "fn_round_report" ? { data: REPORT, error: null } : { data: null, error: { message: "no" } }));
  admit.mockImplementation(async (req: { attempt: number }) => {
    order.push(`admit:${req.attempt}`);
    return { status: "admitted", key: "k" };
  });
  generateContent.mockImplementation(async () => {
    order.push("provider");
    return gemini(OVERVIEW_OK);
  });
  setRpc({
    fn_assessment_begin: started,
    fn_explanations_begin: opStarted([A(1), A(2)]),
    fn_assessment_finish: { status: "accepted", generation: 7 },
    fn_explanations_finish: { status: "saved", count: 2, seq: 1 },
    fn_assessment_abandon: { status: "abandoned" },
    fn_explanations_abandon: { status: "abandoned" },
  });
  serviceRpc.mockImplementation(async (fn: string) => {
    order.push(fn);
    const v = rpcMap[fn];
    if (v instanceof Error) return { data: null, error: { message: v.message } };
    return v === undefined ? { data: null, error: { message: `unmocked ${fn}` } } : { data: v, error: null };
  });
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("Generate assessment", () => {
  it("full success: begin overview → begin batch → ONE admission → provider; both saved independently", async () => {
    const { status, json } = await generate();
    expect(status).toBe(200);
    expect(order).toEqual(["fn_assessment_begin", "fn_explanations_begin", "admit:1", "provider", "fn_assessment_finish", "fn_explanations_finish"]);
    expect(admit).toHaveBeenCalledWith(expect.objectContaining({ operationType: "assessment", operationId: `overview:${ROUND}:7`, attempt: 1, userId: "user-1" }));
    const finishArgs = argsOf("fn_assessment_finish")[0] as Record<string, unknown>;
    expect(finishArgs).toMatchObject({ p_generation: 7, p_token: "gen-token", p_prompt_version: 1 });
    expect(finishArgs.p_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(argsOf("fn_explanations_begin")[0]).toMatchObject({ p_target_attempt_ids: [A(1), A(2)], p_intent: "missing", p_prompt_version: 2 });
    expect((argsOf("fn_explanations_finish")[0] as { p_items: unknown[] }).p_items).toEqual([
      { attemptId: A(1), explanation: "“bet” should be “beta”.", correctedText: "Alpha beta.", example: null, tip: null },
      { attemptId: A(2), explanation: "“gama” needs a second m.", correctedText: "Gamma delta.", example: null, tip: null },
    ]);
    expect(json).toMatchObject({ overview: { status: "saved" }, explanations: { status: "saved", requested: 2, valid: 2, saved: 2, missing: 0 }, requestsUsed: 1, truncated: false });
    expect(json.overview.meta?.evidence).toEqual({ individual: 3, aggregateOnly: 0, total: 3 });
    // The prompt carries data as JSON, framed as untrusted; metrics are the report's.
    const prompt = JSON.parse(generateContent.mock.calls[0][0]);
    expect(prompt.data.metrics).toMatchObject({ latestAnswerCorrect: { correct: 2, practiced: 3 }, currentlyIncorrect: 1, corrected: 1 });
    expect(JSON.stringify(prompt)).not.toMatch(/"accuracy"/);
    expect(writes).toEqual([]);
  });

  it("a compatible saved assessment is reused: no admission, no provider call", async () => {
    setRpc({ ...rpcMap, fn_assessment_begin: { status: "reuse", generation: 3 } });
    const { status, json } = await generate();
    expect(status).toBe(200);
    expect(json).toMatchObject({ overview: { status: "reused" }, requestsUsed: 0 });
    expect(admit).not.toHaveBeenCalled();
    expect(generateContent).not.toHaveBeenCalled();
    expect(names()).toEqual(["fn_assessment_begin"]);
  });

  it.each([
    ["in_progress", { status: "in_progress", generation: 2 }, 409],
    ["busy", { status: "busy" }, 409],
    ["outdated_app", { status: "outdated_app" }, 409],
  ])("%s → refused before any spend", async (_n, beginResult, code) => {
    setRpc({ ...rpcMap, fn_assessment_begin: beginResult });
    const { status } = await generate();
    expect(status).toBe(code);
    expect(admit).not.toHaveBeenCalled();
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("explanation batch busy/in_progress: the call serves the overview only and says so", async () => {
    setRpc({ ...rpcMap, fn_explanations_begin: { status: "busy" } });
    const { json } = await generate();
    expect(json.explanations.status).toBe("skipped_busy");
    expect(JSON.parse(generateContent.mock.calls[0][0]).data.targets).toEqual([]);
    expect(names()).not.toContain("fn_explanations_finish");
    expect(names()).not.toContain("fn_explanations_abandon"); // never abandon another request's operation
  });

  it.each([
    ["denied", { status: "denied", reason: "rpd", retryAfterSec: 60 }, 429],
    ["duplicate (unknown outcome)", { status: "duplicate", key: "k" }, 409],
    ["unavailable (Redis down)", { status: "unavailable", reason: "error" }, 503],
  ])("admission %s after both begins: abandons exactly our two operations, no provider call", async (_n, adm, code) => {
    admit.mockResolvedValue(adm);
    const { status } = await generate();
    expect(status).toBe(code);
    expect(generateContent).not.toHaveBeenCalled();
    expect(argsOf("fn_assessment_abandon")).toEqual([expect.objectContaining({ p_generation: 7, p_token: "gen-token" })]);
    expect(argsOf("fn_explanations_abandon")).toEqual([expect.objectContaining({ p_operation_id: "op-1", p_token: "op-token" })]);
  });

  it("provider failure abandons both and keeps saved results; it may still count (ambiguous)", async () => {
    generateContent.mockRejectedValue(new Error("boom"));
    const { status, json } = await generate();
    expect(status).toBe(502);
    expect(json.code).toBe("provider_failed");
    expect(names()).toEqual(expect.arrayContaining(["fn_assessment_abandon", "fn_explanations_abandon"]));
    expect(names()).not.toContain("fn_assessment_finish");
  });

  it.each([
    [400, "rejected the assessment request"],
    [403, "denied access"],
    [429, "separate from the app's displayed limit"],
    [503, "temporarily unavailable"],
  ])("upstream %i has an actionable public message, no automatic retry and no saved-result changes", async (upstreamStatus, message) => {
    generateContent.mockRejectedValue(Object.assign(new Error("private provider response"), { status: upstreamStatus }));
    const { status, json } = await generate();
    expect(status).toBe(502);
    expect(json.code).toBe("provider_failed");
    expect(json.error).toContain(message);
    expect(json.error).not.toContain("private provider response");
    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(admit).toHaveBeenCalledTimes(1);
    expect(names()).toEqual(expect.arrayContaining(["fn_assessment_abandon", "fn_explanations_abandon"]));
    expect(names()).not.toContain("fn_assessment_finish");
    expect(names()).not.toContain("fn_explanations_finish");
  });

  it("unreadable first response → ONE metered parse retry with its own admission id; success is saved (2 requests used)", async () => {
    generateContent.mockResolvedValueOnce(gemini("not json at all")).mockResolvedValueOnce(gemini(OVERVIEW_OK));
    const { json } = await generate();
    expect(admit.mock.calls.map(([r]) => [r.operationId, r.attempt])).toEqual([
      [`overview:${ROUND}:7`, 1],
      [`overview:${ROUND}:7`, 2],
    ]);
    expect(generateContent).toHaveBeenCalledTimes(2);
    expect(json).toMatchObject({ overview: { status: "saved" }, requestsUsed: 2 });
  });

  it("no capacity for the parse retry: stop, abandon, report unreadable (no second provider call)", async () => {
    generateContent.mockResolvedValueOnce(gemini("{broken"));
    admit.mockResolvedValueOnce({ status: "admitted", key: "k" }).mockResolvedValueOnce({ status: "denied", reason: "rpm", retryAfterSec: 30 });
    const { status, json } = await generate();
    expect(status).toBe(502);
    expect(json.code).toBe("unreadable");
    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(names()).toEqual(expect.arrayContaining(["fn_assessment_abandon", "fn_explanations_abandon"]));
  });

  it("overview saved, notes NOT saved (DB error): notes recoverable, their operation left for recovery", async () => {
    setRpc({ ...rpcMap, fn_explanations_finish: new Error("connection reset") });
    const { json } = await generate();
    expect(json.overview.status).toBe("saved");
    expect(json.explanations).toMatchObject({ status: "not_saved", saved: 0, valid: 2 });
    expect(json.explanations.unsaved?.map((n) => n.attemptId)).toEqual([A(1), A(2)]);
    expect(json.explanations.recovery?.token).toMatch(/^v1\./);
    expect(names()).not.toContain("fn_explanations_abandon");
  });

  it("notes saved, overview NOT saved (DB error): overview recoverable", async () => {
    setRpc({ ...rpcMap, fn_assessment_finish: new Error("timeout") });
    const { json } = await generate();
    expect(json.explanations.status).toBe("saved");
    expect(json.overview).toMatchObject({ status: "not_saved", payload: { overview: OVERVIEW_OK.overview } });
    expect(json.overview.recovery?.op).toBe("overview");
  });

  it("overview superseded while the notes remain valid and saved", async () => {
    setRpc({ ...rpcMap, fn_assessment_finish: { status: "superseded", latestGeneration: 8 } });
    const { json } = await generate();
    expect(json.overview.status).toBe("superseded");
    expect(json.explanations.status).toBe("saved");
  });

  it("an unusable overview is abandoned (earlier assessment kept) while valid notes are still saved", async () => {
    generateContent.mockResolvedValue(gemini({ ...OVERVIEW_OK, overview: "   " }));
    const { json } = await generate();
    expect(json.overview.status).toBe("unusable");
    expect(names()).toContain("fn_assessment_abandon");
    expect(names()).not.toContain("fn_assessment_finish");
    expect(json.explanations.status).toBe("saved");
  });

  it("truncated, partial and invalid-evidence output is reported as such, never as full coverage", async () => {
    generateContent.mockResolvedValue(
      gemini(
        {
          ...OVERVIEW_OK,
          strengths: [{ text: "Unsupported claim.", evidenceIds: ["S99"] }],
          sentenceNotes: [OVERVIEW_OK.sentenceNotes[0], { targetId: "T1", kind: "explanation", explanation: "dup id" }, { targetId: "T7", kind: "explanation", explanation: "unknown" }],
        },
        "MAX_TOKENS"
      )
    );
    setRpc({ ...rpcMap, fn_explanations_finish: { status: "saved", count: 1 } });
    const { json } = await generate();
    expect(json.truncated).toBe(true);
    expect(json.explanations).toMatchObject({ requested: 2, valid: 1, saved: 1, missing: 1 });
    expect(json.overview.meta).toMatchObject({ droppedStrengths: 1, truncated: true });
    expect(json.overview.payload?.strengths).toEqual([]);
  });

  it("refuses before any database or quota work when the recovery secret or API key is missing", async () => {
    delete process.env.AI_RECOVERY_SIGNING_SECRET;
    const { status, json } = await generate();
    expect(status).toBe(503);
    expect(json.code).toBe("ai_not_configured");
    expect(serviceRpc).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
  });
});

describe("Explain more / Re-explain", () => {
  it("explanations only: the overview RPCs are never called; a notes-only prompt", async () => {
    setRpc({ ...rpcMap, fn_explanations_begin: opStarted([A(1), A(2)]) });
    generateContent.mockResolvedValue(gemini({ sentenceNotes: OVERVIEW_OK.sentenceNotes }));
    const res = await post(explanationsPOST, `/api/session/${ROUND}/explanations`, { intent: "missing" });
    const json = (await res.json()) as AiActionResponse;
    expect(res.status).toBe(200);
    expect(names().some((n) => n.startsWith("fn_assessment"))).toBe(false);
    expect(admit).toHaveBeenCalledWith(expect.objectContaining({ operationType: "explanations", operationId: `explanations:${ROUND}:op-1` }));
    expect(JSON.parse(generateContent.mock.calls[0][0]).task).toMatch(/Do not write an overview/);
    expect(json).toMatchObject({ action: "explain", overview: { status: "not_requested" }, explanations: { status: "saved", saved: 2 } });
  });

  it("nothing missing → no begin, no admission, no provider call", async () => {
    serviceTables.attempt_explanations = {
      data: [A(1), A(2)].map((a, i) => ({ id: `n${i}`, attempt_id: a, source: "batch", seq: 1, explanation: "x", corrected_text: null, example_text: null, tip: null, prompt_version: 2, model: "m", created_at: "2026-10-02T00:00:00Z" })),
    };
    const res = await post(explanationsPOST, `/api/session/${ROUND}/explanations`, {});
    expect((await res.json()).explanations.status).toBe("reused");
    expect(serviceRpc).not.toHaveBeenCalled();
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("re-explanation is explicit: requires sentences, sends intent reexplain, and is validated", async () => {
    expect((await post(explanationsPOST, `/api/session/${ROUND}/explanations`, { intent: "reexplain" })).status).toBe(400);
    expect((await post(explanationsPOST, `/api/session/${ROUND}/explanations`, { intent: "everything" })).status).toBe(400);
    expect((await post(explanationsPOST, `/api/session/${ROUND}/explanations`, { sentences: Array.from({ length: 36 }, (_, i) => i) })).status).toBe(400);
    expect(serviceRpc).not.toHaveBeenCalled();
    setRpc({ ...rpcMap, fn_explanations_begin: opStarted([A(1)]) });
    generateContent.mockResolvedValue(gemini({ sentenceNotes: [OVERVIEW_OK.sentenceNotes[0]] }));
    await post(explanationsPOST, `/api/session/${ROUND}/explanations`, { intent: "reexplain", sentences: [0] });
    expect(argsOf("fn_explanations_begin")[0]).toMatchObject({ p_intent: "reexplain", p_target_attempt_ids: [A(1)] });
  });
});

describe("Recovery (no provider, no quota)", () => {
  async function unsavedEntries() {
    setRpc({ ...rpcMap, fn_assessment_finish: new Error("down"), fn_explanations_finish: new Error("down") });
    const { json } = await generate();
    return { overview: json.overview.recovery!, notes: json.explanations.recovery! };
  }

  it("calls the SAME finish RPCs with the same arguments as the direct save", async () => {
    const entries = await unsavedEntries();
    const direct = { a: argsOf("fn_assessment_finish")[0], e: argsOf("fn_explanations_finish")[0] };
    jest.clearAllMocks();
    setRpc({ ...rpcMap, fn_assessment_finish: { status: "accepted" }, fn_explanations_finish: { status: "saved", count: 2 } });
    const res = await post(recoverPOST, `/api/session/${ROUND}/assessment/recover`, { entries: [entries.overview, entries.notes] });
    expect(await res.json()).toEqual({ results: [{ op: "overview", status: "saved" }, { op: "explanations", status: "saved" }] });
    expect(argsOf("fn_assessment_finish")[0]).toEqual(direct.a);
    expect(argsOf("fn_explanations_finish")[0]).toEqual(direct.e);
    expect(admit).not.toHaveBeenCalled();
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("idempotent and terminal outcomes map honestly; DB still down stays recoverable", async () => {
    const entries = await unsavedEntries();
    setRpc({ ...rpcMap, fn_assessment_finish: { status: "already_accepted" }, fn_explanations_finish: new Error("still down") });
    const res = await post(recoverPOST, `/api/session/${ROUND}/assessment/recover`, { entries: [entries.overview, entries.notes] });
    expect((await res.json()).results).toEqual([{ op: "overview", status: "saved" }, { op: "explanations", status: "not_saved" }]);
    setRpc({ ...rpcMap, fn_assessment_finish: { status: "superseded" } });
    const again = await post(recoverPOST, `/api/session/${ROUND}/assessment/recover`, { entries: [entries.overview] });
    expect((await again.json()).results).toEqual([{ op: "overview", status: "superseded" }]);
  });

  it("modified payload, wrong user, wrong round and expired tokens are refused without any finish call", async () => {
    const entries = await unsavedEntries();
    jest.clearAllMocks();
    const tampered = { ...entries.overview, payload: { ...entries.overview.payload, overview: "Edited by the client." } };
    expect((await (await post(recoverPOST, `/api/session/${ROUND}/assessment/recover`, { entries: [tampered] })).json()).results).toEqual([{ op: "overview", status: "invalid" }]);
    expect((await (await post(recoverPOST, `/api/session/${OTHER_ROUND}/assessment/recover`, { entries: [entries.notes] }, OTHER_ROUND)).json()).results).toEqual([{ op: "explanations", status: "invalid" }]);
    getUser.mockResolvedValue({ data: { user: { id: "someone-else" } } });
    expect((await (await post(recoverPOST, `/api/session/${ROUND}/assessment/recover`, { entries: [entries.overview] })).json()).results).toEqual([{ op: "overview", status: "invalid" }]);
    const expired = await runRecover({ service: { rpc: serviceRpc } as never, userId: "user-1", roundId: ROUND, nowSec: Math.floor(Date.now() / 1000) + 86_401 }, [entries.overview]);
    expect(expired.body).toEqual({ results: [{ op: "overview", status: "expired" }] });
    expect(names()).toEqual([]);
  });
});

describe("Translation uses per-attempt admission too", () => {
  beforeEach(() => {
    serviceTables.transcript_segments = { data: [{ segment_index: 0, start_sec: 0, end_sec: 2, text_raw: "Hello there." }] };
    serviceTables.transcript_translations = { data: [] };
  });
  const call = () =>
    translatePOST(new NextRequest("http://localhost/api/transcript/translate", { method: "POST", body: JSON.stringify({ videoId: "vid", transcriptId: "tr-1", language: "vi" }) }));

  it("the Gemini tier is admitted (scoped to the signed-in user) before the provider call", async () => {
    generateContent.mockResolvedValue(gemini([{ index: 1, translation: "Xin chào." }]));
    const res = await call();
    expect(res.status).toBe(200);
    expect(admit).toHaveBeenCalledWith(expect.objectContaining({ operationType: "translate", attempt: 1, userId: "user-1" }));
    expect((admit.mock.calls[0][0] as { operationId: string }).operationId).toMatch(/^translate:tr-1:vi:[0-9a-f]{16}:[0-9a-f-]{36}$/);
  });

  it("not admitted → the tier is skipped, no provider call", async () => {
    admit.mockResolvedValue({ status: "unavailable", reason: "not_configured" });
    const res = await call();
    expect(res.status).toBe(502); // nothing else could translate it in this test
    expect(generateContent).not.toHaveBeenCalled();
  });
});

describe("GET report — the AI block is read-only", () => {
  beforeEach(() => {
    userTables.learning_sessions = {
      data: null,
      single: { id: ROUND, youtube_video_id: "vid", transcript_id: "tr-1", status: "completed", accuracy: 99, total_attempts: 4, current_segment_index: 0, started_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-02T00:00:00Z", ai_assessment: { verdict: "Legacy verdict", strengths: [], weaknesses: [], recommendation: "" }, ai_assessment_generated_at: "2026-09-01T00:00:00Z" },
    };
    userTables.videos = { data: null, single: { title: "T" } };
    userTables.transcripts = { data: null, single: { version: 1 } };
    userTables.study_sessions = { data: [] };
    userTables.attempt_explanations = { data: [] };
  });
  const get = async () => (await reportGET(new NextRequest(`http://localhost/api/session/${ROUND}/report`), { params: Promise.resolve({ sessionId: ROUND }) } as never)).json();

  it("legacy assessment is the fallback while a generation runs; nothing is written or called", async () => {
    userTables.round_assessments = { data: null, single: { accepted_generation: null, accepted_payload: null, latest_started_generation: 2 } };
    userTables.assessment_generations = { data: null, single: { generation: 2, state: "started", lease_expires_at: new Date(Date.now() + 60_000).toISOString() } };
    const body = await get();
    expect(body.ai).toMatchObject({ accepted: null, legacy: { verdict: "Legacy verdict" }, generating: true, targets: { total: 2, missing: 2 } });
    expect(userRpc.mock.calls.map(([fn]) => fn)).toEqual(["fn_round_report"]);
    expect(serviceRpc).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
    expect(generateContent).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("an accepted assessment wins; freshness and content version are reported separately", async () => {
    userTables.round_assessments = {
      data: null,
      single: { accepted_generation: 1, accepted_fingerprint: "0".repeat(64), accepted_prompt_version: 1, accepted_model: process.env.GEMINI_MODEL ?? "gemini-3.6-flash", accepted_payload: { overview: "Saved.", strengths: [], priorities: [], practicePlan: [], limitations: [] }, accepted_meta: null, accepted_at: "2026-10-03T00:00:00Z", latest_started_generation: 1 },
    };
    userTables.assessment_generations = { data: null, single: { generation: 1, state: "accepted", lease_expires_at: null } };
    const body = await get();
    expect(body.ai).toMatchObject({ accepted: { payload: { overview: "Saved." }, fresh: false, contentCurrent: true }, legacy: null, generating: false });
  });
});
