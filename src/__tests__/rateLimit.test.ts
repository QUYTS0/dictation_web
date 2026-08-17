import { NextRequest } from "next/server";
import { checkRateLimit } from "@/lib/rateLimit";

function makeRequest(ip: string): NextRequest {
  return new NextRequest("http://localhost/api/test", {
    headers: { "x-forwarded-for": ip },
  });
}

describe("checkRateLimit", () => {
  it("allows requests under the limit", () => {
    const req = makeRequest("1.1.1.1");
    for (let i = 0; i < 3; i++) {
      expect(checkRateLimit(req, "test-route-a", { limit: 3, windowMs: 60_000 })).toBeNull();
    }
  });

  it("blocks requests once the limit is exceeded", async () => {
    const req = makeRequest("2.2.2.2");
    for (let i = 0; i < 2; i++) {
      expect(checkRateLimit(req, "test-route-b", { limit: 2, windowMs: 60_000 })).toBeNull();
    }
    const blocked = checkRateLimit(req, "test-route-b", { limit: 2, windowMs: 60_000 });
    expect(blocked).not.toBeNull();
    expect(blocked?.status).toBe(429);
  });

  it("tracks separate clients independently", () => {
    const reqA = makeRequest("3.3.3.3");
    const reqB = makeRequest("4.4.4.4");
    expect(checkRateLimit(reqA, "test-route-c", { limit: 1, windowMs: 60_000 })).toBeNull();
    expect(checkRateLimit(reqA, "test-route-c", { limit: 1, windowMs: 60_000 })?.status).toBe(429);
    expect(checkRateLimit(reqB, "test-route-c", { limit: 1, windowMs: 60_000 })).toBeNull();
  });

  it("tracks separate route names independently", () => {
    const req = makeRequest("5.5.5.5");
    expect(checkRateLimit(req, "route-x", { limit: 1, windowMs: 60_000 })).toBeNull();
    expect(checkRateLimit(req, "route-y", { limit: 1, windowMs: 60_000 })).toBeNull();
  });
});
