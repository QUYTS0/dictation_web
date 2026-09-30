import fs from "fs";
import path from "path";
import { ListeningIntervalTracker } from "@/lib/practice/listeningTracker";
import { EngagementClock } from "@/app/dictation/[videoId]/useActivityPulse";

/** Plays from `from` to `to` at `rate`, ticking every 200 ms of wall clock. */
function play(t: ListeningIntervalTracker, from: number, to: number, rate = 1, wallStartMs = 0): number {
  let wall = wallStartMs;
  for (let pos = from; pos <= to + 1e-9; pos += 0.2 * rate) {
    t.sample(Math.min(pos, to), rate, wall);
    wall += 200;
  }
  return wall;
}

describe("ListeningIntervalTracker (plan §6.3)", () => {
  it("continuous playback becomes one interval; the open interval is cut (not lost) when taken mid-play", () => {
    const t = new ListeningIntervalTracker();
    const wall = play(t, 10, 20);
    expect(t.playedSinceTake).toBeCloseTo(10);
    expect(t.take()).toEqual([{ start: 10, end: 20 }]);
    play(t, 20.2, 25, 1, wall);
    t.stop();
    expect(t.take()).toEqual([{ start: 20, end: 25 }]);
  });

  it("a forward seek is never credited: the skipped span is a gap between two intervals", () => {
    const t = new ListeningIntervalTracker();
    const wall = play(t, 0, 5);
    play(t, 60, 65, 1, wall); // jumped 55 s in one tick
    t.stop();
    expect(t.take()).toEqual([
      { start: 0, end: 5 },
      { start: 60, end: 65 },
    ]);
  });

  it("is rate-aware: 2× playback is continuous, not a seek", () => {
    const t = new ListeningIntervalTracker();
    play(t, 0, 20, 2);
    t.stop();
    expect(t.take()).toEqual([{ start: 0, end: 20 }]);
  });

  it("a suspended tab (wall-clock gap > 5 s) starts a new interval even when the position barely moved", () => {
    const t = new ListeningIntervalTracker();
    t.sample(10, 1, 0);
    t.sample(10.2, 1, 200);
    t.sample(11, 1, 30_000); // 30 s later, only 0.8 s of media
    t.sample(11.2, 1, 30_200);
    t.stop();
    expect(t.take()).toEqual([
      { start: 10, end: 10.2 },
      { start: 11, end: 11.2 },
    ]);
  });

  it("pause/buffering/end close the interval at the furthest position reached; replays are kept (not merged)", () => {
    const t = new ListeningIntervalTracker();
    let wall = play(t, 0, 10);
    t.stop(); // paused
    wall = play(t, 0, 10, 1, wall + 5000); // replay the same span
    t.stop();
    expect(t.take()).toEqual([
      { start: 0, end: 10 },
      { start: 0, end: 10 },
    ]);
    // Ended right after a seek near the end: only what was actually played.
    t.sample(98.5, 1, wall + 1000);
    t.sample(98.7, 1, wall + 1200);
    t.stop();
    expect(t.take()).toEqual([{ start: 98.5, end: 98.7 }]);
  });

  it("checkpoint: only a playhead sampled since the last hand-over — never a default, never a stale one", () => {
    const t = new ListeningIntervalTracker();
    expect(t.takeCheckpoint()).toBeNull(); // opened, never played
    t.stop();
    expect(t.take()).toEqual([]);
    expect(t.takeCheckpoint()).toBeNull();
    const wall = play(t, 30, 34);
    expect(t.takeCheckpoint()).toBeCloseTo(34);
    expect(t.takeCheckpoint()).toBeNull(); // already reported; nothing played since
    t.stop();
    expect(t.takeCheckpoint()).toBeNull();
    play(t, 0, 1, 1, wall + 1000); // went back to the beginning and played
    expect(t.takeCheckpoint()).toBeCloseTo(1);
  });

  it("ignores invalid positions and drops sub-50 ms slivers", () => {
    const t = new ListeningIntervalTracker();
    t.sample(NaN, 1, 0);
    t.sample(-1, 1, 0);
    t.sample(5, 1, 0);
    t.sample(5.01, 1, 10);
    t.stop();
    expect(t.take()).toEqual([]);
    expect(t.lastPositionSec).toBe(5.01);
  });
});

/** Ticks every 5 s (the hook's cadence) from `from` to `to`, returning every credited span. */
function ticks(c: EngagementClock, from: number, to: number) {
  const spans = [];
  for (let t = from; t <= to; t += 5) {
    const s = c.tick(t);
    if (s) spans.push(s);
  }
  return spans;
}
const total = (spans: Array<{ start: number; end: number }>) => spans.reduce((sum, s) => sum + (s.end - s.start), 0);

