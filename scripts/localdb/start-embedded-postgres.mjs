// Starts a DISPOSABLE local PostgreSQL 17 server (real PostgreSQL binaries
// from the `embedded-postgres` npm package) for the real-database test tier.
// Never used by the app; never points at Supabase.
//
// One-time setup (not added to package.json on purpose):
//   npm install --no-save embedded-postgres@17.9.0-beta.17
// Run (keeps running until Ctrl+C; data dir defaults to ./.localdb-data):
//   node scripts/localdb/start-embedded-postgres.mjs
// Then, in another terminal:
//   LOCALDB_ADMIN_URL=postgresql://postgres:postgres@127.0.0.1:55432/postgres npx jest src/__tests__/integration/phase3
import fs from "node:fs";
import path from "node:path";

const { default: EmbeddedPostgres } = await import("embedded-postgres").catch(() => {
  console.error("embedded-postgres is not installed: npm install --no-save embedded-postgres@17.9.0-beta.17");
  process.exit(1);
});

const dir = path.resolve(process.env.LOCALDB_DATA_DIR ?? ".localdb-data");
const port = Number(process.env.LOCALDB_PORT ?? 55432);
const fresh = !fs.existsSync(dir);
const pg = new EmbeddedPostgres({
  databaseDir: dir,
  user: "postgres",
  password: "postgres",
  port,
  persistent: true,
  initdbFlags: ["--encoding=UTF8", "--locale=C"],
});
if (fresh) await pg.initialise();
await pg.start();
console.log(`READY LOCALDB_ADMIN_URL=postgresql://postgres:postgres@127.0.0.1:${port}/postgres`);
const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
setInterval(() => {}, 1 << 30);
