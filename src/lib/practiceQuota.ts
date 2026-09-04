// Monthly usage budget for /api/practice/evaluate (Azure Speech Pronunciation
// Assessment, F0 free tier: 5 audio-hours/month). Tracked in the same
// Upstash Redis instance already used for the Gemini quota (see
// rateLimit.ts) — a fixed-window counter keyed by calendar month so it lines
// up with Azure's own free-tier billing window. Fails open (quota not
// enforced) when Redis isn't configured, matching this app's existing
// rate-limiting philosophy for local dev.

import { getRedis } from "./rateLimit";

const MONTHLY_LIMIT_SEC = Number(process.env.AZURE_SPEECH_MONTHLY_LIMIT_SEC ?? 5 * 60 * 60);
// Comfortably outlives the calendar month a key names, so old months' keys
// self-clean from Redis instead of accumulating forever.
const KEY_TTL_SEC = 40 * 24 * 60 * 60;

function monthKey(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function secKey(): string {
  return `practice-eval-quota:${monthKey()}:sec`;
}

function countKey(): string {
  return `practice-eval-quota:${monthKey()}:count`;
}

export interface PracticeQuotaStatus {
  /** False when Upstash isn't configured — usage isn't actually tracked/enforced. */
  configured: boolean;
  usedSec: number;
  limitSec: number;
  usedCount: number;
  limitReached: boolean;
}

/** Read-only status for display — never spends anything. */
export async function peekPracticeQuota(): Promise<PracticeQuotaStatus> {
  const redis = getRedis();
  if (!redis) {
    return { configured: false, usedSec: 0, limitSec: MONTHLY_LIMIT_SEC, usedCount: 0, limitReached: false };
  }
  const [usedSec, usedCount] = await Promise.all([redis.get<number>(secKey()), redis.get<number>(countKey())]);
  const sec = usedSec ?? 0;
  return {
    configured: true,
    usedSec: sec,
    limitSec: MONTHLY_LIMIT_SEC,
    usedCount: usedCount ?? 0,
    limitReached: sec >= MONTHLY_LIMIT_SEC,
  };
}

/**
 * Check-before-spend for one evaluation call — call this before the Azure
 * request, then recordPracticeUsage only after it actually succeeds, so a
 * failed Azure call never burns budget. Not perfectly atomic against
 * concurrent requests (same tolerance as checkGeminiQuota in rateLimit.ts) —
 * acceptable at personal-app traffic.
 */
export async function reservePracticeQuota(durationSec: number): Promise<{ allowed: boolean; status: PracticeQuotaStatus }> {
  const status = await peekPracticeQuota();
  if (!status.configured) return { allowed: true, status };
  if (status.usedSec + durationSec > status.limitSec) {
    return { allowed: false, status: { ...status, limitReached: true } };
  }
  return { allowed: true, status };
}

/** Call only after a successful Azure evaluation. */
export async function recordPracticeUsage(durationSec: number): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const addedSec = Math.max(1, Math.round(durationSec));
  const [newSec] = await Promise.all([redis.incrby(secKey(), addedSec), redis.incr(countKey())]);
  if (newSec === addedSec) {
    // First write this calendar month — set expiry now that the key exists.
    await Promise.all([redis.expire(secKey(), KEY_TTL_SEC), redis.expire(countKey(), KEY_TTL_SEC)]);
  }
}
