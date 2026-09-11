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

// Azure Language F0's 5,000 text-records/month pool is shared across
// several Language features on the same resource (sentiment analysis, key
// phrase extraction, language detection, NER, question answering, CLU) —
// this counter is a conservative internal application budget only, NOT an
// authoritative mirror of Azure Portal's own usage metering, which remains
// the source of truth for actual billing. Unlike the Gemini counters above
// (always +1 per call), a single Key Phrase Extraction document can cost
// more than one text record (ceil(charLength/1000)), so this increments by
// a variable amount.
const AZURE_KEY_PHRASE_MONTH_KEY = "azure-key-phrase-quota:month";
const AZURE_KEY_PHRASE_MONTH_SECONDS = 31 * 24 * 60 * 60;

async function incrementWindowBy(key: string, amount: number, limit: number, windowSec: number): Promise<WindowResult> {
  const redis = getRedis();
  if (!redis) return { allowed: true, count: 0, retryAfterSec: 0 };

  const count = await redis.incrby(key, amount);
  if (count === amount) {
    // First increment in this window — start its expiry now.
    await redis.expire(key, windowSec);
  }

  if (count > limit) {
    const ttl = await redis.ttl(key);
    return { allowed: false, count, retryAfterSec: ttl > 0 ? ttl : windowSec };
  }
  return { allowed: true, count, retryAfterSec: 0 };
}

/**
 * Call before sending an Azure Key Phrase Extraction request, with the
 * request's real text-record cost (sum of ceil(charLength/1000) per
 * document actually being sent). Returns allowed:false once the
 * conservative monthly budget (AZURE_KEY_PHRASE_MONTHLY_RECORD_BUDGET) is
 * reached — callers must stop issuing further Azure requests for the rest
 * of the run, not retry.
 */
export async function checkAzureKeyPhraseQuota(
  textRecordCost: number,
  monthlyBudget: number
): Promise<{ allowed: boolean; retryAfterSec?: number }> {
  const result = await incrementWindowBy(AZURE_KEY_PHRASE_MONTH_KEY, textRecordCost, monthlyBudget, AZURE_KEY_PHRASE_MONTH_SECONDS);
  return { allowed: result.allowed, retryAfterSec: result.allowed ? undefined : result.retryAfterSec };
}

// Azure Speech F0's TTS allowance (0.5M characters/month for neural voices)
// is a pool separate from the F0 STT allowance, on the same resource — this
// counter is a conservative internal application budget only, NOT an
// authoritative mirror of Azure Portal's own usage metering. Mirrors
// checkAzureKeyPhraseQuota's shape (variable-amount monthly counter) since a
// single synthesis request costs more than one "unit" (its character count).
const AZURE_TTS_MONTH_KEY = "azure-tts-quota:month";
const AZURE_TTS_MONTH_SECONDS = 31 * 24 * 60 * 60;

/**
 * Call before sending an Azure TTS synthesis request, with the request's
 * character count. Returns allowed:false once the conservative monthly
 * character budget is reached.
 */
export async function checkAzureTtsQuota(
  charCount: number,
  monthlyBudget: number
): Promise<{ allowed: boolean; retryAfterSec?: number }> {
  const result = await incrementWindowBy(AZURE_TTS_MONTH_KEY, charCount, monthlyBudget, AZURE_TTS_MONTH_SECONDS);
  return { allowed: result.allowed, retryAfterSec: result.allowed ? undefined : result.retryAfterSec };
}

// Azure's F0 real-time TTS rate ceiling (20 transactions/60s) is
// resource-wide, not per-user/per-IP — like GEMINI_RPM_LIMIT, this counter
// is intentionally global so every caller draws from one real, shared
// budget, kept conservatively under Azure's own limit to leave headroom.
const AZURE_TTS_RPM_LIMIT = Number(process.env.AZURE_TTS_RPM_LIMIT ?? 15);
const AZURE_TTS_RPM_KEY = "azure-tts-quota:rpm";

/** Call immediately before an actual Azure TTS synthesis call — after the
 *  cache check, only on the branch that's really about to spend a call. */
export async function checkAzureTtsRate(): Promise<{ allowed: boolean; retryAfterSec?: number }> {
  const result = await incrementWindow(AZURE_TTS_RPM_KEY, AZURE_TTS_RPM_LIMIT, 60);
  return { allowed: result.allowed, retryAfterSec: result.allowed ? undefined : result.retryAfterSec };
}

/**
 * Whether the quota backend is even configured — every other quota check in
 * this file fails OPEN (unenforced) when it isn't, which is the right
 * default for local dev/tests but is NOT safe for a route that spends money
 * on every call it lets through. New TTS synthesis specifically must fail
 * CLOSED instead when this is false in production (see the pronounce
 * route) — dictionary audio and already-cached assets never reach this
 * check at all, so they keep working regardless.
 */
export function isQuotaBackendConfigured(): boolean {
  return getRedis() !== null;
}

/** Separated into its own function (rather than inlining
 *  `process.env.NODE_ENV === "production"` at the call site) purely so
 *  tests can mock it directly — reassigning `process.env.NODE_ENV` at test
 *  time doesn't reliably propagate to already-imported modules in this
 *  project's Next.js/ts-jest setup. In a real deployment this simply
 *  reflects the actual runtime environment. */
export function isProductionEnvironment(): boolean {
  return process.env.NODE_ENV === "production";
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
