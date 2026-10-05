/**
 * Completed-round report layout on the REAL practice page (jsdom).
 *
 * Renders the actual DictationPage with its real hooks, YouTubePlayer
 * component, report view and panels. Only the outside world is replaced:
 *   - the YouTube IFrame API (window.YT) by a scriptable fake player;
 *   - authentication (a signed-in user);
 *   - the network (global fetch, routed per endpoint — every write is
 *     recorded so the tests can prove report navigation makes none);
 *   - unrelated chrome (user menu, confetti canvas).
 *
 * What jsdom can NOT establish: CSS layout (Tailwind classes are not
 * applied), real scrolling, breakpoints, or iPhone rendering. Visibility is
 * asserted through the classes/attributes the page uses to hide things
 * (`hidden`, aria-hidden, unmounting); responsive behavior needs the
 * browser checklist in supabase/PHASE6_RUNBOOK.md §8.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Suspense } from "react";
import type { User } from "@supabase/supabase-js";
import type { ReportSentence, RoundReport } from "@/lib/types/learning";
import type { ResumeSessionResponse } from "@/lib/types";
import { useSessionStore } from "@/store/sessionStore";
import { usePlayerStore } from "@/store/playerStore";

// ---------------------------------------------------------------- outside world

const user = { id: "user-1", email: "learner@example.test" } as User;
jest.mock("@/context/auth", () => ({
  useAuth: () => ({ user, loading: false, openAuthModal: jest.fn(), signOut: jest.fn() }),
  useRequireAuth: () => (cb: () => void) => cb(),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn(), back: jest.fn(), prefetch: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dictation/vid1",
}));
jest.mock("next/link", () => {
  return function MockLink({ href, children, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  };
});
jest.mock("@/components/UserButton", () => function UserButton() {
  return null;
});
jest.mock("@/app/dictation/[videoId]/components/ConfettiBurst", () => ({ ConfettiBurst: () => <div data-testid="confetti" /> }));
/** The microphone recorder, scriptable per test (status / finished clip). */
const mockRecorder: {
  set: ((patch: Record<string, unknown>) => void) | null;
  start: jest.Mock;
  stop: jest.Mock;
  discard: jest.Mock;
} = { set: null, start: jest.fn(), stop: jest.fn(), discard: jest.fn() };
jest.mock("@/hooks/useAudioRecorder", () => {
  const React = jest.requireActual("react");
  return {
    useAudioRecorder: () => {
      const [state, setState] = React.useState({ status: "idle", clip: null });
      mockRecorder.set = (patch: Record<string, unknown>) => setState((prev: object) => ({ ...prev, ...patch }));
      return { ...state, error: null, elapsedSec: 0, level: 0, start: mockRecorder.start, stop: mockRecorder.stop, discard: mockRecorder.discard };
    },
  };
});
jest.mock("@/lib/utils/wavEncode", () => ({ blobToWav16kMono: async () => new Blob(["wav"]) }));
jest.mock("@/app/dictation/[videoId]/player-theme.css", () => ({}));

/** Scriptable stand-in for the YouTube IFrame API player. */
class FakeYTPlayer {
  static instances: FakeYTPlayer[] = [];
  state = -1;
  time = 0;
  calls: string[] = [];
  constructor(
    _el: unknown,
    private readonly opts: { events?: { onReady?: (e: unknown) => void; onStateChange?: (e: unknown) => void } }
  ) {
    FakeYTPlayer.instances.push(this);
    setTimeout(() => this.opts.events?.onReady?.({ target: this }), 0);
  }
  private set(state: number) {
    this.state = state;
    this.opts.events?.onStateChange?.({ data: state, target: this });
  }
  playVideo() {
    this.calls.push("play");
    this.set(1);
  }
  pauseVideo() {
    this.calls.push("pause");
    if (this.state === 1 || this.state === 3) this.set(2);
  }
  seekTo(t: number) {
    this.calls.push(`seek:${t}`);
    this.time = t;
  }
  getCurrentTime() {
    return this.time;
  }
  getDuration() {
    return 8;
  }
  getPlaybackRate() {
    return 1;
  }
  getPlayerState() {
    return this.state;
  }
  setPlaybackRate() {}
  unloadModule() {}
  loadModule() {}
  mute() {}
  unMute() {}
  isMuted() {
    return false;
  }
  getVideoData() {
    return { title: "Video one" };
  }
  destroy() {}
}
const player = () => FakeYTPlayer.instances[FakeYTPlayer.instances.length - 1];

// ---------------------------------------------------------------- data

const SEGMENTS = Array.from({ length: 4 }, (_, i) => ({
  id: `seg-${i}`,
  transcript_id: "rev-A",
  segmentIndex: i,
  start: i * 2,
  end: i * 2 + 2,
  duration: 2,
  text: `Sentence ${i}.`,
  textNormalized: `sentence ${i}`,
}));

/** Per-sentence Shadowing results of the mocked report (Learning Reports P2). */
let reportShadowing: Record<number, ReportSentence["shadowing"]> = {};
/** Round status per round id in the mocked report (default completed). */
let reportStatus: Record<string, "active" | "completed"> = {};
const sentence = (i: number, category: ReportSentence["category"]): ReportSentence => ({
  segmentIndex: i,
  text: `Sentence ${i}.`,
  eligible: true,
  category,
  dictation: {
    submissions: 1,
    practiceSubmissions: 1,
    first: { correct: category !== "needs_review", hintLevel: 0, userText: "x" },
    latest: { correct: category !== "needs_review", userText: "x", errorType: null, attemptId: `a${i}`, createdAt: "2026-09-02T00:00:00Z" },
    everIncorrect: category === "needs_review",
  },
  shadowing: reportShadowing[i] ?? null,
});

