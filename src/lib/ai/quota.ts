/**
 * Learning Reports P5 — atomic Gemini quota admission (application quota).
 * SERVER-ONLY.
 *
 * Every real provider attempt (including a parse retry) is admitted under a
 * server-built, globally scoped id:
 *   gemini:<env>:adm:<operationType>:<operationId>:<attemptNo>
 * One Lua script (Redis EVAL, via Upstash) checks RPM, the shared daily
 * limit and the optional per-user daily limit TOGETHER and either increments
 * all of them and records the id, or increments nothing.
 *
 *   admitted   — counters charged; the caller may make ONE provider call
 *   denied     — capacity reached (rpm | rpd | user_rpd); nothing charged
 *   duplicate  — this id was already admitted earlier: NO new charge and NO
 *                authority to call the provider again (the earlier call's
 *                outcome is unknown here)
 *   unavailable— Redis missing or failing: fail CLOSED. In production this is
 *                unconditional; elsewhere GEMINI_QUOTA_FAIL_OPEN=true turns it
 *                into `unmetered` (allowed, nothing counted) for local dev.
 *
 * Nothing is ever refunded: a timeout or ambiguous provider outcome stays
 * spent. This is the APPLICATION's daily quota on calendar days in
 * GEMINI_QUOTA_TZ (default UTC); it is not claimed to match the provider's
 * own reset time.
 */
import { getRedis, isProductionEnvironment } from "@/lib/rateLimit";

export const ADMISSION_LUA = `
local prior = redis.call('GET', KEYS[1])
if prior then return {'duplicate', prior} end
local rpm = tonumber(redis.call('GET', KEYS[2]) or '0')
local rpd = tonumber(redis.call('GET', KEYS[3]) or '0')
local usr = tonumber(redis.call('GET', KEYS[4]) or '0')
local rpmLimit = tonumber(ARGV[1])
local rpdLimit = tonumber(ARGV[2])
local userLimit = tonumber(ARGV[3])
if rpm >= rpmLimit then return {'denied', 'rpm', redis.call('TTL', KEYS[2])} end
if rpd >= rpdLimit then return {'denied', 'rpd', redis.call('TTL', KEYS[3])} end
if userLimit >= 0 and usr >= userLimit then return {'denied', 'user_rpd', redis.call('TTL', KEYS[4])} end
rpm = redis.call('INCR', KEYS[2])
if redis.call('TTL', KEYS[2]) < 0 then redis.call('EXPIRE', KEYS[2], ARGV[4]) end
rpd = redis.call('INCR', KEYS[3])
if redis.call('TTL', KEYS[3]) < 0 then redis.call('EXPIRE', KEYS[3], ARGV[5]) end
if userLimit >= 0 then
  usr = redis.call('INCR', KEYS[4])
  if redis.call('TTL', KEYS[4]) < 0 then redis.call('EXPIRE', KEYS[4], ARGV[5]) end
end
redis.call('SET', KEYS[1], ARGV[7], 'EX', ARGV[6])
return {'admitted', rpm, rpd, usr}
`;

export type OperationType = "assessment" | "explanations" | "explain" | "translate";

export interface AdmissionRequest {
  operationType: OperationType;
  /** Server-built, unique per logical operation (e.g. `overview:<roundId>:<generation>`). */
  operationId: string;
  /** 1 = the call, 2 = the parse retry. Each is admitted separately. */
  attempt: 1 | 2;
  /** Applies the per-user daily limit when set (anonymous callers: shared limits only). */
  userId: string | null;
}

export type AdmissionResult =
  | { status: "admitted"; key: string }
  | { status: "unmetered"; key: string }
  | { status: "denied"; reason: "rpm" | "rpd" | "user_rpd"; retryAfterSec: number }
  | { status: "duplicate"; key: string }
  | { status: "unavailable"; reason: "not_configured" | "error" };

/** Minimal executor: Upstash's `redis.eval(script, keys, args)`. Injectable for tests. */
export interface EvalExecutor {
  eval(script: string, keys: string[], args: (string | number)[]): Promise<unknown>;
  get?(key: string): Promise<unknown>;
}

export interface QuotaConfig {
  env: string;
  rpmLimit: number;
  rpdLimit: number;
  /** null = no separate per-user limit (it then equals the shared limit). */
  userRpdLimit: number | null;
  timeZone: string;
  failOpenOutsideProduction: boolean;
}

const ID_PART = /^[A-Za-z0-9._:-]{1,200}$/;

export function quotaConfig(): QuotaConfig {
  const num = (v: string | undefined, d: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : d;
  };
  const user = process.env.GEMINI_USER_RPD_LIMIT;
  return {
    env: (process.env.GEMINI_QUOTA_ENV || process.env.VERCEL_ENV || process.env.NODE_ENV || "development").replace(/[^A-Za-z0-9_-]/g, "_"),
    rpmLimit: num(process.env.GEMINI_RPM_LIMIT, 5),
    rpdLimit: num(process.env.GEMINI_RPD_LIMIT, 20),
    userRpdLimit: user === undefined || user === "" ? null : num(user, 0),
    timeZone: validTimeZone(process.env.GEMINI_QUOTA_TZ) ?? "UTC",
    failOpenOutsideProduction: process.env.GEMINI_QUOTA_FAIL_OPEN === "true",
  };
}

