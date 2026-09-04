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

export function getRedis(): Redis | null {
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

interface WindowResult {
  allowed: boolean;
  count: number;
  retryAfterSec: number;
}

/** Fixed-window increment-and-check against a single Redis key. */
async function incrementWindow(key: string, limit: number, windowSec: number): Promise<WindowResult> {
  const redis = getRedis();
  if (!redis) return { allowed: true, count: 0, retryAfterSec: 0 };

  // INCR returns the post-increment count and is atomic even under
  // concurrent requests; only the call that takes the counter from 0 to 1
  // sets the window's expiry.
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, windowSec);
  }

  if (count > limit) {
    const ttl = await redis.ttl(key);
    return { allowed: false, count, retryAfterSec: ttl > 0 ? ttl : windowSec };
  }

  return { allowed: true, count, retryAfterSec: 0 };
}

export interface RateLimitOptions {
  /** Max requests allowed within the window. */
  limit: number;
  /** Window size in milliseconds. */
  windowMs: number;
}

/**
 * Returns a NextResponse with status 429 if the caller has exceeded the
 * limit, or null if the request is allowed to proceed. Per-client (keyed by
 * IP) — for a budget shared across ALL callers regardless of who's asking,
 * use checkGeminiQuota instead.
 */
export async function checkRateLimit(
  request: NextRequest,
  routeName: string,
  { limit, windowMs }: RateLimitOptions
): Promise<NextResponse | null> {
  const key = `ratelimit:${routeName}:${getClientKey(request)}`;
  const result = await incrementWindow(key, limit, Math.ceil(windowMs / 1000));

  if (!result.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down and try again shortly." },
      { status: 429, headers: { "Retry-After": String(result.retryAfterSec) } }
    );
  }

  return null;
}

// Google's free-tier RPM/RPD limits apply to the whole API key/project, not
// per user — a per-IP limiter like checkRateLimit above would let every
// visitor independently burn through the *same* shared quota. These two
// keys are intentionally global (not scoped by client) so every Gemini call
// site in the app draws from one real, shared budget. Override via env if
// your tier's numbers differ from the defaults below (checked 2026-08).
const GEMINI_RPM_LIMIT = Number(process.env.GEMINI_RPM_LIMIT ?? 5);
const GEMINI_RPD_LIMIT = Number(process.env.GEMINI_RPD_LIMIT ?? 20);
const GEMINI_RPM_KEY = "gemini-quota:rpm";
const GEMINI_RPD_KEY = "gemini-quota:rpd";

export interface GeminiQuotaResult {
  allowed: boolean;
  reason?: "rpm" | "rpd";
  retryAfterSec?: number;
}

/**
 * Call this immediately before an actual Gemini API call — after any cache
 * check, and only on the branch that's really about to spend a call — so
 * cache hits and "didn't need Gemini after all" paths never consume budget.
 */
export async function checkGeminiQuota(): Promise<GeminiQuotaResult> {
  const rpm = await incrementWindow(GEMINI_RPM_KEY, GEMINI_RPM_LIMIT, 60);
  if (!rpm.allowed) return { allowed: false, reason: "rpm", retryAfterSec: rpm.retryAfterSec };

  const rpd = await incrementWindow(GEMINI_RPD_KEY, GEMINI_RPD_LIMIT, 86_400);
  if (!rpd.allowed) return { allowed: false, reason: "rpd", retryAfterSec: rpd.retryAfterSec };

  return { allowed: true };
}

export interface GeminiQuotaStatus {
  /** False when Upstash isn't configured — usage isn't actually tracked. */
  configured: boolean;
  rpmUsed: number;
  rpmLimit: number;
  rpdUsed: number;
  rpdLimit: number;
}

/** Read-only status for display (e.g. "14/20 AI calls left today") — never increments. */
export async function peekGeminiQuota(): Promise<GeminiQuotaStatus> {
  const redis = getRedis();
  if (!redis) {
    return { configured: false, rpmUsed: 0, rpmLimit: GEMINI_RPM_LIMIT, rpdUsed: 0, rpdLimit: GEMINI_RPD_LIMIT };
  }

  const [rpmUsed, rpdUsed] = await Promise.all([
    redis.get<number>(GEMINI_RPM_KEY),
    redis.get<number>(GEMINI_RPD_KEY),
  ]);

  return {
    configured: true,
    rpmUsed: rpmUsed ?? 0,
    rpmLimit: GEMINI_RPM_LIMIT,
    rpdUsed: rpdUsed ?? 0,
    rpdLimit: GEMINI_RPD_LIMIT,
  };
}
