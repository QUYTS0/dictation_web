import { act, fireEvent, render, renderHook } from "@testing-library/react";
import { createRef, useRef } from "react";

// Plan §5.3 / §6.3b: activity pulses come only from qualifying learning
// activity on the practice page. Fake timers (they also drive Date.now);
// the flush coordinator is mocked — nothing is sent anywhere.
const record = jest.fn();
const requestFlush = jest.fn((t?: string) => Promise.resolve(t && undefined));
jest.mock("@/lib/practiceFlushCoordinator", () => ({
  practiceFlushCoordinator: {
    record: (...a: unknown[]) => record(...a),
    requestFlush: (t: string) => requestFlush(t),
  },
}));

import { useActivityPulse } from "@/app/dictation/[videoId]/useActivityPulse";
import { usePracticeActivitySources } from "@/app/dictation/[videoId]/usePracticeActivitySources";

type Span = { start: number; end: number };
const A = { userId: "user-a", videoId: "vid", roundId: "round-1" as string | null };
const idOf = (p: typeof A) => ({ userId: p.userId, videoId: p.videoId, transcriptId: null, roundId: p.roundId });
/** Every non-empty activity hand-over: [identity, spans]. */
const credited = () =>
  record.mock.calls.filter((c) => c[0] === "activity" && (c[2] as Span[]).length > 0).map((c) => [c[1], c[2]] as [ReturnType<typeof idOf>, Span[]]);
