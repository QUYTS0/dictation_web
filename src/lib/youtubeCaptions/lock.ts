// =====================================================
// Distributed single-flight lock for transcript generation, so two tabs or
// two users opening the same uncached video don't both hit YouTube. Backed
// by the same Upstash Redis instance already used for rate limiting
// (getRedis() from src/lib/rateLimit.ts) and, like it, fails open when
// Redis isn't configured — falling back to a best-effort, per-instance-only
// in-memory map (mirroring the non-distributed pattern already used by
// src/lib/translate.ts's inFlightTranslations).
//
// A lock/Redis failure here must never be treated as "generation failed" —
// callers that can't acquire a lock proceed as if uncontended rather than
// erroring, since the whole point is best-effort de-duplication, not a
// correctness guarantee that would justify blocking a user's request.
// =====================================================

import { getRedis } from "@/lib/rateLimit";
import { LOCK_CONFIG } from "./config";

export function transcriptLockKey(videoId: string, language: string): string {
  return `transcript-generation:${videoId}:${language}`;
}

export interface AcquiredLock {
  token: string;
  key: string;
  /** Releases the lock — safe to call multiple times; only actually deletes
   *  the key if this token still owns it (a Lua compare-and-delete, so a
   *  lock that already expired and was re-acquired by someone else is never
   *  deleted out from under them). */
  release: () => Promise<void>;
}

// Compare-and-delete: only removes the key if its current value still
// matches the owner token this caller was given, so a slow request that
// outlives the TTL can't delete a lock another request has since acquired.
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

function randomToken(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

// Per-process fallback used only when Redis isn't configured. Explicitly
// NOT distributed — documented in the module comment above — but still
// prevents duplicate upstream calls from concurrent requests handled by the
// same warm serverless instance.
const inMemoryLocks = new Map<string, { token: string; expiresAt: number }>();

function acquireInMemoryLock(key: string, ttlMs: number): AcquiredLock | null {
  const now = Date.now();
  const existing = inMemoryLocks.get(key);
  if (existing && existing.expiresAt > now) return null;

  const token = randomToken();
  inMemoryLocks.set(key, { token, expiresAt: now + ttlMs });
  return {
    token,
    key,
    release: async () => {
      const current = inMemoryLocks.get(key);
      if (current?.token === token) inMemoryLocks.delete(key);
    },
  };
}

/**
 * Attempts to acquire the single-flight lock for `videoId`+`language`.
 * Returns null when another request already holds it (caller should treat
 * this as "generation in progress elsewhere", not an error) — never
 * throws.
 */
export async function acquireTranscriptLock(
  videoId: string,
  language: string,
  ttlMs: number = LOCK_CONFIG.ttlMs
): Promise<AcquiredLock | null> {
  const key = transcriptLockKey(videoId, language);
  const redis = getRedis();

  if (!redis) return acquireInMemoryLock(key, ttlMs);

  try {
    const token = randomToken();
    const setResult = await redis.set(key, token, { nx: true, px: ttlMs });
    if (setResult !== "OK") return null;

    return {
      token,
      key,
      release: async () => {
        try {
          await redis.eval(RELEASE_SCRIPT, [key], [token]);
        } catch (err) {
          // A failed release just leaves the lock to expire via its TTL —
          // never worth surfacing as a request-level error.
          console.warn(`[transcriptLock] release failed for ${key}: ${String(err)}`);
        }
      },
    };
  } catch (err) {
    // Redis reachable but errored (or unreachable) — degrade to uncontended
    // rather than blocking generation on lock infrastructure.
    console.warn(`[transcriptLock] acquire failed for ${key}, proceeding without a distributed lock: ${String(err)}`);
    return acquireInMemoryLock(key, ttlMs);
  }
}