const REPORT = (roundId: string): RoundReport => ({
  round: {
    roundId,
    videoId: "vid1",
    title: "Video one",
    transcriptId: "rev-A",
    status: reportStatus[roundId] ?? "completed",
    provenance: "current",
    roundNumber: 1,
    requiredSentenceCount: 4,
    startedAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-03T00:00:00Z",
    completedAt: reportStatus[roundId] === "active" ? null : "2026-09-03T00:00:00Z",
    completedAtApproximate: false,
    currentSegmentIndex: 3,
  },
  historyComplete: true,
  progress: {
    requiredSentenceCount: 4,
    coveredSentences: { dictation: 4, shadowing: 0, overall: 4 },
    coverage: { dictation: 1, shadowing: 0, overall: 1 },
    attemptCount: 4,
    sentenceAccuracy: { correct: 3, practiced: 4, percent: 75 },
  },
  dictation: {
    practicedSentences: 4,
    latestCorrect: 3,
    needsReview: 1,
    corrected: 0,
    submissions: 4,
    invalidSubmissions: 0,
    bestStreak: 2,
    firstTry: { available: true, correct: 3, correctWithHint: 0, correctHintUnknown: 0 },
    accuracy: { correct: 3, practiced: 4, excludedUnverified: 0 },
  },
  shadowing: {
    takes: 0,
    practicedSentences: 0,
    attemptedSentences: 0,
    azure: { evaluatedSentences: 0, pronunciation: null, accuracy: null, completeness: null, fluency: null, prosody: null },
    wordMatch: { evaluatedSentences: 0, accuracy: null, completeness: null },
  },
  activity: { activeSec: 600, trackedSince: "2026-09-01T00:00:00Z", sessionCount: 1, unattributedAnswers: 0, unattributedTakes: 0 },
  sentences: [sentence(0, "first_try"), sentence(1, "first_try"), sentence(2, "needs_review"), sentence(3, "first_try")],
});

const roundSession = (status: "active" | "completed", roundId: string): ResumeSessionResponse => ({
  lastMode: null,
  session: {
    sessionId: roundId,
    currentSegmentIndex: 3,
    videoCurrentTimeSec: 6,
    accuracy: 75,
    totalAttempts: 3,
    updatedAt: new Date().toISOString(),
    status,
    transcriptId: "rev-A",
  },
});

// ---------------------------------------------------------------- network

type Call = { method: string; path: string; body: unknown };
let calls: Call[] = [];
let resume: ResumeSessionResponse;
const WRITES = [
  "/api/session/save-progress",
  "/api/session/restart",
  "/api/dictation/check",
  "/api/practice/attempt",
  "/api/shadowing/attempt",
  "/api/practice/evaluate",
];
const writesTo = (path: string) => calls.filter((c) => c.method !== "GET" && c.path === path);
const forbiddenWrites = () => calls.filter((c) => c.method !== "GET" && WRITES.some((w) => c.path.startsWith(w)));

const json = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as Response;

/** A test's own answer for a request (null = the default routes). */
let routeOverride: ((path: string, method: string, body: unknown) => Response | Promise<Response> | null) | null = null;

function route(path: string, method: string, body: unknown): Response {
  if (path.startsWith("/api/transcript/vid1")) return json({ status: "ready", segments: SEGMENTS, transcriptId: "rev-A" });
  if (path.startsWith("/api/session/resume")) return json(resume);
  const report = path.match(/^\/api\/session\/([^/]+)\/report$/);
  if (report) return json({ round: REPORT(decodeURIComponent(report[1])) });
  if (path === "/api/dictation/check")
    return json({
      isCorrect: true,
      recorded: true,
      roundStatus: "completed",
      diff: [],
      normalizedUser: "sentence 3",
      normalizedExpected: "sentence 3",
      matchMode: "relaxed",
      errorType: null,
    });
  if (path === "/api/videos/vid1/mode") return json({ videoId: "vid1", lastMode: (body as { mode: string }).mode, added: false, inLibrary: true });
  if (path === "/api/transcripts/vid1/versions")
    return json({
      videoId: "vid1",
      language: "en",
      deletionEnabled: false,
      retentionGraceDays: 30,
      revisions: [
        {
          transcriptId: "rev-A",
          version: 1,
          source: "cache",
          status: "ready",
          createdAt: "2026-09-01T00:00:00Z",
          supersededAt: null,
          isCurrent: true,
          sentenceCount: 4,
          yourRound: { roundId: "round-done", status: "completed", roundNumber: 1 },
          size: { textBytes: 40, segmentsBytes: 400, translationsBytes: 0, highlightsBytes: 0, filesBytes: 0, totalBytes: 440, estimatedAt: "2026-10-01T00:00:00Z" },
          retention: { reasons: ["current", "practice_round"], protected: true, eligibleAt: null, inGracePeriod: false, cleanupCandidate: false },
          eligibleForRemovalBytes: 0,
        },
      ],
    });
  if (path.startsWith("/api/streak")) return json({ streakDays: 3, streakTimeZone: "UTC", streakToday: "2026-10-01", streakIncludesUtcFallback: false });
  if (path.startsWith("/api/study-session/activity") || path.startsWith("/api/listening/sync"))
    return json({ processed: true, studySessionId: "ss-1", attribution: "current" });
  if (path.startsWith("/api/bookmarks") || path.startsWith("/api/vocabulary")) return json(method === "GET" ? [] : {});
  if (path.startsWith("/api/session/save-progress")) return json({ sessionId: "round-new" });
  if (path.startsWith("/api/session/restart")) return json({ sessionId: "round-2", transcriptId: "rev-A" });
  return json({ error: "not mocked" }, 404);
}

// ---------------------------------------------------------------- page

import DictationPage from "@/app/dictation/[videoId]/page";

async function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const params = Promise.resolve({ videoId: "vid1" });
  await act(async () => {
    render(
      <QueryClientProvider client={qc}>
        <Suspense fallback={<p>loading page</p>}>
          <DictationPage params={params} />
        </Suspense>
      </QueryClientProvider>
    );
  });
  await waitFor(() => expect(player()).toBeDefined());
  return qc;
}

const practiceArea = () => screen.getByTestId("practice-area");
const reportView = () => screen.queryByTestId("practice-report-view");
const sidePanel = () => screen.queryByRole("tablist", { name: "Right panel sections" });
/** Hidden at every width by a `hidden` class (Tailwind display:none) on it or an ancestor. */
const hiddenByClass = (el: Element | null): boolean =>
  !!el && (el.classList.contains("hidden") || hiddenByClass(el.parentElement));
const expectReportLayout = async () => {
  expect(reportView()).toBeInTheDocument();
  expect(practiceArea()).toHaveClass("hidden"); // the large player and practice controls
  expect(practiceArea()).toHaveAttribute("aria-hidden", "true");
  // The side panel starts collapsed (it leaves after its 0.3 s exit animation).
  await waitFor(() => expect(sidePanel()).not.toBeInTheDocument());
  // One panel control (the top bar's toggle), its state exposed; no second
  // floating button outside Zen mode.
  expect(screen.getByRole("button", { name: "Toggle lesson panel split view" })).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("button", { name: "Show lesson panel" })).not.toBeInTheDocument();
};
const expectPracticeLayout = () => {
  expect(reportView()).not.toBeInTheDocument();
  expect(practiceArea()).not.toHaveClass("hidden");
  expect(practiceArea()).not.toHaveAttribute("aria-hidden");
};
const togglePanel = () => fireEvent.click(screen.getByRole("button", { name: "Toggle lesson panel split view" }));

