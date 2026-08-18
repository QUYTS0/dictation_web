import { NextRequest } from "next/server";

// In-memory fake standing in for the Upstash REST client, keyed the same
// way real Redis would be, so checkRateLimit's logic is exercised as-is.
const store = new Map<string, { count: number; expiresAt: number | null }>();

jest.mock("@upstash/redis", () => {
  return {
    Redis: class {
      async incr(key: string): Promise<number> {
        const entry = store.get(key) ?? { count: 0, expiresAt: null };
        entry.count += 1;
        store.set(key, entry);
        return entry.count;
      }
      async expire(key: string, seconds: number): Promise<void> {
        const entry = store.get(key);
        if (entry) entry.expiresAt = Date.now() + seconds * 1000;
      }
      async ttl(key: string): Promise<number> {
        const entry = store.get(key);
        if (!entry?.expiresAt) return -1;
        return Math.ceil((entry.expiresAt - Date.now()) / 1000);
      }
    },
  };
});

function makeRequest(ip: string): NextRequest {
  return new NextRequest("http://localhost/api/test", {
    headers: { "x-forwarded-for": ip },
  });
}

describe("checkRateLimit", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    store.clear();
    jest.resetModules();
    process.env = {
      ...originalEnv,
      UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
      UPSTASH_REDIS_REST_TOKEN: "test-token",
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("allows requests under the limit", async () => {
    const { checkRateLimit } = await import("@/lib/rateLimit");
    const req = makeRequest("1.1.1.1");
    for (let i = 0; i < 3; i++) {
      expect(await checkRateLimit(req, "test-route-a", { limit: 3, windowMs: 60_000 })).toBeNull();
    }
  });

  it("blocks requests once the limit is exceeded", async () => {
    const { checkRateLimit } = await import("@/lib/rateLimit");
    const req = makeRequest("2.2.2.2");
    for (let i = 0; i < 2; i++) {
      expect(await checkRateLimit(req, "test-route-b", { limit: 2, windowMs: 60_000 })).toBeNull();
    }
    const blocked = await checkRateLimit(req, "test-route-b", { limit: 2, windowMs: 60_000 });
    expect(blocked).not.toBeNull();
    expect(blocked?.status).toBe(429);
  });

  it("tracks separate clients independently", async () => {
    const { checkRateLimit } = await import("@/lib/rateLimit");
    const reqA = makeRequest("3.3.3.3");
    const reqB = makeRequest("4.4.4.4");
    expect(await checkRateLimit(reqA, "test-route-c", { limit: 1, windowMs: 60_000 })).toBeNull();
    expect((await checkRateLimit(reqA, "test-route-c", { limit: 1, windowMs: 60_000 }))?.status).toBe(429);
    expect(await checkRateLimit(reqB, "test-route-c", { limit: 1, windowMs: 60_000 })).toBeNull();
  });

  it("tracks separate route names independently", async () => {
    const { checkRateLimit } = await import("@/lib/rateLimit");
    const req = makeRequest("5.5.5.5");
    expect(await checkRateLimit(req, "route-x", { limit: 1, windowMs: 60_000 })).toBeNull();
    expect(await checkRateLimit(req, "route-y", { limit: 1, windowMs: 60_000 })).toBeNull();
  });

  it("disables rate limiting (fails open) when Upstash env vars are missing", async () => {
    process.env = { ...originalEnv };
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    const { checkRateLimit } = await import("@/lib/rateLimit");
    const req = makeRequest("6.6.6.6");
    for (let i = 0; i < 5; i++) {
      expect(await checkRateLimit(req, "test-route-d", { limit: 1, windowMs: 60_000 })).toBeNull();
    }
  });
});
