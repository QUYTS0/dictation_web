export {};

// In-memory fake Upstash Redis — implements just what lock.ts uses (set
// with nx/px, eval), mirroring rateLimit.test.ts's Map-backed fake pattern.
class FakeRedis {
  store = new Map<string, { value: unknown; expiresAt: number }>();

  private isLive(key: string) {
    const entry = this.store.get(key);
    if (!entry) return false;
    if (entry.expiresAt !== Infinity && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return false;
    }
    return true;
  }

  async set(key: string, value: unknown, opts?: { nx?: boolean; px?: number }) {
    if (opts?.nx && this.isLive(key)) return null;
    this.store.set(key, { value, expiresAt: opts?.px ? Date.now() + opts.px : Infinity });
    return "OK";
  }

  async get<T>(key: string): Promise<T | null> {
    return this.isLive(key) ? (this.store.get(key)!.value as T) : null;
  }

  async del(key: string) {
    return this.store.delete(key) ? 1 : 0;
  }

  async eval(_script: string, keys: string[], args: unknown[]) {
    const key = keys[0];
    const expected = args[0];
    if (this.isLive(key) && this.store.get(key)!.value === expected) {
      this.store.delete(key);
      return 1;
    }
    return 0;
  }
}

let fakeRedisInstance: FakeRedis;
jest.mock("@upstash/redis", () => ({
  Redis: class {
    constructor() {
      return fakeRedisInstance;
    }
  },
}));

describe("acquireTranscriptLock", () => {
  beforeEach(() => {
    jest.resetModules();
    fakeRedisInstance = new FakeRedis();
    process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";
  });

  afterEach(() => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });

  it("26. two concurrent acquire attempts for the same key produce only one winner", async () => {
    const { acquireTranscriptLock } = await import("@/lib/youtubeCaptions/lock");
    const [a, b] = await Promise.all([
      acquireTranscriptLock("vid1", "en"),
      acquireTranscriptLock("vid1", "en"),
    ]);
    const winners = [a, b].filter(Boolean);
    expect(winners).toHaveLength(1);
  });

  it("27. the lock expires via TTL so a crashed holder can't deadlock forever", async () => {
    const { acquireTranscriptLock } = await import("@/lib/youtubeCaptions/lock");
    const first = await acquireTranscriptLock("vid2", "en", 10);
    expect(first).not.toBeNull();

    // Not released — simulate a crash. A short TTL means it should still
    // become acquirable again shortly after.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await acquireTranscriptLock("vid2", "en", 10);
    expect(second).not.toBeNull();
  });

  it("28. only the owner can release the lock — a stale token never deletes someone else's lock", async () => {
    const { acquireTranscriptLock } = await import("@/lib/youtubeCaptions/lock");
    const first = await acquireTranscriptLock("vid3", "en", 5);
    expect(first).not.toBeNull();
    // Let it expire, then someone else acquires it.
    await new Promise((resolve) => setTimeout(resolve, 15));
    const second = await acquireTranscriptLock("vid3", "en", 30_000);
    expect(second).not.toBeNull();

    // The first (stale) owner tries to release — must not remove the
    // second owner's still-live lock.
    await first!.release();
    const third = await acquireTranscriptLock("vid3", "en", 30_000);
    expect(third).toBeNull(); // still held by `second`
  });

  it("29. a contended lock signals the caller with a bounded retry hint (no throw)", async () => {
    const { acquireTranscriptLock } = await import("@/lib/youtubeCaptions/lock");
    const first = await acquireTranscriptLock("vid4", "en", 30_000);
    expect(first).not.toBeNull();
    const second = await acquireTranscriptLock("vid4", "en", 30_000);
    expect(second).toBeNull();
  });

  it("33. falls back to a best-effort in-memory lock when Redis is unavailable", async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    const { acquireTranscriptLock } = await import("@/lib/youtubeCaptions/lock");
    const first = await acquireTranscriptLock("vid5", "en", 30_000);
    const second = await acquireTranscriptLock("vid5", "en", 30_000);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    await first!.release();
    const third = await acquireTranscriptLock("vid5", "en", 30_000);
    expect(third).not.toBeNull();
  });

  it("release is idempotent and safe to call twice", async () => {
    const { acquireTranscriptLock } = await import("@/lib/youtubeCaptions/lock");
    const lock = await acquireTranscriptLock("vid6", "en", 30_000);
    await lock!.release();
    await expect(lock!.release()).resolves.toBeUndefined();
  });
});
