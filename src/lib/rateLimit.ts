import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";

/**
 * Upstash Redis-backed fixed-window rate limiter. Counters live in Redis
 * (REST-based, works from any serverless instance/region) instead of an
 * in-memory Map, which reset per-instance and gave no real protection once
 * deployed with more than one instance.
 *
 * Fails open (rate limiting disabled, request allowed) if
 * UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN aren't configured, so
 * local dev and tests don't require a live Upstash instance.
 */
let redisClient: Redis | null | undefined;

function getRedis(): Redis | null {
  if (redisClient === undefined) {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) {
      console.warn(
        "[rateLimit] UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN not set — rate limiting is disabled."
      );
      redisClient = null;
    } else {
      redisClient = new Redis({ url, token });
    }
  }
  return redisClient;
}

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
export async function checkRateLimit(
  request: NextRequest,
  routeName: string,
  { limit, windowMs }: RateLimitOptions
): Promise<NextResponse | null> {
  const redis = getRedis();
  if (!redis) return null;

  const key = `ratelimit:${routeName}:${getClientKey(request)}`;
  const windowSec = Math.ceil(windowMs / 1000);

  // INCR returns the post-increment count and is atomic even under
  // concurrent requests; only the call that takes the counter from 0 to 1
  // sets the window's expiry.
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, windowSec);
  }

  if (count > limit) {
    const ttl = await redis.ttl(key);
    const retryAfterSec = ttl > 0 ? ttl : windowSec;
    return NextResponse.json(
      { error: "Too many requests. Please slow down and try again shortly." },
      { status: 429, headers: { "Retry-After": String(retryAfterSec) } }
    );
  }

  return null;
}
