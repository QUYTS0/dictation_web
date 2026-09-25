/**
 * Post-Phase-2 repair: Continue Learning (Dashboard) and History must show
 * only what the stored data actually means.
 *   - The stored percentage is legacy attempt-based answer accuracy — never
 *     drawn as a video-completion bar.
 *   - current_segment_index is the practice page's shared resume point —
 *     labeled neutrally, with correct singular/plural.
 *   - learning_sessions rows carry no reliable "last mode" → no Dictation
 *     badge; legacy listening_sessions rows keep their accurate Listening badge.
 *   - A confirmed save invalidates the cached summary, so navigating to
 *     Dashboard shows the new checkpoint even inside the 60s staleTime.
 */
import { act, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { User } from "@supabase/supabase-js";
import type { ResumableSession } from "@/lib/types";
import type { DashboardSummary } from "@/lib/queries/dashboard";
import { dashboardKeys } from "@/lib/queries/dashboard";
import { formatAnswerAccuracy, formatResumePoint, pluralize, recordModeBadgeLabel } from "@/lib/utils/sessionLabels";

const authUser = { id: "user-1" } as User;
jest.mock("@/context/auth", () => ({
  useAuth: () => ({ user: authUser, loading: false, openAuthModal: jest.fn() }),
}));
jest.mock("next/navigation", () => ({
  usePathname: () => "/dashboard",
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("next/link", () => {
  return function MockLink({
    href,
    children,
    ...rest
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; children: React.ReactNode }) {
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  };
});
jest.mock("@/components/AppHeader", () => function AppHeader() {
  return null;
});
jest.mock("@/app/dictation/[videoId]/api", () => ({
  fetchTranscript: jest.fn(),
  checkAnswerApi: jest.fn(),
  saveProgress: jest.fn(),
  fetchResumeSession: jest.fn(),
  restartSession: jest.fn(),
  regenerateTranscript: jest.fn(),
  saveManualTranscript: jest.fn(),
  requestTranscriptGeneration: jest.fn(),
}));

import DashboardPage from "@/app/dashboard/page";
import HistoryPage from "@/app/history/page";
import { useDictationSession } from "@/app/dictation/[videoId]/useDictationSession";
import * as api from "@/app/dictation/[videoId]/api";
const apiMock = api as jest.Mocked<typeof api>;

function session(overrides: Partial<ResumableSession>): ResumableSession {
  return {
    sessionId: "sess-1",
    mode: "dictation",
    videoId: "vid1",
    videoTitle: "Test video",
    updatedAt: new Date().toISOString(),
    status: "active",
    accuracy: 100,
    currentSegmentIndex: 1,
    totalAttempts: 1,
    mistakesCount: 0,
    ...overrides,
  };
}
function summary(sessions: ResumableSession[]): DashboardSummary {
  return {
    completedVideos: 0,
    avgAccuracy: 0,
    totalPracticeMinutes: 0,
    vocabularyCount: 0,
    streakDays: 0,
    recentVocabulary: [],
    resumableSessions: sessions,
  };
}

// jsdom has no fetch Response; the app only reads .ok and .json().
const jsonResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

let summaryResponse: DashboardSummary;
let summaryFetches = 0;
beforeEach(() => {
  jest.clearAllMocks();
  summaryFetches = 0;
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/dashboard/summary")) {
      summaryFetches += 1;
      return jsonResponse(summaryResponse);
    }
    if (url.includes("/api/dashboard/error-patterns")) {
      return jsonResponse({ total: 0, patterns: [] });
    }
    if (url.includes("/api/history/mistakes")) {
      return jsonResponse({ items: [], total: 0, nextCursor: null });
    }
    return jsonResponse({});
  }) as typeof fetch;
});

// Same default as src/components/Providers.tsx.
const appQueryClient = () => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60 * 1000 } } });

