// =====================================================
// Temporary failure record ("negative cache") so a client that just got
// bot-blocked/rate-limited doesn't immediately hammer YouTube again on the
// next poll. Backed by the same Upstash Redis instance as the rest of this
// subsystem; fails open (no cooldown recorded/observed) when Redis isn't
// configured, exactly like rateLimit.ts and lock.ts — a cooldown-store
// failure must never block or fail a generation request, and must never
// touch the ready-transcript row.
// =====================================================

import { getRedis } from "@/lib/rateLimit";
import { COOLDOWN_MS, isCooldownEligible, type CooldownEligibleCode } from "./config";
import type { TranscriptFetchErrorCode } from "./errors";

export function transcriptCooldownKey(videoId: string, language: string): string {
  return `transcript-cooldown:${videoId}:${language}`;
}

export interface CooldownState {
  code: TranscriptFetchErrorCode;
  setAt: number;
  /** Present only when the cooldown's duration came from a YouTube
   *  `Retry-After` header rather than our own COOLDOWN_MS default. */
  retryAfterMsOverride?: number;
}

export async function getCooldown(videoId: string, language: string): Promise<CooldownState | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const value = await redis.get<CooldownState>(transcriptCooldownKey(videoId, language));
    return value ?? null;
  } catch (err) {
    console.warn(`[transcriptCooldown] read failed for ${videoId}/${language}: ${String(err)}`);
    return null;
  }
}

/**
 * Records a cooldown for `code`, if that code is cooldown-eligible (see
 * config.ts's COOLDOWN_MS — a plain per-provider parser error that's about
 * to be retried by the *other* provider is deliberately not listed there,
 * so it never suppresses that other provider). `retryAfterMs`, when given
 * (from a YouTube `Retry-After` header), takes precedence over the default
 * duration for `code`.
 */
export async function setCooldown(
  videoId: string,
  language: string,
  code: TranscriptFetchErrorCode,
  retryAfterMs?: number
): Promise<void> {
  if (!isCooldownEligible(code)) return;
  const redis = getRedis();
  if (!redis) return;

  const durationMs = retryAfterMs && retryAfterMs > 0 ? retryAfterMs : COOLDOWN_MS[code as CooldownEligibleCode];
  const state: CooldownState = {
    code,
    setAt: Date.now(),
    ...(retryAfterMs ? { retryAfterMsOverride: retryAfterMs } : {}),
  };

  try {
    await redis.set(transcriptCooldownKey(videoId, language), state, { px: Math.max(1_000, durationMs) });
  } catch (err) {
    console.warn(`[transcriptCooldown] write failed for ${videoId}/${language}: ${String(err)}`);
  }
}

export async function clearCooldown(videoId: string, language: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.del(transcriptCooldownKey(videoId, language));
  } catch (err) {
    console.warn(`[transcriptCooldown] clear failed for ${videoId}/${language}: ${String(err)}`);
  }
}

export interface CooldownStatus {
  active: boolean;
  retryAt?: string;
  retryAfterMs?: number;
  previousErrorCode?: TranscriptFetchErrorCode;
}

/** Resolves a stored CooldownState into "how much longer, if any" — the
 *  shape generate/route.ts hands back to the client. */
export function resolveCooldownStatus(state: CooldownState | null): CooldownStatus {
  if (!state) return { active: false };

  const durationMs =
    state.retryAfterMsOverride ?? (isCooldownEligible(state.code) ? COOLDOWN_MS[state.code as CooldownEligibleCode] : 0);
  const expiresAt = state.setAt + durationMs;
  const remainingMs = expiresAt - Date.now();
  if (remainingMs <= 0) return { active: false };

  return {
    active: true,
    retryAt: new Date(expiresAt).toISOString(),
    retryAfterMs: remainingMs,
    previousErrorCode: state.code,
  };
}
