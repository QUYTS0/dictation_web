import { createHmac, timingSafeEqual } from "crypto";

/**
 * Server-signed recovery token for an Azure result that was obtained but
 * could not be written to the database (plan §9.4). The client can only
 * relay it to /api/practice/evaluate/persist-recovery — it cannot read a
 * trusted value out of it or forge/extend one. Server-only module: the
 * secret never leaves the server, and neither this module nor its callers
 * log tokens.
 *
 * token = base64url(JSON payload) + "." + base64url(HMAC-SHA256(payload part, secret))
 */

export const RECOVERY_TOKEN_TTL_SEC = Number(process.env.AZURE_RECOVERY_TOKEN_TTL_SEC ?? 600);
const MIN_SECRET_LENGTH = 32;
const TOKEN_VERSION = 1;

export interface RecoveryResult {
  pronunciationScore: number;
  accuracyScore: number | null;
  fluencyScore: number | null;
  completenessScore: number | null;
  prosodyScore: number | null;
  detail: Record<string, unknown> | null;
  engineVersion: string | null;
}

export interface RecoveryPayload {
  v: number;
  userId: string;
  attemptId: string;
  seq: number;
  result: RecoveryResult;
  iat: number;
  exp: number;
}

/** The signing secret, or null when missing/too short — callers must treat
 *  null as "evaluation not available" BEFORE spending a paid call. */
export function getRecoverySecret(): string | null {
  const secret = process.env.AZURE_RECOVERY_SIGNING_SECRET;
  return secret && secret.length >= MIN_SECRET_LENGTH ? secret : null;
}

function sign(part: string, secret: string): string {
  return createHmac("sha256", secret).update(part).digest("base64url");
}

export function issueRecoveryToken(
  secret: string,
  claims: { userId: string; attemptId: string; seq: number; result: RecoveryResult },
  nowSec = Math.floor(Date.now() / 1000)
): string {
  const payload: RecoveryPayload = { v: TOKEN_VERSION, ...claims, iat: nowSec, exp: nowSec + RECOVERY_TOKEN_TTL_SEC };
  const part = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${part}.${sign(part, secret)}`;
}

export type VerifyResult =
  | { ok: true; payload: RecoveryPayload }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

export function verifyRecoveryToken(secret: string, token: unknown, nowSec = Math.floor(Date.now() / 1000)): VerifyResult {
  if (typeof token !== "string" || token.length > 200_000) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
  const expected = Buffer.from(sign(parts[0], secret));
  const actual = Buffer.from(parts[1]);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return { ok: false, reason: "bad_signature" };
  let payload: RecoveryPayload;
  try {
    payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    !payload ||
    payload.v !== TOKEN_VERSION ||
    typeof payload.userId !== "string" ||
    typeof payload.attemptId !== "string" ||
    !Number.isInteger(payload.seq) ||
    typeof payload.exp !== "number" ||
    typeof payload.result?.pronunciationScore !== "number"
  ) {
    return { ok: false, reason: "malformed" };
  }
  if (nowSec >= payload.exp) return { ok: false, reason: "expired" };
  return { ok: true, payload };
}
