/**
 * Disposable real-PostgreSQL harness for the Phase 3 integration suites.
 *
 * Point LOCALDB_ADMIN_URL at an admin connection of a LOCAL, THROWAWAY
 * PostgreSQL server (PG 15+), e.g.:
 *   - any local PostgreSQL 15+ built with ICU (e.g. the embedded server
 *     described in supabase/PHASE3_RUNBOOK.md §9), or
 *   - the database server of `supabase start`
 *     (postgresql://postgres:postgres@127.0.0.1:54322/postgres).
 * Either way the Supabase shim (scripts/localdb/supabase-shim.sql) is
 * applied to the fresh per-suite database first — a newly created database
 * has no `auth` schema even on a Supabase stack; the shim is idempotent
 * about roles that already exist. (LOCALDB_SKIP_SHIM=1 skips it for a
 * server whose template database already carries the Supabase schemas.)
 *
 * Each suite creates its OWN database (`it_<name>_<random>`), applies the
 * shim + migrations 001..N, and drops it afterwards. The harness refuses any
 * host that is not localhost/127.0.0.1/::1, so it can never touch a remote
 * (e.g. the user's linked Supabase) project.
 *
 * What this verifies: real PostgreSQL semantics (plpgsql, locks, RLS, GRANTs,
 * transactions). Identity is switched exactly as PostgREST does it —
 * `SET LOCAL ROLE` + `request.jwt.claims` — but PostgREST/GoTrue themselves
 * are not involved.
 */
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Client } = require("pg") as typeof import("pg");
export type PgClient = import("pg").Client;

export const ADMIN_URL = process.env.LOCALDB_ADMIN_URL;
export const HAS_LOCALDB = !!ADMIN_URL;

const ROOT = path.resolve(__dirname, "../../../..");
const MIGRATIONS_DIR = path.join(ROOT, "supabase", "migrations");
const SHIM = path.join(ROOT, "scripts", "localdb", "supabase-shim.sql");

function assertLocal(url: string) {
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error(`LOCALDB_ADMIN_URL must point at a local disposable server, got host "${host}"`);
  }
}

export function migrationFiles(upTo: number): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}_.*\.sql$/.test(f) && Number(f.slice(0, 3)) <= upTo)
    .sort();
}

export interface TestDb {
  url: string;
  name: string;
  connect(): Promise<PgClient>;
  drop(): Promise<void>;
}

