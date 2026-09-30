"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ACTIVITY, type Interval } from "@/lib/practice/listeningTypes";
import { practiceFlushCoordinator, type FlushIdentity } from "@/lib/practiceFlushCoordinator";

const TICK_MS = 5000;
/** A timer that fires this late was suspended (sleep / frozen tab): the
 *  time in between was not observed and is never credited. */
const SUSPENSION_GAP_SEC = 15;

/**
 * Pure part of the activity pulse (plan §6.3b): ENGAGED WALL-CLOCK time
 * (epoch seconds) — never media time, so 10 s of playback at 2× is 10 s.
 *
 *  - interact(t): a qualifying learning event happened at t. The first one
 *    after idle credits a PULSE_LOOKBACK_SEC look-back; an idle gap before
 *    it is never bridged.
 *  - Engagement lasts until PULSE_ENGAGEMENT_WINDOW_SEC after the last
 *    qualifying event; without new events nothing more is credited.
 *  - tick(t): the newly engaged span since the previous tick — each second
 *    is credited at most once. A tick arriving more than SUSPENSION_GAP_SEC
 *    after the previous one means the timer was suspended: engagement ends
 *    at the last observed tick; the gap is not filled in.
 *  - suspend(t): the page was hidden — credit up to t (within the window)
 *    and end engagement, so time spent hidden with no events earns nothing.
 */
export class EngagementClock {
  private lastInteraction: number | null = null;
  private engagedFrom: number | null = null;
  private creditedUntil: number | null = null;
  private lastTick: number | null = null;

  interact(nowSec: number): void {
    const idle = this.lastInteraction === null || nowSec - this.lastInteraction > ACTIVITY.PULSE_ENGAGEMENT_WINDOW_SEC;
    if (idle) this.engagedFrom = nowSec - ACTIVITY.PULSE_LOOKBACK_SEC;
    this.lastInteraction = nowSec;
  }

  tick(nowSec: number): Interval | null {
    const previousTick = this.lastTick;
    this.lastTick = nowSec;
    if (previousTick !== null && nowSec - previousTick > SUSPENSION_GAP_SEC && this.lastInteraction !== null) {
      if (nowSec - this.lastInteraction > SUSPENSION_GAP_SEC) {
        // The last event predates the suspension: engagement is only proven
        // up to that event — the engagement window is not extended into the
        // unobserved gap.
        const span = this.credit(this.lastInteraction);
        this.end();
        return span;
      }
      // Events arrived after the wake-up: a fresh look-back from the latest
      // one (credit() never goes back before what was already credited).
      this.engagedFrom = this.lastInteraction - ACTIVITY.PULSE_LOOKBACK_SEC;
    }
    return this.credit(nowSec);
  }

  suspend(nowSec: number): Interval | null {
    const span = this.credit(nowSec);
    this.end();
    this.lastTick = null;
    return span;
  }

  private end(): void {
    this.lastInteraction = null;
    this.engagedFrom = null;
  }

  private credit(nowSec: number): Interval | null {
    if (this.lastInteraction === null || this.engagedFrom === null) return null;
    const end = Math.min(nowSec, this.lastInteraction + ACTIVITY.PULSE_ENGAGEMENT_WINDOW_SEC);
    const start = Math.max(this.engagedFrom, this.creditedUntil ?? -Infinity);
    if (end - start < 0.5) return null;
    this.creditedUntil = end;
    return { start: Math.round(start * 1000) / 1000, end: Math.round(end * 1000) / 1000 };
  }
}

/**
 * Activity pulses for a signed-in user on the practice page. Nothing here
 * listens to the page in general: time is engaged only when the page
 * reports a QUALIFYING learning event through `noteInteraction` — answer
 * input, hint use, a submission, PLAYING playback ticks, recording ticks.
 * Mounting, timers, polling, fetching and cache refreshes are not events.
 *
 * One clock lives for the whole page, so a mode or round change never
 * re-credits the same wall-clock time; the identity (incl. the round) only
 * tags which batch a span goes into. Spans are handed to the flush
 * coordinator every FLUSH_INTERVAL_SEC, on tab hide, on identity change
 * and on unmount.
 */
export function useActivityPulse(opts: { userId: string | undefined; videoId: string; roundId: string | null }) {
  const { userId, videoId, roundId } = opts;
  const identity = useMemo<FlushIdentity | null>(
    () => (userId ? { userId, videoId, transcriptId: null, roundId } : null),
    [userId, videoId, roundId]
  );
  const [clock] = useState(() => new EngagementClock());
  const bufferRef = useRef<Interval[]>([]);
  const identityRef = useRef<FlushIdentity | null>(identity);

  const noteInteraction = useCallback(() => {
    if (identityRef.current) clock.interact(Date.now() / 1000);
  }, [clock]);

  useEffect(() => {
    identityRef.current = identity;
    if (!identity) return;
    const add = (span: Interval | null) => {
      if (!span) return;
      const buf = bufferRef.current;
      const last = buf[buf.length - 1];
      if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
      else buf.push(span);
    };
    const handOver = (trigger: "periodic" | "mode" | "visibility", span: Interval | null) => {
      add(span);
      const intervals = bufferRef.current;
      bufferRef.current = [];
      practiceFlushCoordinator.record("activity", identity, intervals);
      void practiceFlushCoordinator.requestFlush(trigger);
    };
    let ticks = 0;
    const timer = setInterval(() => {
      add(clock.tick(Date.now() / 1000));
      if (++ticks * TICK_MS >= ACTIVITY.FLUSH_INTERVAL_SEC * 1000) {
        ticks = 0;
        handOver("periodic", null);
      }
    }, TICK_MS);
    const onHide = () => {
      if (document.visibilityState === "hidden") handOver("visibility", clock.suspend(Date.now() / 1000));
    };
    const onPageHide = () => handOver("visibility", clock.suspend(Date.now() / 1000));
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onPageHide);
      // What was engaged so far belongs to this identity (e.g. the old round).
      handOver("mode", clock.tick(Date.now() / 1000));
      identityRef.current = null;
    };
  }, [identity, clock]);

  return { noteInteraction };
}