function renderWith(client: QueryClient, node: ReactNode) {
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

describe("label helpers", () => {
  it("pluralizes counts", () => {
    expect(pluralize(0, "attempt")).toBe("0 attempts");
    expect(pluralize(1, "attempt")).toBe("1 attempt");
    expect(pluralize(2, "attempt")).toBe("2 attempts");
  });
  it("never fabricates an accuracy for zero/unknown attempts", () => {
    expect(formatAnswerAccuracy(0, 0)).toBeNull();
    expect(formatAnswerAccuracy(undefined, 3)).toBeNull();
    expect(formatAnswerAccuracy(Number.NaN, 3)).toBeNull();
    expect(formatAnswerAccuracy(100, 1)).toBe("100% of answers correct");
  });
  it("labels the shared checkpoint neutrally, 1-based", () => {
    expect(formatResumePoint(1)).toBe("Resume point: sentence 2");
    expect(formatResumePoint(undefined)).toBe("Resume point: sentence 1");
  });
  it("has no badge for learning_sessions rows, keeps Listening for legacy listening rows", () => {
    expect(recordModeBadgeLabel("dictation")).toBeNull();
    expect(recordModeBadgeLabel("listening")).toBe("Listening");
  });
});

describe("Continue Learning card", () => {
  it("one correct attempt: 100% is shown as answer accuracy, never as a full completion bar", async () => {
    summaryResponse = summary([session({ accuracy: 100, totalAttempts: 1, currentSegmentIndex: 1 })]);
    renderWith(appQueryClient(), <DashboardPage />);

    const stats = await screen.findByTestId("continue-learning-stats");
    expect(stats).toHaveTextContent("Resume point: sentence 2");
    expect(stats).toHaveTextContent("1 attempt");
    expect(stats).not.toHaveTextContent("1 attempts");
    expect(stats).toHaveTextContent("100% of answers correct");
    // No bar whose width is driven by that percentage.
    const card = stats.closest("a")!;
    expect(card.querySelector('[style*="width"]')).toBeNull();
    expect(screen.queryByText(/Saved at sentence/)).toBeNull();
  });

  it("no attempts yet: no percentage at all (not a fabricated 0% or 100%)", async () => {
    summaryResponse = summary([session({ accuracy: 0, totalAttempts: 0, currentSegmentIndex: 0 })]);
    renderWith(appQueryClient(), <DashboardPage />);

    const stats = await screen.findByTestId("continue-learning-stats");
    expect(stats).toHaveTextContent("0 attempts");
    expect(stats).not.toHaveTextContent("%");
  });

  it("no reliable last-mode source: no Dictation badge anywhere on the card", async () => {
    summaryResponse = summary([session({})]);
    renderWith(appQueryClient(), <DashboardPage />);

    const stats = await screen.findByTestId("continue-learning-stats");
    const card = stats.closest("a")!;
    expect(within(card).queryByText("Dictation")).toBeNull();
  });

  it("a legacy Listening record keeps its (accurate) Listening badge", async () => {
    summaryResponse = summary([
      session({ mode: "listening", accuracy: undefined, totalAttempts: undefined, currentSegmentIndex: undefined, videoCurrentTimeSec: 42 }),
    ]);
    renderWith(appQueryClient(), <DashboardPage />);
    const title = await screen.findAllByText("Test video");
    const card = title[0].closest("a")!;
    expect(within(card).getByText("Listening")).toBeInTheDocument();
  });
});

describe("History list", () => {
  it("drops the accuracy-driven progress bar and the Dictation badge, pluralizes attempts", async () => {
    summaryResponse = summary([session({ accuracy: 100, totalAttempts: 1, currentSegmentIndex: 1 })]);
    renderWith(appQueryClient(), <HistoryPage />);

    const resume = await screen.findByText("Resume point: sentence 2");
    const card = resume.closest("a")!;
    expect(within(card).getByText("1 attempt")).toBeInTheDocument();
    expect(within(card).getByText("100% of answers correct")).toBeInTheDocument();
    expect(within(card).queryByText("Dictation")).toBeNull();
    expect(within(card).queryByText("Progress")).toBeNull();
    expect(card.querySelector('[style*="width"]')).toBeNull();
  });
});

describe("confirmed save → Dashboard", () => {
  it("a confirmed progress save marks the cached summary stale, so Dashboard shows the new checkpoint", async () => {
    const client = appQueryClient();
    // Dashboard was visited moments ago: fresh cache entry showing sentence 2.
    client.setQueryData(dashboardKeys.summary(authUser.id), summary([session({ currentSegmentIndex: 1 })]));

    // Practice: an ordinary "active" save of sentence 5 succeeds.
    apiMock.fetchResumeSession.mockResolvedValue({ session: null });
    apiMock.fetchTranscript.mockResolvedValue({
      status: "ready",
      transcriptId: "rev-A",
      segments: Array.from({ length: 6 }, (_, i) => ({
        id: `s${i}`,
        transcript_id: "rev-A",
        segmentIndex: i,
        start: i * 2,
        end: i * 2 + 2,
        duration: 2,
        text: `Sentence ${i}.`,
        textNormalized: `sentence ${i}`,
      })),
    });
    apiMock.saveProgress.mockResolvedValue({ sessionId: "sess-1" });
    const { result, unmount } = renderHook(() => useDictationSession({ videoId: "vid1", user: authUser }), {
      wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    });
    await waitFor(() => expect(result.current.uxState).toBe("transcript_ready"));
    await act(async () => {
      result.current.jumpToSegment(4);
    });
    await waitFor(() => expect(apiMock.saveProgress).toHaveBeenCalled());
    await waitFor(() => expect(client.getQueryState(dashboardKeys.summary(authUser.id))?.isInvalidated).toBe(true));
    unmount();

    // Navigate to Dashboard: the server now reports sentence 5.
    summaryResponse = summary([session({ currentSegmentIndex: 4 })]);
    renderWith(client, <DashboardPage />);
    await waitFor(() => expect(screen.getByTestId("continue-learning-stats")).toHaveTextContent("Resume point: sentence 5"));
    expect(summaryFetches).toBe(1);
  });

  it("a FAILED save does not touch the cache (nothing unsaved is shown as confirmed)", async () => {
    const client = appQueryClient();
    client.setQueryData(dashboardKeys.summary(authUser.id), summary([session({ currentSegmentIndex: 1 })]));
    apiMock.fetchResumeSession.mockResolvedValue({ session: null });
    apiMock.fetchTranscript.mockResolvedValue({
      status: "ready",
      transcriptId: "rev-A",
      segments: [{ id: "s0", transcript_id: "rev-A", segmentIndex: 0, start: 0, end: 2, duration: 2, text: "A.", textNormalized: "a" },
        { id: "s1", transcript_id: "rev-A", segmentIndex: 1, start: 2, end: 4, duration: 2, text: "B.", textNormalized: "b" }],
    });
    apiMock.saveProgress.mockRejectedValue(new Error("write_gate_paused"));
    const { result } = renderHook(() => useDictationSession({ videoId: "vid1", user: authUser }), {
      wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    });
    await waitFor(() => expect(result.current.uxState).toBe("transcript_ready"));
    await act(async () => {
      result.current.jumpToSegment(1);
    });
    await waitFor(() => expect(apiMock.saveProgress).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });
    expect(client.getQueryState(dashboardKeys.summary(authUser.id))?.isInvalidated).toBe(false);
  });
});