export async function createTestDb(label: string, upTo = 999): Promise<TestDb> {
  if (!ADMIN_URL) throw new Error("LOCALDB_ADMIN_URL not set");
  assertLocal(ADMIN_URL);
  const name = `it_${label}_${randomUUID().slice(0, 8)}`.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();

  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const dbUrl = url.toString();

  const c = new Client({ connectionString: dbUrl });
  await c.connect();
  try {
    if (!process.env.LOCALDB_SKIP_SHIM) {
      await c.query(fs.readFileSync(SHIM, "utf8"));
    }
    for (const f of migrationFiles(upTo)) {
      try {
        await c.query(fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8"));
      } catch (e) {
        throw new Error(`migration ${f} failed: ${(e as Error).message}`);
      }
    }
  } finally {
    await c.end();
  }

  return {
    url: dbUrl,
    name,
    async connect() {
      const client = new Client({ connectionString: dbUrl });
      await client.connect();
      return client;
    },
    async drop() {
      const a = new Client({ connectionString: ADMIN_URL });
      await a.connect();
      await a.query(`drop database if exists ${name} with (force)`);
      await a.end();
    },
  };
}

/** Applies one migration file (by number) to an existing test database. */
export async function applyMigration(c: PgClient, num: number): Promise<void> {
  const f = fs.readdirSync(MIGRATIONS_DIR).find((x) => x.startsWith(String(num).padStart(3, "0") + "_"));
  if (!f) throw new Error(`migration ${num} not found`);
  await c.query(fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8"));
}

/** Opens a transaction as `role`/`userId` and leaves it open (caller commits). */
export async function beginAs(c: PgClient, role: "anon" | "authenticated" | "service_role", userId: string | null) {
  await c.query("begin");
  await c.query(`set local role ${role}`);
  const claims = userId ? { sub: userId, role } : { role };
  await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
}

export async function backendPid(c: PgClient): Promise<number> {
  return (await c.query("select pg_backend_pid() as pid")).rows[0].pid;
}

/**
 * Resolves once backend `pid` is waiting on a heavyweight lock (observed in
 * pg_stat_activity) — deterministic proof that a statement is blocked,
 * instead of guessing with a sleep. Rejects after `timeoutMs`.
 */
export async function waitUntilBlocked(observer: PgClient, pid: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await observer.query(
      "select wait_event_type from pg_stat_activity where pid = $1",
      [pid]
    );
    if (r.rows[0]?.wait_event_type === "Lock") return;
    if (Date.now() > deadline) throw new Error(`backend ${pid} never blocked on a lock`);
    await new Promise((res) => setTimeout(res, 25));
  }
}

/** Inserts an auth user (the 001 trigger mirrors it into public.users). */
export async function createUser(c: PgClient): Promise<string> {
  const id = randomUUID();
  await c.query(`insert into auth.users (id, email) values ($1, $2)`, [id, `${id}@example.test`]);
  return id;
}

/**
 * Runs `fn` inside a transaction as `role`, with `request.jwt.claims` set for
 * `userId` — exactly how PostgREST executes a request. Always rolls back
 * when `rollback` is set; otherwise commits (or rolls back on error).
 */
export async function asRole<T>(
  c: PgClient,
  role: "anon" | "authenticated" | "service_role",
  userId: string | null,
  fn: () => Promise<T>,
  opts: { rollback?: boolean } = {}
): Promise<T> {
  await c.query("begin");
  try {
    await c.query(`set local role ${role}`);
    const claims = userId ? { sub: userId, role } : { role };
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
    const out = await fn();
    await c.query(opts.rollback ? "rollback" : "commit");
    return out;
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  }
}

/** Calls a function as an authenticated user; returns its jsonb result. */
export async function rpcAs<T = Record<string, unknown>>(
  c: PgClient,
  userId: string,
  sql: string,
  params: unknown[] = [],
  role: "anon" | "authenticated" | "service_role" = "authenticated"
): Promise<T> {
  return asRole(c, role, userId, async () => {
    const r = await c.query(sql, params);
    return Object.values(r.rows[0] ?? {})[0] as T;
  });
}

export async function errorOf(p: Promise<unknown>): Promise<{ message: string; code?: string } | null> {
  try {
    await p;
    return null;
  } catch (e) {
    const err = e as { message: string; code?: string };
    return { message: err.message, code: err.code };
  }
}

/** Publishes a ready transcript through the real Phase 0 function (owner). */
export async function publishTranscript(
  c: PgClient,
  videoId: string,
  texts: string[],
  fingerprint = `fp-${randomUUID()}`
): Promise<string> {
  const segments = texts.map((text, i) => ({
    segmentIndex: i,
    start: i * 2,
    end: i * 2 + 2,
    text,
    textNormalized: text.toLowerCase().replace(/[^a-z0-9' ]/g, "").trim(),
  }));
  await c.query(`insert into videos (youtube_video_id, title) values ($1, $1) on conflict (youtube_video_id) do nothing`, [videoId]);
  const r = await c.query(
    `select (fn_publish_transcript_revision($1, 'en', 'manual', $2, $3::jsonb, $4)).id as id`,
    [videoId, texts.join(" "), JSON.stringify(segments), fingerprint]
  );
  return r.rows[0].id as string;
}

/** Owner-side activation helpers mirroring the runbook, for rehearsals. */
export async function runCutover(c: PgClient, until: "restricted" | "paused" | "backfilled" | "activated") {
  await c.query("select fn_phase3_restrict_direct_writes()");
  if (until === "restricted") return;
  await c.query("select fn_phase3_close_gate()");
  if (until === "paused") return;
  await c.query("select fn_phase3_backfill()");
  if (until === "backfilled") return;
  await c.query("select fn_phase3_activate()");
}