beforeAll(() => {
  (window as unknown as { YT: unknown }).YT = {
    Player: FakeYTPlayer,
    PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 },
  };
  window.matchMedia ??= ((q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  const g = globalThis as unknown as Record<string, unknown>;
  class NoopObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  g.ResizeObserver ??= NoopObserver;
  g.IntersectionObserver ??= NoopObserver;
  Element.prototype.scrollIntoView ??= function () {};
  Element.prototype.scrollTo ??= function () {};
});

beforeEach(() => {
  calls = [];
  reportShadowing = {};
  reportStatus = {};
  routeOverride = null;
  mockRecorder.start.mockReset();
  mockRecorder.stop.mockReset();
  mockRecorder.discard.mockReset().mockImplementation(() => mockRecorder.set?.({ status: "idle", clip: null }));
  FakeYTPlayer.instances = [];
  window.localStorage.clear();
  window.sessionStorage.clear();
  useSessionStore.getState().reset();
  usePlayerStore.setState({ status: "idle" } as never);
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(window, "confirm").mockReturnValue(true);
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown = null;
    try {
      body = typeof init?.body === "string" ? JSON.parse(init.body) : (init?.body ?? null);
    } catch {
      body = init?.body ?? null;
    }
    calls.push({ method, path, body });
    const overridden = routeOverride?.(url.replace(/^https?:\/\/[^/]+/, ""), method, body);
    if (overridden) return overridden;
    return route(url.replace(/^https?:\/\/[^/]+/, ""), method, body);
  }) as typeof fetch;
});
afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------- tests

describe("completed-round report on the practice page", () => {
  it("1, 9: finishing the last sentence while the sentence plays opens the report as the main content and stops playback", async () => {
    resume = roundSession("active", "round-1");
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Resume at sentence 4/ }));
    await waitFor(() => expect(player().state).toBe(1)); // the last sentence is playing
    expect(sidePanel()).toBeInTheDocument();

    const input = screen.getByLabelText("Type what you hear");
    fireEvent.change(input, { target: { value: "x" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(writesTo("/api/dictation/check")).toHaveLength(1));

    await waitFor(() => expect(reportView()).toBeInTheDocument(), { timeout: 3000 });
    await expectReportLayout();
    expect(player().calls.at(-1)).toBe("pause");
    expect(player().state).toBe(2); // not playing invisibly
    expect(usePlayerStore.getState().status).not.toBe("playing");
    expect(await screen.findByTestId("report-accuracy")).toHaveTextContent("75%"); // the server's whole-round report
  });

  it("2, 9: a reloaded completed round offers its results; opening them while YouTube is playing stops playback", async () => {
    resume = roundSession("completed", "round-done");
    await renderPage();
    await screen.findByRole("button", { name: "View round results" });
    // The learner started the embedded player themselves (YouTube's own button).
    act(() => player().playVideo());
    expect(player().state).toBe(1);
    const writesBefore = forbiddenWrites().length;

    fireEvent.click(screen.getByRole("button", { name: "View round results" }));
    await expectReportLayout();
    await waitFor(() => expect(player().state).toBe(2));
    expect(player().calls.at(-1)).toBe("pause");
    expect(await screen.findByTestId("report-coverage")).toHaveTextContent("4/4");
    // Nothing was restarted, created or answered by opening the report.
    expect(forbiddenWrites()).toHaveLength(writesBefore);
    expect(forbiddenWrites()).toEqual([]);
  });

  it("3, 4: Open script opens the panel; closing it keeps the report; Back to practice restores the panel that was OPEN", async () => {
    resume = roundSession("completed", "round-done");
    await renderPage();
    expect(sidePanel()).toBeInTheDocument(); // the learner's panel is open before the report
    fireEvent.click(await screen.findByRole("button", { name: "View round results" }));
    await expectReportLayout();

    fireEvent.click(screen.getByRole("button", { name: /Open script/ }));
    const tabs = sidePanel();
    expect(tabs).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Toggle lesson panel split view" })).toHaveAttribute("aria-expanded", "true");
    // Focus follows the explicit action into the panel it opened.
    await waitFor(() => expect(screen.getByRole("region", { name: "Lesson panel" })).toHaveFocus());
    expect(within(tabs!).getByRole("tab", { selected: true })).toHaveAccessibleName(/Script/);
    expect(reportView()).toBeInTheDocument(); // still in the report

    togglePanel(); // close the script again
    await waitFor(() => expect(sidePanel()).not.toBeInTheDocument());
    expect(reportView()).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Back to practice/ }));
    expectPracticeLayout();
    await waitFor(() => expect(sidePanel()).toBeInTheDocument()); // restored: it was open before
    expect(forbiddenWrites()).toEqual([]);
  });

  it("5: Back to practice restores a panel that was CLOSED — opening the script in the report doesn't overwrite that choice", async () => {
    resume = roundSession("completed", "round-done");
    await renderPage();
    await screen.findByRole("button", { name: "View round results" });
    togglePanel(); // the learner closes the panel
    await waitFor(() => expect(sidePanel()).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "View round results" }));
    await expectReportLayout();
    fireEvent.click(screen.getByRole("button", { name: /Open script/ }));
    expect(sidePanel()).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Back to practice/ }));
    expectPracticeLayout();
    await waitFor(() => expect(sidePanel()).not.toBeInTheDocument()); // the learner's own choice
    expect(forbiddenWrites()).toEqual([]);
  });

  it("6: switching mode from the report visibly leaves it, saves the mode, and starts nothing", async () => {
    resume = roundSession("completed", "round-done");
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "View round results" }));
    await screen.findByTestId("report-coverage");

    fireEvent.click(screen.getByRole("button", { name: /Continue in Listening/ }));
    expectPracticeLayout();
    await waitFor(() => expect(sidePanel()).toBeInTheDocument());
    expect(window.localStorage.getItem("dictation.input-mode.vid1")).toBe("listening");
    await waitFor(() => expect(writesTo("/api/videos/vid1/mode")).toEqual([{ method: "POST", path: "/api/videos/vid1/mode", body: { mode: "listening" } }]));
    expect(forbiddenWrites()).toEqual([]);
    expect(player().calls).not.toContain("play"); // switching never autoplays
  });

  it("7: reviewing a sentence shows the player and practice at that sentence — no playback, no write, no new round", async () => {
    resume = roundSession("completed", "round-done");
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "View round results" }));
    fireEvent.click((await screen.findAllByRole("button", { name: "Review sentence 3" }))[0]);

    expectPracticeLayout();
    await waitFor(() => expect(sidePanel()).toBeInTheDocument()); // the panel the learner had
    // The practice controls show sentence 3 of 4 (not hidden at any width).
    const positions = await screen.findAllByText("3/4");
    expect(positions.some((el) => !hiddenByClass(el))).toBe(true);
    expect(useSessionStore.getState().sessionId).toBe("round-done"); // the same completed round
    expect(player().calls).not.toContain("play");
    expect(forbiddenWrites()).toEqual([]);
  });

  it("8 + mobile: the essential report actions exist without a desktop-only container, and none of them writes until confirmed", async () => {
    resume = roundSession("completed", "round-done");
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "View round results" }));
    await screen.findByTestId("report-coverage");
    const view = reportView()!;
    for (const name of [/Back to practice/, /Open script/, /Continue in Listening/, /Continue Shadowing in this round/, /Practice again — new round/, "Review sentence 3"]) {
      const el = within(view).getAllByRole("button", { name })[0];
      expect([String(name), hiddenByClass(el)]).toEqual([String(name), false]);
    }
    for (const name of [/Full report/, /Library/]) expect(hiddenByClass(within(view).getByRole("link", { name }))).toBe(false);
    expect(forbiddenWrites()).toEqual([]);

    // "Practice again" is the ONLY action that creates a round — and only after confirming.
    fireEvent.click(within(view).getByRole("button", { name: /Practice again/ }));
    const dialog = await screen.findByRole("alertdialog", { name: "Start a new round?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(forbiddenWrites()).toEqual([]);
    expect(reportView()).toBeInTheDocument();
  });

  it("Phase 9: Settings → Script versions opens the read-only dialog for this video (no write, no delete action)", async () => {
    resume = roundSession("completed", "round-done");
    await renderPage();
    await screen.findByRole("button", { name: "View round results" });
    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    const before = calls.length; // the page's own startup loads are not the dialog's
    fireEvent.click(await screen.findByRole("button", { name: "Script versions" }));
    const dialog = await screen.findByRole("dialog", { name: "Script versions" });
    const row = await within(dialog).findByTestId("script-version-1");
    expect(within(row).getByText("Current")).toBeInTheDocument();
    expect(within(row).getByText("Showing now")).toBeInTheDocument();
    expect(within(row).getByText(/Used by your round 1/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /delete/i })).toBeNull();
    const dialogCalls = calls.slice(before);
    expect(dialogCalls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(dialogCalls.map((c) => c.path)).toContain("/api/transcripts/vid1/versions");
    expect(forbiddenWrites()).toEqual([]);
  });
});

