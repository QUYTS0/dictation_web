/**
 * Learning Reports P5 — Gemini quota admission on a REAL Redis (Lua 5.1 EVAL).
 *
 * The production client (@upstash/redis) talks to a tiny local REST shim
 * that forwards each command over RESP to a disposable local Redis server,
 * so the exact production code path — admitGeminiAttempt → Upstash `eval` →
 * the real ADMISSION_LUA script — runs against real Redis semantics
 * (atomic scripts, INCR/EXPIRE/TTL, SET EX).
 *
 * Skipped unless LOCALREDIS_URL is set, e.g. redis://127.0.0.1:56379 (a
 * throwaway server: every test flushes it). Never point it at a shared Redis.
 */
import http from "http";
import net from "net";
import { Redis } from "@upstash/redis";

let production = false;
jest.mock("@/lib/rateLimit", () => ({
  getRedis: () => null,
  isProductionEnvironment: () => production,
}));

import { admitGeminiAttempt, peekGeminiQuota, quotaDay, type EvalExecutor, type QuotaConfig } from "@/lib/ai/quota";

const URL_ = process.env.LOCALREDIS_URL;
const d = URL_ ? describe : describe.skip;
if (!URL_) console.warn("[p5-quota-redis] skipped — LOCALREDIS_URL not set");

// ---------------------------------------------------------------- RESP client
type RespValue = string | number | null | RespValue[] | Error;
function parseResp(buf: Buffer, at: number): [RespValue, number] | null {
  if (at >= buf.length) return null;
  const end = buf.indexOf("\r\n", at);
  if (end < 0) return null;
  const type = String.fromCharCode(buf[at]);
  const line = buf.toString("utf8", at + 1, end);
  switch (type) {
    case "+":
      return [line, end + 2];
    case "-":
      return [new Error(line), end + 2];
    case ":":
      return [Number(line), end + 2];
    case "$": {
      const len = Number(line);
      if (len < 0) return [null, end + 2];
      if (buf.length < end + 2 + len + 2) return null;
      return [buf.toString("utf8", end + 2, end + 2 + len), end + 2 + len + 2];
    }
    case "*": {
      const n = Number(line);
      if (n < 0) return [null, end + 2];
      const out: RespValue[] = [];
      let pos = end + 2;
      for (let i = 0; i < n; i++) {
        const r = parseResp(buf, pos);
        if (!r) return null;
        out.push(r[0]);
        pos = r[1];
      }
      return [out, pos];
    }
    default:
      throw new Error(`bad RESP type ${type}`);
  }
}
class RespClient {
  private socket: net.Socket;
  private buf = Buffer.alloc(0);
  private queue: Array<(v: RespValue) => void> = [];
  constructor(host: string, port: number) {
    this.socket = net.createConnection({ host, port });
    this.socket.on("data", (chunk) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      for (;;) {
        const r = parseResp(this.buf, 0);
        if (!r) break;
        this.buf = this.buf.subarray(r[1]);
        this.queue.shift()?.(r[0]);
      }
    });
  }
  send(args: (string | number)[]): Promise<RespValue> {
    const parts = args.map((a) => String(a));
    const payload = `*${parts.length}\r\n` + parts.map((p) => `$${Buffer.byteLength(p)}\r\n${p}\r\n`).join("");
    return new Promise((resolve) => {
      this.queue.push(resolve);
      this.socket.write(payload);
    });
  }
  close() {
    this.socket.destroy();
  }
}

// ------------------------------------------------- Upstash-compatible REST shim
function encode(v: RespValue, base64: boolean): unknown {
  if (Array.isArray(v)) return v.map((x) => encode(x, base64));
  if (typeof v === "string" && base64 && v !== "OK") return Buffer.from(v, "utf8").toString("base64");
  return v;
}
function startShim(resp: RespClient): Promise<{ url: string; close: () => void; commands: string[][] }> {
  const commands: string[][] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const base64 = String(req.headers["upstash-encoding"] ?? "").toLowerCase() === "base64";
      const run = async (cmd: (string | number)[]) => {
        commands.push(cmd.map(String));
        const v = await resp.send(cmd);
        return v instanceof Error ? { error: v.message } : { result: encode(v, base64) };
      };
      const parsed = JSON.parse(body || "[]");
      const out = req.url?.startsWith("/pipeline") || req.url?.startsWith("/multi-exec")
        ? await Promise.all((parsed as (string | number)[][]).map(run))
        : await run(parsed as (string | number)[]);
      const isErr = !Array.isArray(out) && "error" in out;
      res.writeHead(isErr ? 400 : 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close(), commands });
    })
  );
}

const cfg = (over: Partial<QuotaConfig> = {}): QuotaConfig => ({
  env: "it",
  rpmLimit: 100,
  rpdLimit: 100,
  userRpdLimit: null,
  timeZone: "UTC",
  failOpenOutsideProduction: false,
  ...over,
});
const NOW = new Date("2026-10-05T10:15:30Z");
const req = (operationId: string, attempt: 1 | 2 = 1, userId: string | null = "user-a", operationType: "assessment" | "explanations" | "explain" | "translate" = "assessment") => ({
  operationType,
  operationId,
  attempt,
  userId,
});

