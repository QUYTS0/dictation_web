import { NextRequest, NextResponse } from "next/server";

/**
 * In-memory fixed-window rate limiter. Sufficient for a single-instance
 * small-group deployment (no Redis/external store required). State resets
 * whenever the serverless instance recycles, which is an acceptable
 * trade-off at this scale — the goal is to blunt accidental hammering and
 * quota abuse, not to provide airtight global limits.
 */
const buckets = new Map<string, { count: number; resetAt: number }>();

function getClientKey(request: NextRequest): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) return forwardedFor.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}

export interface RateLimitOptions {
  /** Max requests allowed within the window. */
  limit: number;
  /** Window size in milliseconds. */
  windowMs: number;
}

/**
 * Returns a NextResponse with status 429 if the caller has exceeded the
 * limit, or null if the request is allowed to proceed.
 */
export function checkRateLimit(
  request: NextRequest,
  routeName: string,
  { limit, windowMs }: RateLimitOptions
): NextResponse | null {
  const key = `${routeName}:${getClientKey(request)}`;
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || now >= bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return null;
  }

  if (bucket.count >= limit) {
    const retryAfterSec = Math.ceil((bucket.resetAt - now) / 1000);
    return NextResponse.json(
      { error: "Too many requests. Please slow down and try again shortly." },
      { status: 429, headers: { "Retry-After": String(retryAfterSec) } }
    );
  }

  bucket.count += 1;
  return null;
}