describe("Learning Reports P2 — same-round Shadowing continuation", () => {
  const ROUND = "11111111-1111-4111-8111-111111111111";
  const fetchUrls = () => (global.fetch as jest.Mock).mock.calls.map(([u]) => String(u));
  afterEach(() => window.history.pushState({}, "", "/"));

  it("Continue Shadowing from the report: same round, Shadowing mode, first unrecorded sentence — no save, no new round, no playback", async () => {
    reportShadowing = { 0: { takes: 1, validTakes: 1, latestAzure: null, latestWordMatch: null } };
    resume = roundSession("completed", "round-done");
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "View round results" }));
    fireEvent.click(await screen.findByRole("button", { name: /Continue Shadowing in this round \(4 sentences left\)/ }));

    await waitFor(() => expectPracticeLayout());
    await waitFor(() => expect(window.localStorage.getItem("dictation.input-mode.vid1")).toBe("shadowing"));
    const positions = await screen.findAllByText("2/4"); // sentence 1 is recorded → sentence 2
    expect(positions.some((el) => !hiddenByClass(el))).toBe(true);
    expect(useSessionStore.getState().sessionId).toBe("round-done");
    expect(writesTo("/api/session/restart")).toEqual([]);
    expect(forbiddenWrites()).toEqual([]);
    expect(player().calls).not.toContain("play");
  });

  it("a continuation link loads THAT round (resume?roundId=) and starts at the first unscored sentence", async () => {
    reportShadowing = {
      0: { takes: 1, validTakes: 1, latestAzure: { pronunciationScore: 80, evaluatedAt: "x", attemptId: "s0" }, latestWordMatch: null },
      1: { takes: 1, validTakes: 1, latestAzure: null, latestWordMatch: null },
    };
    window.history.pushState({}, "", `/dictation/vid1?round=${ROUND}&mode=shadowing&start=unscored`);
    resume = roundSession("completed", ROUND);
    await renderPage();
    await waitFor(() => expect(fetchUrls().some((u) => u.includes("/api/session/resume") && u.includes(`roundId=${ROUND}`))).toBe(true));
    const positions = await screen.findAllByText("2/4");
    expect(positions.some((el) => !hiddenByClass(el))).toBe(true);
    expect(useSessionStore.getState().sessionId).toBe(ROUND);
    expect(window.localStorage.getItem("dictation.input-mode.vid1")).toBe("shadowing");
    expect(screen.queryByTestId("continuation-blocked")).toBeNull();
    expect(forbiddenWrites()).toEqual([]);
  });

  it("a newer active round blocks continuing the old one: notice, no practice controls, no writes", async () => {
    window.history.pushState({}, "", `/dictation/vid1?round=${ROUND}&mode=shadowing&start=unrecorded`);
    resume = roundSession("completed", ROUND);
    resume.session!.newerActiveRound = { roundId: "round-2", roundNumber: 2 };
    await renderPage();
    const notice = await screen.findByTestId("continuation-blocked");
    expect(notice).toHaveTextContent("A newer round (Round 2) is in progress");
    expect(within(notice).getByRole("link", { name: "Go to current round" })).toHaveAttribute("href", "/dictation/vid1");
    expect(within(notice).getByRole("link", { name: "Review report" })).toHaveAttribute("href", `/results/${ROUND}`);
    expect(practiceArea()).toHaveClass("hidden");
    expect(forbiddenWrites()).toEqual([]);
  });

  it("regression: selecting a sentence of a completed round that hasn't been entered yet saves into THAT round — never an implicit new round", async () => {
    resume = roundSession("completed", "round-done");
    await renderPage();
    await screen.findByRole("button", { name: "View round results" });
    // Dictation hides the script text: click the sentence's card in the Script tab.
    await waitFor(() => expect(document.querySelector('[data-script-segment-index="1"]')).not.toBeNull());
    fireEvent.click(document.querySelector('[data-script-segment-index="1"]')!);
    await waitFor(() => expect(writesTo("/api/session/save-progress").length).toBeGreaterThan(0));
    for (const w of writesTo("/api/session/save-progress")) expect((w.body as { sessionId?: string }).sessionId).toBe("round-done");
    expect(writesTo("/api/session/restart")).toEqual([]);
  });
});

