import { act, fireEvent, render, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

// Plan §11.6 / §6.3: who hands buffered Listening data to the flush
// coordinator, and when — the root navigation observer, the Listening hook
// (pause, periodic, tab hide, mode/identity change, unmount) and sign-out.
const record = jest.fn();
const requestFlush = jest.fn((trigger?: string) => Promise.resolve(trigger && undefined));
const flushWithin = jest.fn(async () => {});
const setAuthUser = jest.fn();
jest.mock("@/lib/practiceFlushCoordinator", () => ({
  practiceFlushCoordinator: {
    record: (...a: unknown[]) => record(...a),
    requestFlush: (t: string) => requestFlush(t),
    flushWithin: (...a: unknown[]) => flushWithin(...(a as [])),
    setAuthUser: (u: string | null) => setAuthUser(u),
    setQueryClient: () => {},
  },
}));

let pathname = "/dictation/vid";
jest.mock("next/navigation", () => ({ usePathname: () => pathname }));

const signOutMock = jest.fn(async () => ({ error: null }));
jest.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: "user-a" } } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      signOut: signOutMock,
    },
  }),
}));
jest.mock("@/components/AuthModal", () => function AuthModal() {
  return null;
});

import { NavigationFlushObserver } from "@/components/NavigationFlushObserver";
import { useListeningCoverage } from "@/app/dictation/[videoId]/useListeningCoverage";
import { AuthProvider, useAuth } from "@/context/auth";

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
);

let nowMs = 0;
beforeEach(() => {
  jest.clearAllMocks();
  nowMs = 0;
  jest.spyOn(performance, "now").mockImplementation(() => nowMs);
  global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ coverageRatio: 0, hasHistory: false }) })) as unknown as typeof fetch;
});
afterEach(() => jest.restoreAllMocks());

/** Plays `seconds` of media from `from` at 1× through the hook. */
function play(onSample: (p: number, r: number) => void, from: number, seconds: number) {
  for (let t = 0; t <= seconds * 5; t++) {
    act(() => onSample(from + t * 0.2, 1));
    nowMs += 200;
  }
}

describe("NavigationFlushObserver", () => {
  it("flushes on every route change (not on first mount) and on tab hide (#52, #76)", () => {
    const view = render(<NavigationFlushObserver />);
    expect(requestFlush).not.toHaveBeenCalled();
    pathname = "/dashboard";
    view.rerender(<NavigationFlushObserver />);
    expect(requestFlush).toHaveBeenCalledWith("navigation");
    pathname = "/dictation/vid"; // Back
    view.rerender(<NavigationFlushObserver />);
    expect(requestFlush).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    fireEvent(document, new Event("visibilitychange"));
    expect(requestFlush).toHaveBeenLastCalledWith("visibility");
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  });
});

