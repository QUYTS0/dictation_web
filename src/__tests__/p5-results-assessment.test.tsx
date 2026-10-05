/**
 * Learning Reports P5 — the report page's AI block (fetch mocked; no provider
 * exists here). Opening the report never POSTs; freshness and version are two
 * separate labels; unsaved output is shown as "Not saved yet", kept in
 * sessionStorage, retried once automatically and offered with Save; recovery
 * survives a reload; nothing crosses accounts; polling only re-reads.
 */
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

let currentUser: { id: string } | null = { id: "user-A" };
jest.mock("@/context/auth", () => ({ useAuth: () => ({ user: currentUser, loading: false, openAuthModal: jest.fn() }) }));
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }), useSearchParams: () => new URLSearchParams() }));
jest.mock("next/link", () => ({ __esModule: true, default: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
jest.mock("@/components/AppHeader", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/VocabularySaveButton", () => ({ __esModule: true, default: () => null }));
jest.mock("@/components/report/RoundActions", () => ({ RoundActions: () => null }));
jest.mock("@/components/report/RoundSelector", () => ({ RoundSelector: () => null, roundOptionLabel: () => "" }));
jest.mock("@/components/report/RoundReportPanel", () => ({
  parseReportSection: () => null,
  RoundReportPanel: ({ renderSentenceExtra }: { renderSentenceExtra: (s: { segmentIndex: number; text: string }) => React.ReactNode }) => (
    <div>
      {[0, 1].map((i) => (
        <div key={i} data-testid={`sentence-${i}`}>
          {renderSentenceExtra({ segmentIndex: i, text: `Sentence ${i}` })}
        </div>
      ))}
    </div>
  ),
}));

import SessionResultsPage from "@/app/results/[sessionId]/page";
import { savePending } from "@/lib/ai/recoveryStore";

const ROUND = "round-1";
const PAYLOAD = { overview: "Saved overview text.", strengths: [], priorities: [], practicePlan: ["Replay sentence 1."], limitations: [] };
const META = { generatedAt: "2026-10-04T00:00:00Z", promptVersion: 1, model: "m", evidence: { individual: 2, aggregateOnly: 1, total: 3 }, notes: { requested: 1, valid: 1 }, truncated: false, droppedStrengths: 0, droppedPriorities: 0 };
type Ai = Record<string, unknown>;
const aiView = (over: Ai = {}) => ({ accepted: null, legacy: null, generating: false, targets: { total: 3, missing: 3 }, current: { promptVersion: 1, model: "m" }, ...over });
const accepted = (fresh: boolean, contentCurrent: boolean) => ({ payload: PAYLOAD, meta: META, acceptedAt: "2026-10-04T00:00:00Z", fresh, contentCurrent });
function report(ai: Ai, mistakes: unknown[] = [{ segmentIndex: 0, expectedText: "Ref.", userText: "ref", errorType: null, attempts: 1, attemptId: "a0", aiFeedback: null }]) {
  return {
    session: { id: ROUND, videoId: "vid", videoTitle: "Video", status: "completed", accuracy: 0, totalAttempts: 1, currentSegmentIndex: 0, totalSegments: 2, startedAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z", durationSec: 1, assessment: null, assessmentGeneratedAt: null },
    errorBreakdown: [],
    mistakes,
    round: { round: { roundId: ROUND, roundNumber: 1, status: "completed", provenance: "current", startedAt: "2026-10-01T00:00:00Z", transcriptId: "tr" } },
    ai,
  };
}

let reports: unknown[] = [];
let postResponses: Record<string, Array<{ status: number; body: unknown } | (() => Promise<{ status: number; body: unknown }>)>> = {};
let quota: unknown = { configured: true, rpdUsed: 3, rpdLimit: 20, resetsAt: "00:00 UTC" };
const calls: { method: string; url: string; body?: unknown; user: string }[] = [];
const fetchMock = jest.fn(async (url: string, init?: { method?: string; body?: string }) => {
  const method = init?.method ?? "GET";
  calls.push({ method, url, body: init?.body ? JSON.parse(init.body) : undefined, user: currentUser?.id ?? "none" });
  const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
  if (method === "GET" && url.endsWith(`/api/session/${ROUND}/report`)) return json(200, reports.length > 1 ? reports.shift() : reports[0]);
  if (url.startsWith("/api/ai/quota")) return json(200, quota);
  if (url.startsWith("/api/vocabulary")) return json(200, { items: [] });
  const queue = postResponses[url];
  const next = queue?.shift();
  if (!next) throw new Error(`unexpected ${method} ${url}`);
  const r = typeof next === "function" ? await next() : next;
  return json(r.status, r.body);
});
const posts = () => calls.filter((c) => c.method === "POST");

function resolvedParams() {
  const p = Promise.resolve({ sessionId: ROUND }) as Promise<{ sessionId: string }> & { status?: string; value?: unknown };
  p.status = "fulfilled";
  p.value = { sessionId: ROUND };
  return p;
}
function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const params = resolvedParams();
  const ui = () => (
    <QueryClientProvider client={client}>
      <SessionResultsPage params={params} />
    </QueryClientProvider>
  );
  const r = render(ui());
  return { ...r, rerenderPage: () => r.rerender(ui()) };
}

const notSaved = {
  action: "generate",
  overview: { status: "not_saved", payload: { ...PAYLOAD, overview: "Fresh but unsaved overview." }, meta: META, recovery: { op: "overview", token: "v1.overview-token-aaaaaaaaaaaaaaaaaaaaaaaa", payload: PAYLOAD, meta: META } },
  explanations: {
    status: "not_saved", requested: 1, valid: 1, saved: 0, missing: 0, remaining: 2,
    unsaved: [{ attemptId: "a0", kind: "explanation", explanation: "Unsaved note text.", correctedText: "Ref.", example: null, refAttemptId: null }],
    recovery: { op: "explanations", token: "v1.notes-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbb", items: [{ attemptId: "a0" }] },
  },
  truncated: false,
  requestsUsed: 1,
};

beforeEach(() => {
  currentUser = { id: "user-A" };
  reports = [];
  postResponses = {};
  quota = { configured: true, rpdUsed: 3, rpdLimit: 20, resetsAt: "00:00 UTC" };
  calls.length = 0;
  fetchMock.mockClear();
  window.sessionStorage.clear();
  (global as unknown as { fetch: unknown }).fetch = fetchMock;
});
afterEach(() => jest.useRealTimers());

it("opening the report never generates; 'practice changed' and 'earlier version' are separate labels with costed actions", async () => {
  reports = [report(aiView({ accepted: accepted(false, true) }))];
  const { unmount } = renderPage();
  expect(await screen.findByText("Practice changed since this assessment.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Update assessment/ })).toBeInTheDocument();
  expect(screen.getAllByText(/Uses up to 2 AI requests/).length).toBeGreaterThan(0);
  expect(screen.getByText("Saved overview text.")).toBeInTheDocument();
  expect(screen.getByTestId("ai-disclosure")).toHaveTextContent("Gemini saw 2 sentences individually and 1 only as counts");
  expect(screen.getByRole("button", { name: "Explain next 3 of 3" })).toBeInTheDocument();
  expect(screen.getByTestId("ai-quota")).toHaveTextContent("17/20 AI requests left today (shared app limit) · resets 00:00 UTC");
  unmount();

  reports = [report(aiView({ accepted: accepted(true, false) }))];
  renderPage();
  expect(await screen.findByText("Made with an earlier assessment version.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Regenerate assessment/ })).toBeInTheDocument();
  expect(posts()).toEqual([]);
});

it("a legacy assessment is labelled honestly; up to date → no generate button", async () => {
  reports = [report(aiView({ legacy: { verdict: "Old verdict.", strengths: [], weaknesses: [], recommendation: "", generatedAt: null } }))];
  const { unmount } = renderPage();
  expect(await screen.findByText("Earlier assessment (earlier format, freshness unknown).")).toBeInTheDocument();
  expect(screen.getByText("Old verdict.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Generate assessment/ })).toBeInTheDocument();
  unmount();
  reports = [report(aiView({ accepted: accepted(true, true) }))];
  renderPage();
  expect(await screen.findByText("Based on your current answers.")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /assessment/ })).not.toBeInTheDocument();
});

it("unsaved output is shown as not saved, kept for reload, retried once automatically, then saved with Save", async () => {
  reports = [report(aiView())];
  postResponses[`/api/session/${ROUND}/assessment`] = [{ status: 200, body: notSaved }];
  postResponses[`/api/session/${ROUND}/assessment/recover`] = [
    { status: 200, body: { results: [{ op: "overview", status: "not_saved" }, { op: "explanations", status: "not_saved" }] } },
    { status: 200, body: { results: [{ op: "overview", status: "saved" }, { op: "explanations", status: "saved" }] } },
  ];
  renderPage();
  fireEvent.click(await screen.findByRole("button", { name: /Generate assessment/ }));
  expect(await screen.findByText("Fresh but unsaved overview.")).toBeInTheDocument();
  expect(screen.getByText("Not saved — this explanation will disappear when you reload.")).toBeInTheDocument();
  expect(screen.getByText(/Not saved yet — 2 results waiting/)).toBeInTheDocument();
  expect(Object.keys(window.sessionStorage).filter((k) => k.startsWith("ai-recovery:user-A:round-1:"))).toHaveLength(2);
  // One automatic retry (no provider call: only the recover route).
  await waitFor(() => expect(posts().filter((c) => c.url.endsWith("/recover"))).toHaveLength(1), { timeout: 4000 });
  expect(posts()[1].body).toEqual({ entries: [notSaved.overview.recovery, notSaved.explanations.recovery] });
  expect(await screen.findAllByText(/still not saved — try Save again/)).toHaveLength(2); // each operation reported on its own
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText("Assessment saved.")).toBeInTheDocument();
  expect(Object.keys(window.sessionStorage).filter((k) => k.startsWith("ai-recovery:"))).toHaveLength(0);
  expect(posts().filter((c) => c.url.endsWith("/assessment"))).toHaveLength(1); // generation was never re-posted
  await waitFor(() => expect(calls.filter((c) => c.method === "GET" && c.url.endsWith("/report")).length).toBeGreaterThan(1));
});

it("after a reload the pending save is retried once and cleared on a terminal outcome", async () => {
  savePending("user-A", ROUND, notSaved.overview.recovery as never);
  reports = [report(aiView())];
  postResponses[`/api/session/${ROUND}/assessment/recover`] = [{ status: 200, body: { results: [{ op: "overview", status: "superseded" }] } }];
  renderPage();
  expect(await screen.findByText(/Not saved yet — 1 result waiting/)).toBeInTheDocument();
  expect(await screen.findByText(/a newer result was started, so this one was discarded/, undefined, { timeout: 4000 })).toBeInTheDocument();
  expect(Object.keys(window.sessionStorage).filter((k) => k.startsWith("ai-recovery:"))).toHaveLength(0);
});

it("another account never sees or sends the first account's pending saves; a stale response is ignored", async () => {
  savePending("user-A", ROUND, notSaved.overview.recovery as never);
  currentUser = { id: "user-B" };
  reports = [report(aiView())];
  let release: (v: { status: number; body: unknown }) => void = () => {};
  postResponses[`/api/session/${ROUND}/assessment`] = [() => new Promise((r) => (release = r))];
  const { rerenderPage } = renderPage();
  fireEvent.click(await screen.findByRole("button", { name: /Generate assessment/ }));
  expect(screen.queryByText(/Not saved yet/)).not.toBeInTheDocument();
  // Switch account while B's request is in flight; its late answer must not land.
  currentUser = { id: "user-C" };
  await act(async () => rerenderPage());
  await act(async () => release({ status: 200, body: notSaved }));
  await new Promise((r) => setTimeout(r, 50));
  expect(screen.queryByText("Fresh but unsaved overview.")).not.toBeInTheDocument();
  expect(posts().filter((c) => c.url.endsWith("/recover"))).toEqual([]);
});

it("quota exhausted disables the actions; reading saved results still works", async () => {
  quota = { configured: true, rpdUsed: 20, rpdLimit: 20, resetsAt: "00:00 UTC" };
  reports = [report(aiView({ accepted: accepted(false, true) }))];
  renderPage();
  expect(await screen.findByText("Saved overview text.")).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole("button", { name: /Update assessment/ })).toBeDisabled());
  expect(screen.getByRole("button", { name: "Explain next 3 of 3" })).toBeDisabled();
});

it("while a generation runs the last saved assessment stays shown and polling only re-reads the report (bounded)", async () => {
  jest.useFakeTimers();
  reports = [report(aiView({ accepted: accepted(true, true), generating: true })), report(aiView({ accepted: accepted(true, true), generating: true }))];
  renderPage();
  await act(async () => {
    await jest.advanceTimersByTimeAsync(10);
  });
  expect(await screen.findByText("Saved overview text.")).toBeInTheDocument();
  expect(screen.getByTestId("ai-state")).toHaveTextContent("Generating a new assessment…");
  for (let i = 0; i < 25; i++) {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(3000);
    });
  }
  const gets = calls.filter((c) => c.method === "GET" && c.url.endsWith("/report")).length;
  expect(gets).toBeGreaterThan(5);
  expect(gets).toBeLessThanOrEqual(22); // 1 initial + at most 20 polls (+ one in-flight)
  expect(posts()).toEqual([]);
});
