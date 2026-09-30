import { LISTENING, type Interval } from "./listeningTypes";

/**
 * Turns the player's PLAYING-state position ticks into raw media-timeline
 * intervals that were genuinely played (plan §6.3). Pure — no timers, no
 * network; the caller feeds it samples and state changes.
 *
 * Rules:
 *  - only samples while PLAYING are fed in; pause / buffering / end / mode
 *    switch call stop(), which closes the open interval at the furthest
 *    position actually reached — a later sample opens a fresh one;
 *  - rate-aware continuity: expected = lastPos + wallElapsed × rate; a
 *    deviation beyond SEEK_DETECTION_TOLERANCE_SEC is a seek — the skipped
 *    span is never credited; a new interval starts at the new position;
 *  - a wall-clock gap beyond MAX_TICK_GAP_SEC (suspended/throttled tab) also
 *    starts a new interval, however small the position change looks;
 *  - intervals are NOT merged here: replays are sent as observed, so the
 *    server can count replay-inclusive listening time; it merges coverage.
 */
export class ListeningIntervalTracker {
  private open: { start: number; maxPos: number; lastPos: number; lastWallMs: number; rate: number } | null = null;
  private closed: Interval[] = [];
  private played = 0;
  private lastPosition: number | null = null;
  private sampledSinceCheckpoint = false;

  /** One PLAYING tick. `wallMs` = a monotonic clock (performance.now()). */
  sample(positionSec: number, rate: number, wallMs: number): void {
    if (!Number.isFinite(positionSec) || positionSec < 0) return;
    const r = Number.isFinite(rate) && rate > 0 ? rate : 1;
    this.lastPosition = positionSec;
    this.sampledSinceCheckpoint = true;
    const o = this.open;
    if (!o) {
      this.open = { start: positionSec, maxPos: positionSec, lastPos: positionSec, lastWallMs: wallMs, rate: r };
      return;
    }
    const elapsedSec = (wallMs - o.lastWallMs) / 1000;
    const expected = o.lastPos + Math.max(0, elapsedSec) * o.rate;
    if (elapsedSec > LISTENING.MAX_TICK_GAP_SEC || elapsedSec < 0 || Math.abs(positionSec - expected) > LISTENING.SEEK_DETECTION_TOLERANCE_SEC) {
      this.closeOpen();
      this.open = { start: positionSec, maxPos: positionSec, lastPos: positionSec, lastWallMs: wallMs, rate: r };
      return;
    }
    if (positionSec > o.maxPos) {
      this.played += positionSec - o.maxPos;
      o.maxPos = positionSec;
    }
    o.lastPos = positionSec;
    o.lastWallMs = wallMs;
    o.rate = r;
  }

  /** Pause / buffering / ended / mode switch / page hide. */
  stop(): void {
    this.closeOpen();
  }

  /** Media seconds genuinely played since the last take() — drives the periodic flush. */
  get playedSinceTake(): number {
    return this.played;
  }

  /** The last observed playhead (resume convenience only). */
  get lastPositionSec(): number | null {
    return this.lastPosition;
  }

  /**
   * The checkpoint to persist: the last playhead actually observed while
   * PLAYING since the previous call — null when nothing was played since
   * then. Opening/re-entering Listening and leaving without playing
   * therefore never (re)sends a position: not the player's default 0, and
   * not a stale one from an earlier hand-over.
   */
  takeCheckpoint(): number | null {
    if (!this.sampledSinceCheckpoint) return null;
    this.sampledSinceCheckpoint = false;
    return this.lastPosition;
  }

  /** Every interval observed so far — closed ones plus the open one cut at
   *  its furthest point (it keeps running from there). Clears them. */
  take(): Interval[] {
    const o = this.open;
    if (o && o.maxPos > o.start) {
      this.push(o.start, o.maxPos);
      o.start = o.maxPos;
    }
    const out = this.closed;
    this.closed = [];
    this.played = 0;
    return out;
  }

  private closeOpen(): void {
    const o = this.open;
    this.open = null;
    if (o) this.push(o.start, o.maxPos);
  }

  private push(start: number, end: number): void {
    const s = Math.round(start * 1000) / 1000;
    const e = Math.round(end * 1000) / 1000;
    if (e - s >= 0.05) this.closed.push({ start: s, end: e });
  }
}
