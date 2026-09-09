export {};

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

  async set(key: string, value: unknown, opts?: { px?: number }) {
    this.store.set(key, { value, expiresAt: opts?.px ? Date.now() + opts.px : Infinity });
    return "OK";
  }

  async get<T>(key: string): Promise<T | null> {
    return this.isLive(key) ? (this.store.get(key)!.value as T) : null;
  }

  async del(key: string) {
    return this.store.delete(key) ? 1 : 0;
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

describe("transcript cooldown", () => {
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

  it("30. an eligible failure code sets a cooldown that a subsequent check observes as active", async () => {
    const { setCooldown, getCooldown, resolveCooldownStatus } = await import("@/lib/youtubeCaptions/cooldown");
    await setCooldown("vid1", "en", "YOUTUBE_BOT_BLOCKED");
    const state = await getCooldown("vid1", "en");
    const status = resolveCooldownStatus(state);
    expect(status.active).toBe(true);
    expect(status.previousErrorCode).toBe("YOUTUBE_BOT_BLOCKED");
    expect(status.retryAfterMs).toBeGreaterThan(0);
  });

  it("a non-cooldown-eligible code (e.g. a per-provider parser error) never sets a cooldown", async () => {
    const { setCooldown, getCooldown } = await import("@/lib/youtubeCaptions/cooldown");
    await setCooldown("vid2", "en", "PARSER_ERROR");
    const state = await getCooldown("vid2", "en");
    expect(state).toBeNull();
  });

  it("a Retry-After hint overrides the default cooldown duration", async () => {
    const { setCooldown, getCooldown, resolveCooldownStatus } = await import("@/lib/youtubeCaptions/cooldown");
    await setCooldown("vid3", "en", "YOUTUBE_RATE_LIMITED", 2_000);
    const status = resolveCooldownStatus(await getCooldown("vid3", "en"));
    expect(status.active).toBe(true);
    expect(status.retryAfterMs).toBeLessThanOrEqual(2_000);
  });

  it("32. a successful generation clears any existing cooldown", async () => {
    const { setCooldown, clearCooldown, getCooldown } = await import("@/lib/youtubeCaptions/cooldown");
    await setCooldown("vid4", "en", "CAPTIONS_DISABLED");
    expect(await getCooldown("vid4", "en")).not.toBeNull();
    await clearCooldown("vid4", "en");
    expect(await getCooldown("vid4", "en")).toBeNull();
  });

  it("33. Redis being unavailable degrades to 'no cooldown' rather than throwing", async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    const { setCooldown, getCooldown } = await import("@/lib/youtubeCaptions/cooldown");
    await expect(setCooldown("vid5", "en", "YOUTUBE_BOT_BLOCKED")).resolves.toBeUndefined();
    await expect(getCooldown("vid5", "en")).resolves.toBeNull();
  });

  it("resolveCooldownStatus reports inactive for a null state", async () => {
    const { resolveCooldownStatus } = await import("@/lib/youtubeCaptions/cooldown");
    expect(resolveCooldownStatus(null)).toEqual({ active: false });
  });
});