describe("useListeningCoverage", () => {
  const A = { userId: "user-a", videoId: "vid", transcriptId: "tr-1", roundId: "round-1" as string | null };
  const mount = (props: { enabled: boolean; userId: string | undefined; videoId: string; transcriptId: string | null; roundId: string | null }) =>
    renderHook((p) => useListeningCoverage(p), { initialProps: props, wrapper });
  /** Hand-overs that carried something the coordinator would send. */
  const meaningful = () => record.mock.calls.filter((c) => (c[2] as unknown[]).length > 0 || c[3] !== null);

  it("hands over every 15 s of playback and on pause, under the identity it was observed with", () => {
    const { result } = mount({ enabled: true, ...A });
    play(result.current.onPlaybackSample, 0, 16);
    expect(record).toHaveBeenCalledWith("listening", A, [{ start: 0, end: 15 }], 15);
    expect(requestFlush).toHaveBeenLastCalledWith("periodic");
    act(() => result.current.onPlaybackStateChange("paused"));
    expect(record).toHaveBeenLastCalledWith("listening", A, [{ start: 15, end: 16 }], 16);
    expect(requestFlush).toHaveBeenLastCalledWith("pause");
  });

  it("buffering/end close the interval; a seek across the gap is never credited", () => {
    const { result } = mount({ enabled: true, ...A });
    play(result.current.onPlaybackSample, 0, 3);
    play(result.current.onPlaybackSample, 40, 2); // seek
    act(() => result.current.onPlaybackStateChange("buffering"));
    expect(record).toHaveBeenLastCalledWith("listening", A, [{ start: 0, end: 3 }, { start: 40, end: 42 }], 42);
  });

  it("leaving Listening mode, switching revision/account and unmounting hand over the old identity's data", () => {
    const { result, rerender, unmount } = mount({ enabled: true, ...A });
    play(result.current.onPlaybackSample, 0, 4);
    rerender({ enabled: true, ...A, transcriptId: "tr-2" }); // regenerated script
    expect(record).toHaveBeenLastCalledWith("listening", A, [{ start: 0, end: 4 }], 4);
    expect(requestFlush).toHaveBeenLastCalledWith("mode");
    play(result.current.onPlaybackSample, 10, 2);
    rerender({ enabled: false, ...A, transcriptId: "tr-2" }); // switched to Dictation
    expect(record).toHaveBeenLastCalledWith("listening", { ...A, transcriptId: "tr-2" }, [{ start: 10, end: 12 }], 12);
    record.mockClear();
    play(result.current.onPlaybackSample, 20, 2); // Dictation playback: not Listening coverage
    unmount();
    expect(record).not.toHaveBeenCalledWith("listening", expect.anything(), expect.arrayContaining([expect.objectContaining({ start: 20 })]), expect.anything());
  });

  it("tab hide hands over immediately (keepalive flush)", () => {
    const { result } = mount({ enabled: true, ...A });
    play(result.current.onPlaybackSample, 0, 5);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    fireEvent(document, new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    expect(record).toHaveBeenLastCalledWith("listening", A, [{ start: 0, end: 5 }], 5);
    expect(requestFlush).toHaveBeenLastCalledWith("visibility");
  });

  it("a Restart (round change) hands the old round's observations over under the OLD round", () => {
    const { result, rerender } = mount({ enabled: true, ...A });
    play(result.current.onPlaybackSample, 0, 6);
    rerender({ enabled: true, ...A, roundId: "round-2" }); // Restart created round 2
    expect(record).toHaveBeenLastCalledWith("listening", A, [{ start: 0, end: 6 }], 6);
    expect(requestFlush).toHaveBeenLastCalledWith("mode");
    play(result.current.onPlaybackSample, 6.2, 3);
    act(() => result.current.onPlaybackStateChange("paused"));
    expect(record).toHaveBeenLastCalledWith("listening", { ...A, roundId: "round-2" }, [{ start: 6.2, end: 9.2 }], 9.2);
  });

  it("opening Listening and leaving without playing sends no checkpoint (never the player's default 0)", () => {
    const { result, rerender, unmount } = mount({ enabled: true, ...A });
    act(() => result.current.onPlaybackStateChange("paused")); // state noise without playback
    rerender({ enabled: false, ...A });
    rerender({ enabled: true, ...A });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    fireEvent(document, new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    unmount();
    expect(meaningful()).toEqual([]);
  });

  it("a checkpoint is reported once: re-entering and leaving without playing does not resend a stale one", () => {
    const { result, rerender, unmount } = mount({ enabled: true, ...A });
    play(result.current.onPlaybackSample, 30, 4);
    rerender({ enabled: false, ...A }); // to Dictation: hands over [30,34] with checkpoint 34
    expect(record).toHaveBeenLastCalledWith("listening", A, [{ start: 30, end: 34 }], 34);
    record.mockClear();
    rerender({ enabled: true, ...A, transcriptId: "tr-2" }); // back to Listening on another revision, no playback
    unmount();
    expect(meaningful()).toEqual([]); // revision 2 never receives revision 1's position
  });

  it("a real return to the beginning IS a checkpoint (distinguishable from 'never played')", () => {
    const { result } = mount({ enabled: true, ...A });
    play(result.current.onPlaybackSample, 40, 2);
    play(result.current.onPlaybackSample, 0, 1); // the user went back to the start and played
    act(() => result.current.onPlaybackStateChange("paused"));
    expect(record).toHaveBeenLastCalledWith("listening", A, [{ start: 40, end: 42 }, { start: 0, end: 1 }], 1);
  });

  it("a guest records nothing", () => {
    const { result, unmount } = mount({ enabled: true, userId: undefined, videoId: "vid", transcriptId: "tr-1", roundId: null });
    play(result.current.onPlaybackSample, 0, 20);
    act(() => result.current.onPlaybackStateChange("paused"));
    unmount();
    expect(record).not.toHaveBeenCalled();
  });
});

describe("sign-out", () => {
  function Probe() {
    const { user, signOut } = useAuth();
    return (
      <>
        <span>{user?.id ?? "none"}</span>
        <button onClick={() => void signOut()}>sign out</button>
      </>
    );
  }

  it("flushes this account's data (bounded) before signing out, then detaches the account (#77)", async () => {
    const order: string[] = [];
    flushWithin.mockImplementation(async () => void order.push("flush"));
    setAuthUser.mockImplementation((u: string | null) => void order.push(`auth:${u}`));
    signOutMock.mockImplementation(async () => (order.push("supabase.signOut"), { error: null }));
    const view = render(
      <QueryClientProvider client={new QueryClient()}>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </QueryClientProvider>
    );
    await view.findByText("user-a");
    await waitFor(() => expect(order).toContain("auth:user-a"));
    await act(async () => {
      fireEvent.click(view.getByText("sign out"));
    });
    expect(flushWithin).toHaveBeenCalledWith("signout", 2500);
    const i = order.indexOf("flush");
    // (the auth effect repeats auth:null afterwards — idempotent)
    expect(order.slice(i, i + 3)).toEqual(["flush", "auth:null", "supabase.signOut"]);
  });
});