const seconds = (spans: Span[]) => spans.reduce((s, x) => s + (x.end - x.start), 0);
const totalCredited = () => credited().reduce((s, [, spans]) => s + seconds(spans), 0);
const advance = (ms: number) => act(() => void jest.advanceTimersByTime(ms));
const setVisibility = (state: "hidden" | "visible") => {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  fireEvent(document, new Event("visibilitychange"));
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-09-30T08:00:00Z"));
});
afterEach(() => {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe("useActivityPulse", () => {
  const mount = (props = A) => renderHook((p) => useActivityPulse(p), { initialProps: props });

  it("an open practice page with no qualifying activity earns nothing — however long it stays open", () => {
    const { unmount } = mount();
    advance(10 * 60_000);
    unmount();
    expect(credited()).toEqual([]);
  });

  it("a qualifying event is credited (look-back + time engaged) and flushed periodically; credit stops 45 s after the last event", () => {
    const { result } = mount();
    advance(60_000);
    const t0 = Date.now() / 1000;
    act(() => result.current.noteInteraction());
    advance(5 * 60_000); // no further events
    const all = credited().flatMap(([, spans]) => spans);
    expect(Math.min(...all.map((s) => s.start))).toBeCloseTo(t0 - 15, 0);
    expect(Math.max(...all.map((s) => s.end))).toBeCloseTo(t0 + 45, 0);
    expect(totalCredited()).toBeCloseTo(60, 0); // 15 + 45 — not the 5 idle minutes
    expect(credited().every(([id]) => JSON.stringify(id) === JSON.stringify(idOf(A)))).toBe(true);
    expect(requestFlush).toHaveBeenCalledWith("periodic");
  });

  it("continuous events (playback/recording ticks) credit exactly the wall-clock time they span, and stop when the source stops", () => {
    const { result } = mount();
    advance(30_000);
    for (let i = 0; i < 100; i++) {
      // 20 s of ticks every 200 ms
      act(() => result.current.noteInteraction());
      advance(200);
    }
    advance(3 * 60_000); // the source stopped
    expect(totalCredited()).toBeCloseTo(15 + 20 + 45, 0); // look-back + 20 s + the engagement window; nothing after
  });

  it("a round change (Restart) or mode switch never re-credits the same wall-clock time", () => {
    const { result, rerender } = mount();
    act(() => result.current.noteInteraction());
    advance(10_000);
    act(() => result.current.noteInteraction());
    rerender({ ...A, roundId: "round-2" });
    act(() => result.current.noteInteraction());
    advance(20_000);
    act(() => result.current.noteInteraction());
    advance(60_000);
    const byRound = (r: string) => credited().filter(([id]) => id.roundId === r).flatMap(([, s]) => s);
    const first = byRound("round-1");
    const second = byRound("round-2");
    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBeGreaterThan(0);
    // The spans of the two rounds do not overlap, and the look-back is credited once.
    expect(Math.min(...second.map((s) => s.start))).toBeGreaterThanOrEqual(Math.max(...first.map((s) => s.end)));
    expect(totalCredited()).toBeCloseTo(15 + 30 + 45, 0);
  });

  it("hiding the tab hands over and ends engagement: hidden time with no events earns nothing", () => {
    const { result } = mount();
    act(() => result.current.noteInteraction());
    advance(7_000);
    act(() => setVisibility("hidden"));
    expect(requestFlush).toHaveBeenLastCalledWith("visibility");
    const atHide = totalCredited();
    expect(atHide).toBeCloseTo(15 + 7, 0);
    advance(5 * 60_000); // hidden, idle
    expect(totalCredited()).toBeCloseTo(atHide, 5);
    act(() => setVisibility("visible"));
    advance(60_000); // visible again but still no qualifying event
    expect(totalCredited()).toBeCloseTo(atHide, 5);
  });

  it("unmount hands over what was engaged and leaves no timer behind; a guest records nothing", () => {
    const { result, unmount } = mount();
    act(() => result.current.noteInteraction());
    advance(4_000);
    unmount();
    expect(totalCredited()).toBeCloseTo(15 + 4, 0);
    expect(jest.getTimerCount()).toBe(0);

    record.mockClear();
    const guest = renderHook(() => useActivityPulse({ userId: undefined, videoId: "vid", roundId: null }));
    act(() => guest.result.current.noteInteraction());
    advance(60_000);
    guest.unmount();
    expect(record).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe("usePracticeActivitySources — what counts as a qualifying event", () => {
  function Harness(props: { note: () => void; showHintPanel: boolean; hintLevel: number; isRecording: boolean }) {
    const answerRef = useRef<HTMLInputElement>(null);
    usePracticeActivitySources({ noteInteraction: props.note, answerInputRef: answerRef, showHintPanel: props.showHintPanel, hintLevel: props.hintLevel, isRecording: props.isRecording });
    return (
      <>
        <input aria-label="answer" ref={answerRef} />
        <input aria-label="note" />
        <button>Settings</button>
      </>
    );
  }
  const base = { showHintPanel: false, hintLevel: 0, isRecording: false };

  it("mounting, re-rendering and time passing report nothing", () => {
    const note = jest.fn();
    const view = render(<Harness note={note} {...base} />);
    view.rerender(<Harness note={note} {...base} />);
    advance(120_000);
    expect(note).not.toHaveBeenCalled();
  });

  it("Dictation: typing in the answer field counts; keys and clicks elsewhere on the page don't", () => {
    const note = jest.fn();
    const view = render(<Harness note={note} {...base} />);
    fireEvent.keyDown(view.getByLabelText("answer"), { key: "a" });
    fireEvent.input(view.getByLabelText("answer"), { target: { value: "a" } });
    expect(note).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(view.getByLabelText("note"), { key: "x" });
    fireEvent.input(view.getByLabelText("note"), { target: { value: "x" } });
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    fireEvent.click(view.getByText("Settings"));
    fireEvent.pointerDown(view.getByText("Settings"));
    expect(note).toHaveBeenCalledTimes(2);
  });

  it("hint use: opening the panel and changing its level count; the page closing/resetting it doesn't", () => {
    const note = jest.fn();
    const view = render(<Harness note={note} {...base} />);
    view.rerender(<Harness note={note} {...base} showHintPanel />);
    expect(note).toHaveBeenCalledTimes(1);
    view.rerender(<Harness note={note} {...base} showHintPanel hintLevel={2} />);
    expect(note).toHaveBeenCalledTimes(2);
    view.rerender(<Harness note={note} {...base} hintLevel={2} />); // closed on sentence change
    view.rerender(<Harness note={note} {...base} hintLevel={0} />); // level reset while closed
    expect(note).toHaveBeenCalledTimes(2);
  });

  it("Shadowing: one tick a second while a recording runs — and none after it stops or is cancelled", () => {
    const note = jest.fn();
    const view = render(<Harness note={note} {...base} isRecording />);
    expect(note).toHaveBeenCalledTimes(1);
    advance(3_000);
    expect(note).toHaveBeenCalledTimes(4);
    view.rerender(<Harness note={note} {...base} />); // stopped / cancelled
    advance(30_000);
    expect(note).toHaveBeenCalledTimes(4);
    view.unmount();
    expect(jest.getTimerCount()).toBe(0);
  });

  it("keeps working when the answer field isn't mounted (Listening/Shadowing)", () => {
    const note = jest.fn();
    const ref = createRef<HTMLInputElement>();
    renderHook(() => usePracticeActivitySources({ noteInteraction: note, answerInputRef: ref, ...base }));
    fireEvent.keyDown(document.body, { key: "a" });
    expect(note).not.toHaveBeenCalled();
  });
});
