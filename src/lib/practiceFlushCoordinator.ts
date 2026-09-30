import type { QueryClient } from "@tanstack/react-query";
import { dashboardKeys } from "@/lib/queries/dashboard";
import { listeningProgressKeys } from "@/lib/queries/listeningProgress";
import { LISTENING, type Interval, type ListeningProgressResponse, type ListeningSyncResponse } from "@/lib/practice/listeningTypes";

/**
 * Module-level flush coordinator (plan §11.6). Owns buffered and unsent
 * Listening/activity data independently of any component, so leaving the
 * practice page (unmount, route change, tab hide) never discards it.
 *
 * What is fixed, and when:
 *  - IDENTITY (user, video, revision, round) — when an observation is
 *    recorded. Observations with different identities never share a batch;
 *    nothing is re-derived later from "whatever is current".
 *  - PAYLOAD + flushBatchId — when a buffer is sealed (requestFlush). A
 *    sealed batch is immutable: later observations go to a new buffer and a
 *    new batch. Every attempt of a batch sends the same id and payload.
 *  - STUDY SESSION — by the database, from the batch id (a replay) or the
 *    observed round (fn_sync_study_activity, 039). The client never picks
 *    a session, so a retry can never land in a different one.
 *
 *  - A retryable failure (network, 5xx, 408, 429) keeps the batch for the
 *    next trigger; a 4xx refusal drops it.
 *  - A batch is sent only while its own user is the signed-in user — a
 *    different account's cookie must never be credited with it — and is
 *    dropped when that user signs out.
 *  - A trigger that arrives while a send is in flight waits for it (instead
 *    of concluding "nothing to do") and then sends whatever is left.
 *  - Navigation / visibility / sign-out flushes invalidate the Dashboard only
 *    AFTER the write succeeded; the Listening progress query is patched from
 *    each sync response (any in-flight read of it is cancelled first, so an
 *    older read can't overwrite the patch).
 *  - The unsent QUEUE is bounded to MAX_PENDING_BUFFER_SEC of Listening
 *    media time: when more accumulates (sustained failure), the oldest
 *    batches are dropped. This bounds memory, not total loss — while the
 *    failure lasts, everything beyond the newest 300 s is lost.
 */

export interface FlushIdentity {
  userId: string;
  videoId: string;
  /** Listening only; null for activity or a video without a transcript. */
  transcriptId: string | null;
  /** The practice round the page was on when this was observed (null = none). */
  roundId: string | null;
}

export type FlushKind = "listening" | "activity";
export type FlushTrigger = "periodic" | "pause" | "mode" | "unmount" | "navigation" | "visibility" | "signout";

interface Batch {
  id: string;
  kind: FlushKind;
  identity: FlushIdentity;
  intervals: Interval[];
  currentPositionSec: number | null;
  clientTimezone: string | null;
  /** Client clock (ms) of the newest observation in the batch. */
  observedAtMs: number;
}

interface Buffer {
  kind: FlushKind;
  identity: FlushIdentity;
  intervals: Interval[];
  currentPositionSec: number | null;
  observedAtMs: number;
}

type Outcome = "ok" | "drop" | "retry";
type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const MAX_ACTIVITY_BATCHES = 30;
const ENDPOINT: Record<FlushKind, string> = { listening: "/api/listening/sync", activity: "/api/study-session/activity" };
const INVALIDATING: ReadonlySet<FlushTrigger> = new Set(["navigation", "visibility", "signout"]);
const KEEPALIVE: ReadonlySet<FlushTrigger> = new Set(["navigation", "visibility", "signout"]);

function newId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function clientTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone?.slice(0, 64) ?? null;
  } catch {
    return null;
  }
}

const bufferKey = (kind: FlushKind, id: FlushIdentity) =>
  `${kind}|${id.userId}|${id.videoId}|${id.transcriptId ?? ""}|${id.roundId ?? ""}`;