d("Gemini quota admission on real Redis (Lua)", () => {
  let resp: RespClient;
  let shim: Awaited<ReturnType<typeof startShim>>;
  let executor: EvalExecutor;
  const get = async (k: string) => resp.send(["GET", k]);
  const ttl = async (k: string) => Number(await resp.send(["TTL", k]));
  const keysOf = async (pattern: string) => ((await resp.send(["KEYS", pattern])) as string[]).sort();

  beforeAll(async () => {
    const u = new URL(URL_!);
    if (!["127.0.0.1", "localhost", "::1"].includes(u.hostname)) throw new Error("LOCALREDIS_URL must be a local throwaway server");
    resp = new RespClient(u.hostname, Number(u.port || 6379));
    shim = await startShim(resp);
    executor = new Redis({ url: shim.url, token: "local-test", retry: false }) as unknown as EvalExecutor;
  });
  afterAll(() => {
    shim?.close();
    resp?.close();
  });
  beforeEach(async () => {
    await resp.send(["FLUSHDB"]);
    production = false;
  });

  it("admits once: charges RPM, shared day and user day together, records the id, and sets expiries", async () => {
    const r = await admitGeminiAttempt(req("overview:round-1:1"), { executor, config: cfg({ userRpdLimit: 5 }), now: NOW });
    expect(r).toEqual({ status: "admitted", key: "gemini:it:adm:assessment:overview:round-1:1:1" });
    const minute = Math.floor(NOW.getTime() / 60_000);
    expect(await get(`gemini:it:rpm:${minute}`)).toBe("1");
    expect(await get("gemini:it:rpd:2026-10-05")).toBe("1");
    expect(await get("gemini:it:urpd:user-a:2026-10-05")).toBe("1");
    expect(String(await get("gemini:it:adm:assessment:overview:round-1:1:1"))).toMatch(/^reserved:/);
    expect(await ttl(`gemini:it:rpm:${minute}`)).toBeGreaterThan(0);
    expect(await ttl("gemini:it:rpd:2026-10-05")).toBeGreaterThan(86_400);
    expect(await ttl("gemini:it:adm:assessment:overview:round-1:1:1")).toBeGreaterThan(86_400);
    // The real script ran through the production client's EVAL.
    expect(shim.commands.some((c) => c[0].toLowerCase() === "eval")).toBe(true);
  });

  it("a repeated id is not charged again and does not authorize another call (duplicate)", async () => {
    await admitGeminiAttempt(req("overview:round-1:1"), { executor, config: cfg(), now: NOW });
    const again = await admitGeminiAttempt(req("overview:round-1:1"), { executor, config: cfg(), now: NOW });
    expect(again.status).toBe("duplicate");
    expect(await get("gemini:it:rpd:2026-10-05")).toBe("1");
  });

  it("a parse retry (attempt 2) is a separate admission and is charged separately", async () => {
    expect((await admitGeminiAttempt(req("overview:round-1:1", 1), { executor, config: cfg(), now: NOW })).status).toBe("admitted");
    expect((await admitGeminiAttempt(req("overview:round-1:1", 2), { executor, config: cfg(), now: NOW })).status).toBe("admitted");
    expect(await get("gemini:it:rpd:2026-10-05")).toBe("2");
  });

  it("at the boundary a rejection increments nothing and records no id", async () => {
    const c = cfg({ rpdLimit: 3 });
    for (let i = 1; i <= 3; i++) expect((await admitGeminiAttempt(req(`overview:r:${i}`), { executor, config: c, now: NOW })).status).toBe("admitted");
    const denied = await admitGeminiAttempt(req("overview:r:4"), { executor, config: c, now: NOW });
    expect(denied).toMatchObject({ status: "denied", reason: "rpd" });
    expect(await get("gemini:it:rpd:2026-10-05")).toBe("3");
    expect(await get(`gemini:it:rpm:${Math.floor(NOW.getTime() / 60_000)}`)).toBe("3");
    expect(await get("gemini:it:adm:assessment:overview:r:4:1")).toBeNull();
  });

  it("RPM and the per-user daily limit reject independently; another user is still admitted", async () => {
    const rpm = cfg({ rpmLimit: 1 });
    await admitGeminiAttempt(req("a:1"), { executor, config: rpm, now: NOW });
    expect(await admitGeminiAttempt(req("a:2"), { executor, config: rpm, now: NOW })).toMatchObject({ status: "denied", reason: "rpm" });
    // A new minute has its own RPM key.
    expect((await admitGeminiAttempt(req("a:3"), { executor, config: rpm, now: new Date(NOW.getTime() + 61_000) })).status).toBe("admitted");

    await resp.send(["FLUSHDB"]);
    const user = cfg({ userRpdLimit: 1 });
    expect((await admitGeminiAttempt(req("b:1", 1, "user-a"), { executor, config: user, now: NOW })).status).toBe("admitted");
    expect(await admitGeminiAttempt(req("b:2", 1, "user-a"), { executor, config: user, now: NOW })).toMatchObject({ status: "denied", reason: "user_rpd" });
    expect((await admitGeminiAttempt(req("b:3", 1, "user-b"), { executor, config: user, now: NOW })).status).toBe("admitted");
    // Anonymous (signed-out translation) uses the shared limits only.
    expect((await admitGeminiAttempt(req("b:4", 1, null, "translate"), { executor, config: user, now: NOW })).status).toBe("admitted");
    expect(await get("gemini:it:rpd:2026-10-05")).toBe("3");
  });

  it("concurrent admissions never exceed the cap (25 at once, cap 10)", async () => {
    const c = cfg({ rpdLimit: 10 });
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => admitGeminiAttempt(req(`c:${i}`), { executor, config: c, now: NOW })));
    expect(results.filter((r) => r.status === "admitted")).toHaveLength(10);
    expect(results.filter((r) => r.status === "denied")).toHaveLength(15);
    expect(await get("gemini:it:rpd:2026-10-05")).toBe("10");
  });

  it("ids never collide across rounds, users, operation types and environments", async () => {
    const c = cfg();
    await admitGeminiAttempt(req("overview:round-1:1"), { executor, config: c, now: NOW });
    expect((await admitGeminiAttempt(req("overview:round-2:1"), { executor, config: c, now: NOW })).status).toBe("admitted"); // same generation number, other round
    expect((await admitGeminiAttempt(req("overview:round-1:1", 1, "user-b", "explanations"), { executor, config: c, now: NOW })).status).toBe("admitted");
    expect((await admitGeminiAttempt(req("overview:round-1:1", 1, "user-a", "translate"), { executor, config: c, now: NOW })).status).toBe("admitted");
    expect((await admitGeminiAttempt(req("overview:round-1:1"), { executor, config: cfg({ env: "preview" }), now: NOW })).status).toBe("admitted");
    expect(await keysOf("gemini:*:adm:*")).toHaveLength(5);
    // Environments keep separate counters too.
    expect(await get("gemini:preview:rpd:2026-10-05")).toBe("1");
    expect(await get("gemini:it:rpd:2026-10-05")).toBe("4");
  });

  it("a lost admission response stays spent: the retry with the same id is a duplicate (no charge, no call)", async () => {
    const lossy: EvalExecutor = {
      eval: async (...args) => {
        await executor.eval(...args); // the script ran and charged…
        throw new Error("socket hang up"); // …but the reply was lost
      },
    };
    expect(await admitGeminiAttempt(req("lost:1"), { executor: lossy, config: cfg(), now: NOW })).toEqual({ status: "unavailable", reason: "error" });
    expect(await get("gemini:it:rpd:2026-10-05")).toBe("1");
    expect((await admitGeminiAttempt(req("lost:1"), { executor, config: cfg(), now: NOW })).status).toBe("duplicate");
    expect(await get("gemini:it:rpd:2026-10-05")).toBe("1");
  });

  it("Redis failure fails closed in production even with the fail-open flag; dev fail-open needs the flag", async () => {
    const dead = new Redis({ url: "http://127.0.0.1:9", token: "x", retry: false }) as unknown as EvalExecutor;
    production = true;
    expect(await admitGeminiAttempt(req("x:1"), { executor: dead, config: cfg({ failOpenOutsideProduction: true }), now: NOW })).toEqual({ status: "unavailable", reason: "error" });
    expect(await admitGeminiAttempt(req("x:1"), { executor: null, config: cfg({ failOpenOutsideProduction: true }), now: NOW })).toEqual({ status: "unavailable", reason: "not_configured" });
    production = false;
    expect((await admitGeminiAttempt(req("x:1"), { executor: dead, config: cfg(), now: NOW })).status).toBe("unavailable");
    expect((await admitGeminiAttempt(req("x:1"), { executor: dead, config: cfg({ failOpenOutsideProduction: true }), now: NOW })).status).toBe("unmetered");
  });

  it("peek reads usage without incrementing; days are calendar days in the configured time zone", async () => {
    await admitGeminiAttempt(req("p:1"), { executor, config: cfg({ userRpdLimit: 4 }), now: NOW });
    const before = await keysOf("gemini:*");
    const view = await peekGeminiQuota("user-a", { executor, config: cfg({ userRpdLimit: 4 }), now: NOW });
    expect(view).toMatchObject({ configured: true, rpdUsed: 1, rpdLimit: 100, userRpdUsed: 1, userRpdLimit: 4, resetsAt: "00:00 UTC" });
    expect(await keysOf("gemini:*")).toEqual(before);
    expect(await get("gemini:it:rpd:2026-10-05")).toBe("1");
    // 23:30 UTC on Oct 5 is already Oct 6 in Ho Chi Minh City (UTC+7).
    expect(quotaDay(new Date("2026-10-05T23:30:00Z"), "UTC")).toBe("2026-10-05");
    expect(quotaDay(new Date("2026-10-05T23:30:00Z"), "Asia/Ho_Chi_Minh")).toBe("2026-10-06");
  });
});
