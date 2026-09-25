/**
 * explain-all's assessment persistence after the Phase 3 cutover: the route
 * verifies ownership with the caller's own client, then persists ONLY the
 * AI assessment through the backend-only fn_persist_session_assessment —
 * never a direct `learning_sessions` UPDATE (which the cutover removes).
 * Gemini, rate limiting and Supabase are mocked; no AI call is made.
 */
import { NextRequest } from "next/server";

const generateContent = jest.fn();
jest.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: () => ({ generateContent }),
  })),
  SchemaType: new Proxy({}, { get: (_t, k) => String(k) }),
}));
jest.mock("@/lib/rateLimit", () => ({
  checkRateLimit: jest.fn(async () => null),
  checkGeminiQuota: jest.fn(async () => ({ allowed: true })),
}));

const tableWrites: string[] = [];
const serviceRpc = jest.fn();
function chain(result: unknown, table: string) {
  const c: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order", "in", "limit"]) c[m] = () => c;
  for (const m of ["update", "insert", "upsert", "delete"]) {
    c[m] = () => {
      tableWrites.push(`${table}.${m}`);
      return c;
    };
  }
  c.maybeSingle = async () => result;
  c.then = (res: (v: unknown) => unknown) => Promise.resolve(result).then(res);
  return c;
}
const userClient = {
  auth: { getUser: jest.fn(async () => ({ data: { user: { id: "user-1" } } })) },
  from: (table: string) => {
    if (table === "learning_sessions") return chain({ data: { id: "round-1", transcript_id: "t1", accuracy: 50, total_attempts: 2 }, error: null }, table);
    if (table === "attempt_logs")
      return chain(
        { data: [{ id: "a1", segment_index: 0, expected_text: "Hello there friend", user_text: "hello their", created_at: "2026-01-01" }], error: null },
        table
      );
    return chain({ count: 3, error: null }, table);
  },
};
jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => userClient,
  createServiceClient: () => ({
    rpc: serviceRpc,
    from: (table: string) => chain({ data: null, error: null }, table),
  }),
}));

import { POST } from "@/app/api/session/[sessionId]/explain-all/route";

const ASSESSMENT = { summary: "Good effort", strengths: [], weaknesses: [], tips: [] };

function call() {
  return POST(new NextRequest("http://localhost/api/session/round-1/explain-all", { method: "POST" }), {
    params: Promise.resolve({ sessionId: "round-1" }),
  } as never);
}

beforeEach(() => {
  jest.clearAllMocks();
  tableWrites.length = 0;
  process.env.GEMINI_API_KEY = "test";
  // The merged call fails validation twice; the assessment-only fallback succeeds.
  generateContent
    .mockResolvedValueOnce({ response: { text: () => "{}" } })
    .mockResolvedValueOnce({ response: { text: () => "{}" } })
    .mockResolvedValue({ response: { text: () => JSON.stringify({ assessment: ASSESSMENT }) } });
});

it("persists the assessment only through fn_persist_session_assessment, scoped to the verified user", async () => {
  serviceRpc.mockResolvedValue({ data: true, error: null });
  const res = await call();
  expect(res.status).toBe(200);
  expect(serviceRpc).toHaveBeenCalledWith("fn_persist_session_assessment", {
    p_session_id: "round-1",
    p_user_id: "user-1",
    p_assessment: ASSESSMENT,
  });
  expect(tableWrites).not.toContain("learning_sessions.update");
  const json = await res.json();
  expect(json.assessment).toEqual(ASSESSMENT);
  expect(json.assessmentSaved).toBe(true);
});

it("reports honestly when persisting failed (the assessment is still shown, but not claimed as saved)", async () => {
  serviceRpc.mockResolvedValue({ data: null, error: { message: "permission denied", code: "42501" } });
  const json = await (await call()).json();
  expect(json.assessment).toEqual(ASSESSMENT);
  expect(json.assessmentSaved).toBe(false);
});

it("no route in the app writes learning_sessions or attempt_logs directly any more", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("fs") as typeof import("fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require("path") as typeof import("path");
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "__tests__") walk(p);
      } else if (/\.(ts|tsx)$/.test(e.name)) {
        const src = fs.readFileSync(p, "utf8");
        const re = /\.from\(\s*["'](learning_sessions|attempt_logs)["']\s*\)[\s\S]{0,300}?\.(insert|update|upsert|delete)\(/g;
        if (re.test(src)) offenders.push(p);
      }
    }
  };
  walk(path.resolve(__dirname, ".."));
  expect(offenders).toEqual([]);
});
