/**
 * Learning Reports P5 — client-side pending AI saves (sessionStorage).
 * Keys: ai-recovery:<userId>:<roundId>:<op>:<id>. Everything is wrapped:
 * storage can be unavailable (private mode, quota) — callers are told, and
 * the UI says the result can't be kept across a reload.
 */
import type { AiRecoveryEntry } from "@/lib/ai/types";

const PREFIX = "ai-recovery:";

export interface PendingRecovery {
  key: string;
  entry: AiRecoveryEntry;
  savedAt: string;
}

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

export function recoveryKey(userId: string, roundId: string, entry: AiRecoveryEntry): string {
  // The sealed token is unique per operation; a short digest-free suffix is enough to scope it.
  return `${PREFIX}${userId}:${roundId}:${entry.op}:${entry.token.slice(-24)}`;
}

/** false when the entry could not be stored (it then lives only in this page). */
export function savePending(userId: string, roundId: string, entry: AiRecoveryEntry): boolean {
  const s = storage();
  if (!s) return false;
  try {
    s.setItem(recoveryKey(userId, roundId, entry), JSON.stringify({ entry, savedAt: new Date().toISOString() }));
    return true;
  } catch {
    return false;
  }
}

export function loadPending(userId: string, roundId: string): PendingRecovery[] {
  const s = storage();
  if (!s) return [];
  const out: PendingRecovery[] = [];
  const scope = `${PREFIX}${userId}:${roundId}:`;
  try {
    for (let i = 0; i < s.length; i++) {
      const key = s.key(i);
      if (!key || !key.startsWith(scope)) continue;
      try {
        const v = JSON.parse(s.getItem(key) ?? "null");
        if (v?.entry?.op && typeof v.entry.token === "string") out.push({ key, entry: v.entry, savedAt: v.savedAt ?? "" });
      } catch {
        /* skip a corrupt entry */
      }
    }
  } catch {
    return [];
  }
  return out;
}

export function removePending(key: string): void {
  try {
    storage()?.removeItem(key);
  } catch {
    /* nothing to do */
  }
}

/** On sign-out / account switch: every pending AI save, for every account. */
export function clearAllPending(): void {
  const s = storage();
  if (!s) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k?.startsWith(PREFIX)) keys.push(k);
    }
    keys.forEach((k) => s.removeItem(k));
  } catch {
    /* nothing to do */
  }
}