const mediaSeconds = (b: Batch) => b.intervals.reduce((s, i) => s + (i.end - i.start), 0);

export class PracticeFlushCoordinator {
  private authUserId: string | null = null;
  private buffers = new Map<string, Buffer>();
  private pending: Batch[] = [];
  private chain: Promise<Set<string>> | null = null;
  private queryClient: QueryClient | null = null;

  constructor(
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
    private readonly nowMs: () => number = () => Date.now()
  ) {}

  setQueryClient(queryClient: QueryClient | null): void {
    this.queryClient = queryClient;
  }

  /** The signed-in account. Anything recorded for another account is dropped. */
  setAuthUser(userId: string | null): void {
    if (userId === this.authUserId) return;
    this.authUserId = userId;
    for (const [k, b] of this.buffers) if (b.identity.userId !== userId) this.buffers.delete(k);
    this.pending = this.pending.filter((b) => b.identity.userId === userId);
  }

  /**
   * Buffers observations under the identity they were observed with.
   * `currentPositionSec` (Listening) is the checkpoint observed with them —
   * null when nothing was played, which never produces a request.
   */
  record(kind: FlushKind, identity: FlushIdentity, intervals: Interval[], currentPositionSec: number | null = null): void {
    if (!this.authUserId || identity.userId !== this.authUserId) return;
    if (intervals.length === 0 && (kind === "activity" || currentPositionSec === null)) return;
    const key = bufferKey(kind, identity);
    const buf = this.buffers.get(key) ?? { kind, identity: { ...identity }, intervals: [], currentPositionSec: null, observedAtMs: 0 };
    buf.intervals.push(...intervals);
    if (currentPositionSec !== null) buf.currentPositionSec = currentPositionSec;
    buf.observedAtMs = this.nowMs();
    this.buffers.set(key, buf);
  }

  /** Buffered + unsent batches (for tests / diagnostics). */
  get pendingBatchCount(): number {
    return this.pending.length + this.buffers.size;
  }

  /**
   * Seals what is buffered and sends everything unsent. Resolves when this
   * flush (including any send already in flight) has finished; never rejects.
   */
  requestFlush(trigger: FlushTrigger): Promise<void> {
    this.seal();
    const prior = this.chain;
    const keepalive = KEEPALIVE.has(trigger);
    const run = (async () => {
      const succeeded = new Set<string>();
      if (prior) for (const u of await prior) succeeded.add(u);
      for (const u of await this.drain(keepalive)) succeeded.add(u);
      return succeeded;
    })();
    this.chain = run;
    return run.then(
      (succeeded) => {
        if (this.chain === run) this.chain = null;
        if (INVALIDATING.has(trigger)) for (const u of succeeded) this.invalidateDashboard(u);
      },
      () => {
        if (this.chain === run) this.chain = null;
      }
    );
  }

  /** Flush with an upper bound on waiting (sign-out must not hang). */
  async flushWithin(trigger: FlushTrigger, timeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.requestFlush(trigger),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  /** Test helper. */
  reset(): void {
    this.authUserId = null;
    this.buffers.clear();
    this.pending = [];
    this.chain = null;
  }

  private seal(): void {
    for (const buf of this.buffers.values()) {
      this.pending.push({
        id: newId(),
        kind: buf.kind,
        identity: buf.identity,
        intervals: buf.intervals,
        currentPositionSec: buf.currentPositionSec,
        clientTimezone: clientTimezone(),
        observedAtMs: buf.observedAtMs,
      });
    }
    this.buffers.clear();
    this.enforceBounds();
  }

  private enforceBounds(): void {
    let listeningSec = 0;
    let activityBatches = 0;
    const keep: Batch[] = [];
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const b = this.pending[i];
      if (b.kind === "listening") {
        listeningSec += mediaSeconds(b);
        if (listeningSec > LISTENING.MAX_PENDING_BUFFER_SEC && keep.some((k) => k.kind === "listening")) {
          console.warn("[flush] dropping unsent listening data beyond the pending bound");
          continue;
        }
      } else if (++activityBatches > MAX_ACTIVITY_BATCHES) {
        continue;
      }
      keep.unshift(b);
    }
    this.pending = keep;
  }

