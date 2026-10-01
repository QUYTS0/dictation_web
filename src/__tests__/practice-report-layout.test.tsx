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
jest.mock("@/app/dictation/[videoId]/components/ConfettiBurst", () => ({ ConfettiBurst: () => null }));
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
  shadowing: null,
});

const REPORT = (roundId: string): RoundReport => ({
  round: {
    roundId,
    videoId: "vid1",
    title: "Video one",
    transcriptId: "rev-A",
    status: "completed",
    provenance: "current",
    roundNumber: 1,
    requiredSentenceCount: 4,
    startedAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-03T00:00:00Z",
    completedAt: "2026-09-03T00:00:00Z",
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
  expect(screen.getByRole("button", { name: "Show lesson panel" })).toBeInTheDocument();
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
      body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    } catch {
      body = init?.body ?? null;
    }
    calls.push({ method, path, body });
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
    for (const name of [/Back to practice/, /Open script/, /Continue in Listening/, /Continue in Shadowing/, /Practice again \(new round\)/, "Review sentence 3"]) {
      const el = within(view).getAllByRole("button", { name })[0];
      expect([String(name), hiddenByClass(el)]).toEqual([String(name), false]);
    }
    for (const name of [/Full report/, /Library/]) expect(hiddenByClass(within(view).getByRole("link", { name }))).toBe(false);
    expect(forbiddenWrites()).toEqual([]);

    // "Practice again" is the ONLY action that creates a round — and only after confirming.
    (window.confirm as jest.Mock).mockReturnValueOnce(false);
    fireEvent.click(within(view).getByRole("button", { name: /Practice again/ }));
    expect(forbiddenWrites()).toEqual([]);
    expect(reportView()).toBeInTheDocument();
  });
});