describe("EngagementClock (plan §6.3b) — engaged WALL-CLOCK time", () => {
  it("no qualifying event → nothing is ever credited (an open, idle page)", () => {
    const c = new EngagementClock();
    expect(ticks(c, 1000, 1600)).toEqual([]);
  });

  it("one event credits its 15 s look-back, then time until 45 s after it — and nothing beyond that window", () => {
    const c = new EngagementClock();
    c.tick(995);
    c.interact(1000);
    const spans = ticks(c, 1005, 1300);
    expect(spans[0]).toEqual({ start: 985, end: 1005 });
    expect(spans[spans.length - 1].end).toBe(1045); // last event + PULSE_ENGAGEMENT_WINDOW_SEC
    expect(total(spans)).toBe(60); // 15 look-back + 45 window, each second once
    for (let i = 1; i < spans.length; i++) expect(spans[i].start).toBe(spans[i - 1].end); // no overlap, no gap
  });

  it("a long idle gap followed by one interaction is not bridged", () => {
    const c = new EngagementClock();
    c.interact(1000);
    ticks(c, 1005, 1100);
    expect(ticks(c, 1105, 5000)).toEqual([]); // idle for over an hour, timer still running
    c.interact(5002);
    expect(c.tick(5005)).toEqual({ start: 4987, end: 5005 }); // only the new look-back — not 1045 → 5002
  });

  it("a suspended timer cannot fill the unobserved gap: credit stops at the last observed event", () => {
    const c = new EngagementClock();
    c.interact(1000);
    c.interact(1003);
    expect(c.tick(1005)).toEqual({ start: 985, end: 1005 });
    // The machine sleeps for an hour; the timer fires late.
    expect(c.tick(4605)).toBeNull(); // not [1005, 1048]
    expect(ticks(c, 4610, 4700)).toEqual([]);
    c.interact(4702);
    expect(c.tick(4705)).toEqual({ start: 4687, end: 4705 });
  });

  it("events after the wake-up start a fresh look-back; the sleep itself is never credited", () => {
    const c = new EngagementClock();
    c.interact(1000);
    c.tick(1005);
    c.interact(4604); // first event after waking
    expect(c.tick(4605)).toEqual({ start: 4589, end: 4605 });
  });

  it("hiding the tab ends engagement at that moment; hidden time without events earns nothing", () => {
    const c = new EngagementClock();
    c.interact(1000);
    c.tick(1005);
    expect(c.suspend(1008)).toEqual({ start: 1005, end: 1008 });
    expect(ticks(c, 1010, 1100)).toEqual([]); // no 45 s tail while hidden
    // Playback that continues in the hidden tab is still qualifying activity.
    c.interact(1101);
    expect(c.tick(1105)).toEqual({ start: 1086, end: 1105 });
  });

  it.each([0.5, 1, 2])("10 s of playback at %s× is 10 s of activity (wall clock), whatever media span it covers", (rate) => {
    const clock = new EngagementClock();
    const tracker = new ListeningIntervalTracker();
    const t0 = 2000;
    const spans = [];
    for (let i = 0; i <= 50; i++) {
      const wall = t0 + i * 0.2;
      tracker.sample(100 + i * 0.2 * rate, rate, wall * 1000);
      clock.interact(wall);
      if (i > 0 && i % 25 === 0) {
        const s = clock.tick(wall);
        if (s) spans.push(s);
      }
    }
    tracker.stop();
    const media = tracker.take();
    expect(media).toHaveLength(1);
    expect(media[0].end - media[0].start).toBeCloseTo(10 * rate); // media-time coverage scales with the rate
    expect(total(spans)).toBeCloseTo(25); // 15 s look-back + exactly 10 s of wall clock — never 5 or 20
    expect(spans[spans.length - 1].end).toBeCloseTo(t0 + 10);
  });
});

describe("pulse producers (structural)", () => {
  const SRC = path.resolve(__dirname, "..");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "__tests__" && e.name !== "node_modules") walk(full);
      } else if (/\.(ts|tsx)$/.test(e.name)) files.push(full);
    }
  };
  walk(SRC);
  const rel = (f: string) => path.relative(SRC, f).split(path.sep).join("/");
  const using = (needle: RegExp) => files.filter((f) => needle.test(fs.readFileSync(f, "utf8"))).map(rel).sort();

  it("only the practice page mounts the activity pulse and the Listening tracker — Dashboard, History and every other page produce none", () => {
    expect(using(/\buseActivityPulse\(/)).toEqual(["app/dictation/[videoId]/page.tsx", "app/dictation/[videoId]/useActivityPulse.ts"]);
    expect(using(/\buseListeningCoverage\(/)).toEqual(["app/dictation/[videoId]/page.tsx", "app/dictation/[videoId]/useListeningCoverage.ts"]);
  });

  it("observations are recorded only by those two hooks; everything else may only ask for a flush", () => {
    expect(using(/practiceFlushCoordinator\.record\(/)).toEqual([
      "app/dictation/[videoId]/useActivityPulse.ts",
      "app/dictation/[videoId]/useListeningCoverage.ts",
    ]);
  });
});