function validTimeZone(tz: string | undefined): string | null {
  if (!tz) return null;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

/** Calendar day (YYYY-MM-DD) in `timeZone`. */
export function quotaDay(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function quotaKeys(cfg: QuotaConfig, req: { operationType: string; operationId: string; attempt: number; userId: string | null }, now: Date) {
  const day = quotaDay(now, cfg.timeZone);
  const minute = Math.floor(now.getTime() / 60_000);
  const base = `gemini:${cfg.env}`;
  return {
    admission: `${base}:adm:${req.operationType}:${req.operationId}:${req.attempt}`,
    rpm: `${base}:rpm:${minute}`,
    rpd: `${base}:rpd:${day}`,
    userRpd: `${base}:urpd:${req.userId ?? "anonymous"}:${day}`,
    day,
  };
}

export async function admitGeminiAttempt(
  req: AdmissionRequest,
  deps: { executor?: EvalExecutor | null; config?: QuotaConfig; now?: Date } = {}
): Promise<AdmissionResult> {
  if (!ID_PART.test(req.operationId) || (req.userId !== null && !ID_PART.test(req.userId)) || (req.attempt !== 1 && req.attempt !== 2)) {
    throw new Error("invalid admission id");
  }
  const cfg = deps.config ?? quotaConfig();
  const now = deps.now ?? new Date();
  const keys = quotaKeys(cfg, req, now);
  const executor = deps.executor === undefined ? (getRedis() as unknown as EvalExecutor | null) : deps.executor;

  if (!executor) {
    if (!isProductionEnvironment() && cfg.failOpenOutsideProduction) return { status: "unmetered", key: keys.admission };
    return { status: "unavailable", reason: "not_configured" };
  }

  const userLimit = req.userId !== null && cfg.userRpdLimit !== null ? cfg.userRpdLimit : -1;
  let raw: unknown;
  try {
    raw = await executor.eval(
      ADMISSION_LUA,
      [keys.admission, keys.rpm, keys.rpd, keys.userRpd],
      [cfg.rpmLimit, cfg.rpdLimit, userLimit, 120, 2 * 86_400, 2 * 86_400, `reserved:${now.toISOString()}`]
    );
  } catch (err) {
    // Ambiguous: the reservation may or may not have been recorded. Fail
    // closed; a retry of the SAME id would come back `duplicate` (no call).
    console.error("[quota] admission failed:", err instanceof Error ? err.message : err);
    if (!isProductionEnvironment() && cfg.failOpenOutsideProduction) return { status: "unmetered", key: keys.admission };
    return { status: "unavailable", reason: "error" };
  }
  const r = Array.isArray(raw) ? raw : [];
  const tag = String(r[0] ?? "");
  if (tag === "admitted") return { status: "admitted", key: keys.admission };
  if (tag === "duplicate") return { status: "duplicate", key: keys.admission };
  if (tag === "denied") {
    const reason = r[1] === "rpm" || r[1] === "rpd" || r[1] === "user_rpd" ? r[1] : "rpd";
    const ttl = Number(r[2]);
    return { status: "denied", reason, retryAfterSec: Number.isFinite(ttl) && ttl > 0 ? ttl : reason === "rpm" ? 60 : 3600 };
  }
  console.error("[quota] unexpected admission reply");
  return { status: "unavailable", reason: "error" };
}

export interface GeminiQuotaView {
  /** False when usage isn't tracked (Redis missing). New AI calls then fail closed (unless dev fail-open). */
  configured: boolean;
  rpdUsed: number;
  rpdLimit: number;
  rpmLimit: number;
  /** Present when a per-user limit is configured and the caller is signed in. */
  userRpdUsed?: number;
  userRpdLimit?: number;
  /** "00:00 UTC" — the application quota's calendar-day reset. */
  resetsAt: string;
  timeZone: string;
}

/** Read-only usage for display; never increments anything. */
export async function peekGeminiQuota(userId: string | null, deps: { executor?: EvalExecutor | null; config?: QuotaConfig; now?: Date } = {}): Promise<GeminiQuotaView> {
  const cfg = deps.config ?? quotaConfig();
  const now = deps.now ?? new Date();
  const keys = quotaKeys(cfg, { operationType: "peek", operationId: "peek", attempt: 1, userId }, now);
  const view: GeminiQuotaView = {
    configured: false,
    rpdUsed: 0,
    rpdLimit: cfg.rpdLimit,
    rpmLimit: cfg.rpmLimit,
    resetsAt: `00:00 ${cfg.timeZone}`,
    timeZone: cfg.timeZone,
  };
  const executor = deps.executor === undefined ? (getRedis() as unknown as EvalExecutor | null) : deps.executor;
  if (!executor?.get) return view;
  try {
    const [rpd, user] = await Promise.all([
      executor.get(keys.rpd),
      userId && cfg.userRpdLimit !== null ? executor.get(keys.userRpd) : Promise.resolve(null),
    ]);
    view.configured = true;
    view.rpdUsed = Number(rpd ?? 0) || 0;
    if (userId && cfg.userRpdLimit !== null) {
      view.userRpdUsed = Number(user ?? 0) || 0;
      view.userRpdLimit = cfg.userRpdLimit;
    }
  } catch (err) {
    console.error("[quota] peek failed:", err instanceof Error ? err.message : err);
  }
  return view;
}