  private async drain(keepalive: boolean): Promise<Set<string>> {
    const succeeded = new Set<string>();
    while (this.pending.length > 0) {
      const batch = this.pending[0];
      if (batch.identity.userId !== this.authUserId) {
        this.pending.shift();
        continue;
      }
      const outcome = await this.send(batch, keepalive);
      if (outcome === "retry") break;
      this.pending = this.pending.filter((b) => b !== batch);
      if (outcome === "ok") succeeded.add(batch.identity.userId);
    }
    return succeeded;
  }

  private async send(batch: Batch, keepalive: boolean): Promise<Outcome> {
    // Identical on every attempt except observedAgeSec — a client-side time
    // DIFFERENCE (skew-free) that is not part of the batch's fingerprint.
    const body = {
      videoId: batch.identity.videoId,
      flushBatchId: batch.id,
      intervals: batch.intervals,
      roundId: batch.identity.roundId,
      clientTimezone: batch.clientTimezone,
      observedAgeSec: Math.max(0, Math.round((this.nowMs() - batch.observedAtMs) / 1000)),
      ...(batch.kind === "listening" ? { transcriptId: batch.identity.transcriptId, currentPositionSec: batch.currentPositionSec } : {}),
    };
    let res: Response;
    try {
      res = await this.fetchImpl(ENDPOINT[batch.kind], {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        keepalive,
      });
    } catch {
      return "retry";
    }
    if (!res.ok) {
      if (res.status >= 500 || res.status === 408 || res.status === 429) return "retry";
      console.warn(`[flush] ${batch.kind} batch refused (${res.status}); dropped`);
      return "drop";
    }
    let data: ListeningSyncResponse | null = null;
    try {
      data = (await res.json()) as ListeningSyncResponse;
    } catch {
      data = null;
    }
    if (batch.kind === "listening" && data && batch.identity.userId === this.authUserId) this.applyListening(batch.identity, data);
    return "ok";
  }

  private applyListening(identity: FlushIdentity, data: ListeningSyncResponse): void {
    const qc = this.queryClient;
    if (!qc || typeof data.coverageRatio !== "number") return;
    const key = listeningProgressKeys.progress(identity.userId, identity.videoId, identity.transcriptId);
    // A read that started before this write committed must not land after
    // (and over) the patch below.
    void qc.cancelQueries({ queryKey: key });
    const prev = qc.getQueryData<ListeningProgressResponse>(key);
    const listenedThrough = !!data.listenedThrough;
    qc.setQueryData<ListeningProgressResponse>(key, {
      videoId: identity.videoId,
      transcriptId: identity.transcriptId,
      coveredSec: Number(data.coveredSec ?? 0),
      transcriptCoveredSec: data.transcriptCoveredSec != null ? Number(data.transcriptCoveredSec) : (prev?.transcriptCoveredSec ?? null),
      coverageRatio: Number(data.coverageRatio),
      listenedThrough,
      listenedThroughAt: prev?.listenedThroughAt ?? (listenedThrough ? new Date().toISOString() : null),
      // The server reports the checkpoint it actually has stored.
      lastPositionSec: Number(data.lastPositionSec ?? prev?.lastPositionSec ?? 0),
      hasHistory: data.hasHistory ?? true,
    });
    if (listenedThrough && !prev?.listenedThrough) this.invalidateDashboard(identity.userId);
  }

  private invalidateDashboard(userId: string): void {
    if (!this.queryClient || userId !== this.authUserId) return;
    void this.queryClient.invalidateQueries({ queryKey: dashboardKeys.summary(userId) });
  }
}

/** The app's single coordinator (same lifetime as the app's QueryClient). */
export const practiceFlushCoordinator = new PracticeFlushCoordinator();
