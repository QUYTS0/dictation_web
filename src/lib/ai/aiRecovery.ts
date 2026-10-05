/**
 * Learning Reports P5 — recovery tokens for AI results that were generated
 * but could not be saved. SERVER-ONLY.
 *
 * Same role as src/lib/practice/recoveryToken.ts (Azure), with a distinct
 * purpose and version (`ai-recovery:v1`) and a 24-hour validity. Difference:
 * the claims carry the database operation token, which the browser must not
 * read, so they are SEALED (AES-256-GCM: confidentiality + integrity, the
 * purpose bound as additional authenticated data) instead of only signed.
 * The key is derived from AI_RECOVERY_SIGNING_SECRET (≥ 32 characters).
 *
 * Every field that influences storage is inside the sealed claims: user,
 * round, operation kind and identity, the DB token, fingerprint / target
 * ids, content version, and the canonical hashes of the payload and meta the
 * client must send back. The recover route recomputes those hashes.
 */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "crypto";

export const AI_RECOVERY_PURPOSE = "ai-recovery:v1";
export const AI_RECOVERY_TTL_SEC = 24 * 60 * 60;
const MIN_SECRET_LENGTH = 32;

export type AiRecoveryClaims =
  | {
      v: 1;
      op: "overview";
      userId: string;
      roundId: string;
      generation: number;
      token: string;
      fingerprint: string;
      promptVersion: number;
      model: string;
      payloadHash: string;
      metaHash: string;
      iat: number;
      exp: number;
    }
  | {
      v: 1;
      op: "explanations";
      userId: string;
      roundId: string;
      operationId: string;
      token: string;
      targets: string[];
      promptVersion: number;
      model: string;
      payloadHash: string;
      iat: number;
      exp: number;
    };

type ClaimsInput = AiRecoveryClaims extends infer C ? (C extends AiRecoveryClaims ? Omit<C, "v" | "iat" | "exp"> : never) : never;

/** The configured secret, or null — callers must refuse to spend quota when it is null. */
export function getAiRecoverySecret(): string | null {
  const s = process.env.AI_RECOVERY_SIGNING_SECRET;
  return s && s.length >= MIN_SECRET_LENGTH ? s : null;
}

function key(secret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, "dictation-ai-recovery", AI_RECOVERY_PURPOSE, 32));
}

/** Deterministic JSON (sorted object keys) — the representation hashed on both sides. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}

export function contentHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function sealAiRecovery(secret: string, claims: ClaimsInput, nowSec = Math.floor(Date.now() / 1000)): string {
  const full = { ...claims, v: 1, iat: nowSec, exp: nowSec + AI_RECOVERY_TTL_SEC } as AiRecoveryClaims;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(secret), iv);
  cipher.setAAD(Buffer.from(AI_RECOVERY_PURPOSE));
  const body = Buffer.concat([cipher.update(JSON.stringify(full), "utf8"), cipher.final()]);
  return `v1.${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url")}`;
}

export type OpenResult = { ok: true; claims: AiRecoveryClaims } | { ok: false; reason: "malformed" | "bad_token" | "expired" };

export function openAiRecovery(secret: string, token: unknown, nowSec = Math.floor(Date.now() / 1000)): OpenResult {
  if (typeof token !== "string" || token.length > 20_000 || !token.startsWith("v1.")) return { ok: false, reason: "malformed" };
  let raw: Buffer;
  try {
    raw = Buffer.from(token.slice(3), "base64url");
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (raw.length < 12 + 16 + 2) return { ok: false, reason: "malformed" };
  let claims: AiRecoveryClaims;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key(secret), raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(AI_RECOVERY_PURPOSE));
    decipher.setAuthTag(raw.subarray(12, 28));
    const text = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    claims = JSON.parse(text);
  } catch {
    return { ok: false, reason: "bad_token" };
  }
  if (!claims || claims.v !== 1 || (claims.op !== "overview" && claims.op !== "explanations") || typeof claims.exp !== "number") {
    return { ok: false, reason: "malformed" };
  }
  if (nowSec >= claims.exp) return { ok: false, reason: "expired" };
  return { ok: true, claims };
}