// ---------------------------------------------------------------- Round menu (P2 follow-up)

describe("Learning Reports P2 follow-up — the Round menu and the one new-round flow", () => {
  const ROUND = "11111111-1111-4111-8111-111111111111";
  const PROGRESS = REPORT("x").progress;
  afterEach(() => window.history.pushState({}, "", "/"));

  const menuTrigger = (variant: "bar" | "zen" = "bar") =>
    within(screen.getByTestId(`round-menu-${variant}`)).getByRole("button", { name: /^Round menu/ });
  const openMenu = async (variant: "bar" | "zen" = "bar") => {
    fireEvent.click(menuTrigger(variant));
    return screen.findByRole("menu", { name: "Round" });
  };
  const menuItem = (name: RegExp) => within(screen.getByRole("menu", { name: "Round" })).getByRole("menuitem", { name });
  const dialog = () => screen.queryByRole("alertdialog");
  const answerInput = () => screen.getByLabelText("Type what you hear") as HTMLInputElement;
  const reportGets = (roundId: string) => calls.filter((c) => c.method === "GET" && c.path === `/api/session/${roundId}/report`);
  const attemptOk = (roundId: string, body: unknown) =>
    json({
      attemptId: "att-1",
      clientAttemptId: (body as { clientAttemptId: string }).clientAttemptId,
      roundId,
      wasInserted: true,
      isPracticeValid: true,
      studySessionId: null,
      roundCompletedByThisRequest: false,
      roundStatus: "active",
      progress: PROGRESS,
      coverage: PROGRESS.coverage,
    });
  const clip = { blob: new Blob(["take"]), url: "blob:take-1", mimeType: "audio/webm", durationSec: 2 };
  /** Shadowing in an ACTIVE round, entered paused at sentence 4. */
  const renderShadowing = async () => {
    window.localStorage.setItem("dictation.input-mode.vid1", "shadowing");
    resume = roundSession("active", "round-1");
    reportStatus = { "round-1": "active" };
    await renderPage();
    await waitFor(() => expect(useSessionStore.getState().sessionId).toBe("round-1"));
    await waitFor(() => expect(mockRecorder.set).not.toBeNull());
  };

  it("1–5, 10: an active round's report opens before the final sentence — read-only, paused, 'Round in progress' — and Back to practice restores everything", async () => {
    resume = roundSession("active", "round-1");
    resume.session!.currentSegmentIndex = 1;
    resume.session!.roundNumber = 3;
    reportStatus = { "round-1": "active" };
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Resume at sentence 2/ }));
    await waitFor(() => expect(player().state).toBe(1)); // sentence 2 is playing
    fireEvent.change(answerInput(), { target: { value: "halftyped" } });
    expect(sidePanel()).toBeInTheDocument();
    expect(menuTrigger()).toHaveAccessibleName("Round menu — Round 3, in progress");
    expect(within(screen.getByTestId("round-menu-bar")).getByTestId("round-menu-label")).toHaveTextContent("Round 3");
    const writesBefore = forbiddenWrites().length;
    const activityBefore = calls.filter((c) => c.path.startsWith("/api/study-session/activity")).length;

    await openMenu();
    fireEvent.click(menuItem(/^View round report/));
    await expectReportLayout();
    expect(await screen.findByTestId("report-coverage")).toBeInTheDocument();
    expect(reportView()).toHaveTextContent("Round in progress");
    expect(reportView()).toHaveTextContent("Round report");
    expect(reportView()).not.toHaveTextContent("Round complete");
    expect(screen.queryByTestId("confetti")).toBeNull();
    expect(reportGets("round-1").length).toBeGreaterThan(0);
    await waitFor(() => expect(player().state).toBe(2)); // paused, not playing out of sight
    // Focus moved into the report; report navigation is not practice.
    expect(within(reportView()!).getByRole("heading", { name: "Video vid1" })).toHaveFocus();
    fireEvent.click(screen.getByRole("tab", { name: "Shadowing" }));
    fireEvent.keyDown(document.body, { key: " ", code: "Space", shiftKey: true }); // Replay shortcut — the practice view is hidden
    const callsAtOpen = player().calls.length;

    fireEvent.click(within(reportView()!).getByRole("button", { name: /Back to practice/ }));
    expectPracticeLayout();
    await waitFor(() => expect(sidePanel()).toBeInTheDocument()); // the learner's panel layout
    expect(answerInput().value).toBe("halftyped"); // the draft
    expect((await screen.findAllByText("2/4")).some((el) => !hiddenByClass(el))).toBe(true); // the sentence
    expect(window.localStorage.getItem("dictation.input-mode.vid1") ?? "dictation").toBe("dictation"); // the mode (never switched)
    expect(player().calls.slice(callsAtOpen)).not.toContain("play"); // no autoplay on return
    await waitFor(() => expect(menuTrigger()).toHaveFocus()); // focus back where the learner was
    expect(useSessionStore.getState().sessionId).toBe("round-1");
    expect(forbiddenWrites()).toHaveLength(writesBefore); // nothing created, restarted, completed or answered
    expect(writesTo("/api/session/restart")).toEqual([]);
    expect(calls.filter((c) => c.path.startsWith("/api/study-session/activity")).length).toBe(activityBefore);
  });

  it("2: a completion celebrated by this page is not repeated when the report is reopened from the menu", async () => {
    resume = roundSession("active", "round-1");
    routeOverride = (path, method, body) => {
      if (path !== "/api/dictation/check") return null;
      const r = route(path, method, body);
      return r.json().then((b: object) => json({ ...b, roundCompletedByThisRequest: true }));
    };
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Resume at sentence 4/ }));
    fireEvent.change(answerInput(), { target: { value: "x" } });
    fireEvent.keyDown(answerInput(), { key: "Enter" });
    await waitFor(() => expect(reportView()).toBeInTheDocument(), { timeout: 3000 });
    expect(screen.getByTestId("confetti")).toBeInTheDocument(); // the server-confirmed completion event
    fireEvent.click(within(reportView()!).getByRole("button", { name: /Back to practice/ }));
    await openMenu();
    fireEvent.click(menuItem(/^View round report/));
    expect(reportView()).toBeInTheDocument();
    expect(screen.queryByTestId("confetti")).toBeNull();
  });

  it("confirmed defect: practice shortcuts no longer act on the hidden player while the report is open", async () => {
    window.localStorage.setItem("dictation.input-mode.vid1", "listening");
    resume = roundSession("completed", "round-done");
    await renderPage();
    await waitFor(() => expect(menuTrigger()).toHaveAccessibleName(/completed/));
    await openMenu();
    fireEvent.click(menuItem(/^View round report/));
    await expectReportLayout();
    const before = player().calls.length;
    fireEvent.keyDown(document.body, { key: " ", code: "Space" }); // Listening play/pause
    fireEvent.keyDown(document.body, { key: " ", code: "Space", shiftKey: true }); // replay
    fireEvent.keyDown(document.body, { key: "ArrowRight", shiftKey: true }); // next sentence
    expect(player().calls.slice(before)).toEqual([]);
    expect(forbiddenWrites()).toEqual([]);
  });

  it("6, 7, 17: recording disables the report; a stopped clip and a pending evaluation survive it — no second save or Evaluate, and the late score stays with its own attempt", async () => {
    let finishEvaluate: (r: Response) => void = () => {};
    routeOverride = (path, method, body) => {
      if (path === "/api/practice/attempt" && method === "POST") return attemptOk("round-1", body);
      if (path === "/api/practice/evaluate") return new Promise<Response>((resolve) => (finishEvaluate = resolve));
      return null;
    };
    await renderShadowing();
    act(() => mockRecorder.set!({ status: "recording" }));
    await openMenu();
    const view = menuItem(/^View round report/);
    expect(view).toHaveAttribute("aria-disabled", "true");
    expect(view).toHaveAccessibleDescription("Stop recording to view report.");
    expect(menuItem(/^Practice again — new round/)).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(view);
    expect(reportView()).toBeNull(); // the recording is never stopped or discarded by the menu
    expect(mockRecorder.stop).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("menu", { name: "Round" }), { key: "Escape" });

    act(() => mockRecorder.set!({ status: "stopped", clip }));
    await waitFor(() => expect(writesTo("/api/practice/attempt")).toHaveLength(1));
    expect((writesTo("/api/practice/attempt")[0].body as { roundId: string }).roundId).toBe("round-1");
    fireEvent.keyDown(document.body, { key: "E", shiftKey: true }); // Evaluate
    await waitFor(() => expect(writesTo("/api/practice/evaluate")).toHaveLength(1));
    const discards = mockRecorder.discard.mock.calls.length;

    await openMenu();
    fireEvent.click(menuItem(/^View round report/));
    await expectReportLayout();
    fireEvent.click(within(reportView()!).getByRole("button", { name: /Back to practice/ }));
    expectPracticeLayout();
    expect(mockRecorder.discard.mock.calls.length).toBe(discards); // the clip is kept
    expect(writesTo("/api/practice/attempt")).toHaveLength(1);
    expect(writesTo("/api/practice/evaluate")).toHaveLength(1);

    // A new round while the score is still being calculated: disclosed, not blocked.
    await openMenu();
    fireEvent.click(menuItem(/^Practice again — new round/));
    const d = await screen.findByRole("alertdialog", { name: "End this round and start a new one?" });
    expect(within(d).getByTestId("new-round-notes")).toHaveTextContent("A pronunciation score is still being calculated");
    fireEvent.click(within(d).getByRole("button", { name: "Start new round" }));
    await waitFor(() => expect(useSessionStore.getState().sessionId).toBe("round-2"));
    await act(async () => {
      finishEvaluate(json({ pronScore: 81, attemptId: "att-1", persisted: true, words: [] }));
    });
    expect(writesTo("/api/practice/evaluate")).toHaveLength(1); // never resubmitted
    expect((writesTo("/api/practice/evaluate")[0].body as FormData).get("attemptId")).toBe("att-1"); // its own attempt (round-1)
    expect(writesTo("/api/practice/attempt")).toHaveLength(1);
  });

  it("8: Listening without a round — the menu explains, creates nothing, and Listening progress stays on screen", async () => {
    window.localStorage.setItem("dictation.input-mode.vid1", "listening");
    resume = { lastMode: null, session: null };
    await renderPage();
    await waitFor(() => expect(menuTrigger()).toHaveAccessibleName("Round menu — No practice round yet."));
    const menu = await openMenu();
    expect(menu).toHaveTextContent("Listening doesn't start a practice round");
    for (const name of [/^View round report/, /^Practice again — new round/]) {
      expect(menuItem(name)).toHaveAttribute("aria-disabled", "true");
      fireEvent.click(menuItem(name));
    }
    expect(reportView()).toBeNull();
    expect(dialog()).toBeNull();
    expect(forbiddenWrites()).toEqual([]);
    expect(calls.filter((c) => c.path.includes("/report"))).toEqual([]);
    expect(useSessionStore.getState().sessionId).toBeNull();
  });

  it("9: a report that fails to load offers Retry and a way back to practice", async () => {
    resume = roundSession("active", "round-1");
    let fail = true;
    routeOverride = (path) => (fail && path.endsWith("/report") ? json({ error: "boom" }, 500) : null);
    await renderPage();
    await screen.findByRole("button", { name: /Resume at sentence 4/ });
    await openMenu();
    fireEvent.click(menuItem(/^View round report/));
    // The report query retries twice on a server error before showing it.
    const alert = await within(reportView()!).findByRole("alert", {}, { timeout: 8000 });
    expect(alert).toHaveTextContent("Couldn't load this round's report.");
    fail = false;
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByTestId("report-coverage")).toBeInTheDocument();
    fireEvent.click(within(reportView()!).getByRole("button", { name: /Back to practice/ }));
    expectPracticeLayout();
    expect(forbiddenWrites()).toEqual([]);
  }, 15000);

  it("11–14, 22: completed round — the card and the menu open the same confirmation; Cancel sends nothing; repeated confirms send ONE restart; the new round starts fresh in the same mode", async () => {
    resume = roundSession("completed", "round-done");
    const qc = await renderPage();
    const invalidate = jest.spyOn(qc, "invalidateQueries");
    // The card's button: the shared dialog, never window.confirm.
    fireEvent.click(await screen.findByRole("button", { name: "Practice again — new round" }));
    let d = await screen.findByRole("alertdialog", { name: "Start a new round?" });
    expect(d).toHaveTextContent("Your previous round and reports will remain in History. Progress starts from zero.");
    expect(within(d).getByRole("button", { name: "Cancel" })).toHaveFocus();
    fireEvent.click(within(d).getByRole("button", { name: "Cancel" }));
    expect(dialog()).toBeNull();
    expect(screen.getByRole("button", { name: "View round results" })).toBeInTheDocument(); // unchanged
    expect(window.confirm).not.toHaveBeenCalled();
    expect(writesTo("/api/session/restart")).toEqual([]);

    // Escape also cancels.
    await openMenu();
    fireEvent.click(menuItem(/^Practice again — new round/));
    d = await screen.findByRole("alertdialog", { name: "Start a new round?" });
    fireEvent.keyDown(d, { key: "Escape" });
    expect(dialog()).toBeNull();
    expect(writesTo("/api/session/restart")).toEqual([]);

    await openMenu();
    fireEvent.click(menuItem(/^Practice again — new round/));
    d = await screen.findByRole("alertdialog", { name: "Start a new round?" });
    const start = within(d).getByRole("button", { name: "Start new round" });
    fireEvent.click(start);
    fireEvent.click(start);
    fireEvent.click(start);
    await waitFor(() => expect(dialog()).toBeNull());
    expect(writesTo("/api/session/restart")).toHaveLength(1);
    expect(writesTo("/api/session/restart")[0].body).toEqual({ videoId: "vid1", sessionId: "round-done" });
    expect(useSessionStore.getState().sessionId).toBe("round-2");
    expect(await screen.findByRole("button", { name: "Start Dictation" })).toBeInTheDocument(); // fresh, from sentence 1
    expect(window.localStorage.getItem("dictation.input-mode.vid1") ?? "dictation").toBe("dictation");
    const keys = invalidate.mock.calls.map(([f]) => JSON.stringify((f as { queryKey?: unknown }).queryKey));
    expect(keys.some((k) => k.includes("round-report") && k.includes("round-done"))).toBe(true);
    expect(keys.some((k) => k.includes("round-report") && k.includes("round-2"))).toBe(true);
  });

  it("15, 16: active round — wording, unsent draft disclosed; a failed restart keeps the round and the draft", async () => {
    resume = roundSession("active", "round-1");
    routeOverride = (path) => (path === "/api/session/restart" ? json({ error: "nope" }, 500) : null);
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Resume at sentence 4/ }));
    fireEvent.change(answerInput(), { target: { value: "unsent" } });
    await openMenu();
    fireEvent.click(menuItem(/^Practice again — new round/));
    const d = await screen.findByRole("alertdialog", { name: "End this round and start a new one?" });
    expect(d).toHaveTextContent("Your current answers and results will remain in History. The new round starts from zero.");
    expect(within(d).getByTestId("new-round-notes")).toHaveTextContent("Your unsent answer for this sentence will be discarded.");
    fireEvent.click(within(d).getByRole("button", { name: "Start new round" }));
    expect(await within(d).findByRole("alert")).toHaveTextContent("Your current round is unchanged.");
    expect(writesTo("/api/session/restart")).toHaveLength(1); // no automatic retry
    expect(useSessionStore.getState().sessionId).toBe("round-1");
    fireEvent.click(within(d).getByRole("button", { name: "Cancel" }));
    expect(answerInput().value).toBe("unsent");
    expect((await screen.findAllByText("4/4")).some((el) => !hiddenByClass(el))).toBe(true);
  });

  it("16: an unsaved recording needs Retry saving or an explicit discard; it is only dropped after the new round is confirmed", async () => {
    let attemptWorks = false;
    routeOverride = (path, method, body) => {
      if (path === "/api/practice/attempt" && method === "POST") return attemptWorks ? attemptOk("round-1", body) : json({ error: "down" }, 500);
      return null;
    };
    await renderShadowing();
    act(() => mockRecorder.set!({ status: "stopped", clip }));
    await waitFor(() => expect(writesTo("/api/practice/attempt")).toHaveLength(1));
    await openMenu();
    fireEvent.click(menuItem(/^Practice again — new round/));
    const d = await screen.findByRole("alertdialog");
    await within(d).findByTestId("new-round-unsaved");
    expect(within(d).getByTestId("new-round-unsaved")).toHaveTextContent("1 recording from this round couldn't be saved yet.");
    const start = within(d).getByRole("button", { name: "Start new round" });
    expect(start).toBeDisabled();
    // Retry: the same take, same id, same round.
    fireEvent.click(within(d).getByRole("button", { name: "Retry saving" }));
    await waitFor(() => expect(writesTo("/api/practice/attempt")).toHaveLength(2));
    const [first, second] = writesTo("/api/practice/attempt").map((w) => w.body as { clientAttemptId: string; roundId: string });
    expect(second).toEqual(first);
    // Still failing: discarding is the learner's explicit choice.
    await waitFor(() => expect(within(d).getByRole("checkbox", { name: "Discard them and continue" })).not.toBeDisabled());
    fireEvent.click(within(d).getByRole("checkbox", { name: "Discard them and continue" }));
    expect(start).not.toBeDisabled();
    fireEvent.click(start);
    await waitFor(() => expect(useSessionStore.getState().sessionId).toBe("round-2"));
    expect(writesTo("/api/session/restart")).toHaveLength(1);
    // Nothing unsaved is listed for the new round.
    await openMenu();
    fireEvent.click(menuItem(/^Practice again — new round/));
    const again = await screen.findByRole("alertdialog");
    expect(within(again).queryByTestId("new-round-unsaved")).toBeNull();
    attemptWorks = true;
  });

  it("16: a recording save in flight blocks the new round until it finishes", async () => {
    let finish: (r: Response) => void = () => {};
    routeOverride = (path, method, body) => {
      if (path === "/api/practice/attempt" && method === "POST") return new Promise<Response>((resolve) => (finish = () => resolve(attemptOk("round-1", body))));
      return null;
    };
    await renderShadowing();
    act(() => mockRecorder.set!({ status: "stopped", clip }));
    await waitFor(() => expect(writesTo("/api/practice/attempt")).toHaveLength(1));
    await openMenu();
    fireEvent.click(menuItem(/^Practice again — new round/));
    const d = await screen.findByRole("alertdialog");
    expect(within(d).getByTestId("new-round-blockers")).toHaveTextContent("1 recording is still being saved — wait a moment.");
    expect(within(d).getByRole("button", { name: "Start new round" })).toBeDisabled();
    await act(async () => finish(json({})));
    await waitFor(() => expect(within(d).getByRole("button", { name: "Start new round" })).not.toBeDisabled());
    expect(writesTo("/api/session/restart")).toEqual([]);
  });

  it("a restart that finds another active round changes nothing locally and offers that round", async () => {
    resume = roundSession("completed", "round-done");
    routeOverride = (path) =>
      path === "/api/session/restart" ? json({ status: "ok", sessionId: "round-9", transcriptId: "rev-A", created: false, roundNumber: 5 }) : null;
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Practice again — new round" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Start new round" }));
    const d = await screen.findByRole("alertdialog", { name: "A newer round is already in progress" });
    expect(d).toHaveTextContent("Round 5 of this video is in progress");
    expect(within(d).getByRole("link", { name: "Go to current round" })).toHaveAttribute("href", "/dictation/vid1");
    expect(within(d).queryByRole("button", { name: "Start new round" })).toBeNull();
    expect(useSessionStore.getState().sessionId).toBeNull(); // the completed round wasn't entered, nothing adopted
    expect(screen.getByRole("button", { name: "View round results" })).toBeInTheDocument();
  });

  it("18: a new round from Listening keeps the mode and Listening's own progress — nothing Listening is reset or written", async () => {
    window.localStorage.setItem("dictation.input-mode.vid1", "listening");
    resume = roundSession("active", "round-1");
    await renderPage();
    await waitFor(() => expect(useSessionStore.getState().sessionId).toBe("round-1"));
    const listeningWrites = () => calls.filter((c) => c.method !== "GET" && c.path.startsWith("/api/listening"));
    const before = listeningWrites().length;
    await openMenu();
    fireEvent.click(menuItem(/^Practice again — new round/));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Start new round" }));
    await waitFor(() => expect(useSessionStore.getState().sessionId).toBe("round-2"));
    expect(window.localStorage.getItem("dictation.input-mode.vid1")).toBe("listening");
    expect(listeningWrites()).toHaveLength(before);
    expect(screen.queryByRole("button", { name: "Start Dictation" })).toBeNull(); // Listening's view isn't reset
  });

  it("19: an outdated round view offers the current round, never a new one", async () => {
    window.history.pushState({}, "", `/dictation/vid1?round=${ROUND}&mode=shadowing&start=unrecorded`);
    resume = roundSession("completed", ROUND);
    resume.session!.newerActiveRound = { roundId: "round-2", roundNumber: 2 };
    await renderPage();
    await screen.findByTestId("continuation-blocked");
    const menu = await openMenu();
    expect(menu).toHaveTextContent("A newer round (Round 2) is in progress.");
    expect(menuItem(/^Go to current round \(Round 2\)/)).toHaveAttribute("href", "/dictation/vid1");
    expect(within(menu).queryByRole("menuitem", { name: /new round/ })).toBeNull();
    expect(forbiddenWrites()).toEqual([]);
  });

  it("20, 21: keyboard — ↓ opens on the first item, arrows/Home/End move, Escape closes and returns focus; keys in the menu never reach the shortcuts", async () => {
    window.localStorage.setItem("dictation.input-mode.vid1", "listening");
    resume = roundSession("active", "round-1");
    await renderPage();
    await waitFor(() => expect(useSessionStore.getState().sessionId).toBe("round-1"));
    const trigger = menuTrigger();
    // One trigger for every width: the full label from sm up, a compact "Round" below.
    expect(within(trigger).getByText("Round", { selector: "span.sm\\:hidden" })).toBeInTheDocument();
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    await screen.findByRole("menu", { name: "Round" });
    expect(menuItem(/^View round report/)).toHaveFocus();
    const menu = screen.getByRole("menu", { name: "Round" });
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(menuItem(/^Practice again — new round/)).toHaveFocus();
    fireEvent.keyDown(menu, { key: "Home" });
    expect(menuItem(/^View round report/)).toHaveFocus();
    fireEvent.keyDown(menu, { key: "End" });
    expect(menuItem(/^Practice again — new round/)).toHaveFocus();
    const before = player().calls.length;
    fireEvent.keyDown(menuItem(/^Practice again — new round/), { key: " ", code: "Space" }); // not play/pause
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger).toHaveFocus();
    expect(player().calls.slice(before)).toEqual([]);

    // Zen: the same menu in the Zen controls; Escape in it closes the menu, not Zen.
    fireEvent.keyDown(document.body, { key: "z" });
    await waitFor(() => expect(screen.getByTestId("round-menu-zen")).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByTestId("round-menu-bar")).toBeNull());
    const zenMenu = await openMenu("zen");
    expect(within(zenMenu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["View round report", "Practice again — new round"]);
    fireEvent.keyDown(zenMenu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByText("Exit Zen Mode (Esc)")).toBeInTheDocument(); // still in Zen
    await openMenu("zen");
    fireEvent.click(menuItem(/^Practice again — new round/));
    expect(await screen.findByRole("alertdialog", { name: "End this round and start a new one?" })).toBeInTheDocument();
  });

  it("22: the resume card's new-round button and the report's action use the same confirmation", async () => {
    resume = roundSession("active", "round-1");
    reportStatus = { "round-1": "active" };
    await renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Start new round" }));
    let d = await screen.findByRole("alertdialog", { name: "End this round and start a new one?" });
    fireEvent.click(within(d).getByRole("button", { name: "Cancel" }));
    await openMenu();
    fireEvent.click(menuItem(/^View round report/));
    await screen.findByTestId("report-coverage");
    fireEvent.click(within(reportView()!).getByRole("button", { name: /Practice again — new round/ }));
    d = await screen.findByRole("alertdialog", { name: "End this round and start a new one?" });
    fireEvent.click(within(d).getByRole("button", { name: "Cancel" }));
    expect(reportView()).toBeInTheDocument();
    expect(window.confirm).not.toHaveBeenCalled();
    expect(writesTo("/api/session/restart")).toEqual([]);
  });
});
