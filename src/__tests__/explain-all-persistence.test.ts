/**
 * explain-all after Learning Reports P5: a COMPATIBILITY adapter for report
 * pages opened before P5. It must run exactly the P5 pipeline (runGenerate:
 * begin → admission → finish through service-role RPCs, never a direct
 * learning_sessions UPDATE) and answer in the old response shape, reporting
 * honestly whether the assessment was saved. The pipeline's own behaviour is
 * covered by p5-assessment-routes.test.ts and the real-PostgreSQL suites.
 */
import { NextRequest } from "next/server";

const runGenerate = jest.fn();
jest.mock("@/lib/ai/assessmentPipeline", () => ({ runGenerate: (...a: unknown[]) => runGenerate(...a) }));
jest.mock("@/lib/rateLimit", () => ({ checkRateLimit: jest.fn(async () => null) }));
jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) } }),
  createServiceClient: () => ({}),
}));

import { POST } from "@/app/api/session/[sessionId]/explain-all/route";

const ROUND = "11111111-1111-4111-8111-111111111111";
const PAYLOAD = {
  overview: "Good effort overall.",
  strengths: [{ text: "Short sentences were right first time.", evidenceIds: ["S2"] }],
  priorities: [{ title: "Word endings", explanation: "Plural -s was dropped.", evidenceIds: ["S1"], practice: "Listen for final s." }],
  practicePlan: ["Replay sentence 1 twice."],
  limitations: [],
};
const META = {
  generatedAt: "2026-10-05T00:00:00Z", promptVersion: 1, model: "m", evidence: { individual: 3, aggregateOnly: 0, total: 3 },
  notes: { requested: 1, valid: 1 }, truncated: false, droppedStrengths: 0, droppedPriorities: 0,
};
const result = (overviewStatus: string) => ({
  httpStatus: 200,
  body: {
    action: "generate",
    overview: { status: overviewStatus, payload: PAYLOAD, meta: META },
    explanations: { status: "saved", requested: 1, valid: 1, saved: 1, missing: 0, remaining: 0 },
    truncated: false,
    requestsUsed: 1,
  },
});

function call() {
  return POST(new NextRequest(`http://localhost/api/session/${ROUND}/explain-all`, { method: "POST" }), {
    params: Promise.resolve({ sessionId: ROUND }),
  } as never);
}

beforeEach(() => jest.clearAllMocks());

it("runs the P5 pipeline for the verified user and answers in the legacy shape (saved through the backend RPCs)", async () => {
  runGenerate.mockResolvedValue(result("saved"));
  const res = await call();
  expect(res.status).toBe(200);
  expect(runGenerate).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-1", roundId: ROUND }));
  const json = await res.json();
  expect(json.assessment).toEqual({
    verdict: "Good effort overall.",
    strengths: ["Short sentences were right first time."],
    weaknesses: ["Word endings: Plural -s was dropped."],
    recommendation: "Replay sentence 1 twice.",
  });
  expect(json.assessmentSaved).toBe(true);
  expect(json.explanations).toMatchObject({ status: "saved", saved: 1 });
});

it("reports honestly when persisting failed (the assessment is still shown, but not claimed as saved)", async () => {
  runGenerate.mockResolvedValue(result("not_saved"));
  const json = await (await call()).json();
  expect(json.assessment.verdict).toBe("Good effort overall.");
  expect(json.assessmentSaved).toBe(false);
});

it("pipeline refusals (quota, in progress, not configured) keep their status and message", async () => {
  runGenerate.mockResolvedValue({ httpStatus: 429, body: { error: "Today's AI requests are used up.", code: "quota_rpd" } });
  const res = await call();
  expect(res.status).toBe(429);
  expect(await res.json()).toEqual({ error: "Today's AI requests are used up." });
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
