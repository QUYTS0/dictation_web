// Test-only connection setting: no .env loading or environment mutations.
// Usage: node scripts/localdb/test-p5-assessments.cjs postgresql://postgres@127.0.0.1:55435/postgres
const { runCLI } = require("jest");

async function main() {
  const url = process.argv[2];
  if (!url || !["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(url).hostname)) {
    throw new Error("Supply a localhost-only, disposable PostgreSQL admin URL.");
  }
  const { results } = await runCLI({
    $0: "jest",
    _: ["src/__tests__/integration/p5-assessments.integration.test.ts"],
    runInBand: true,
    globals: JSON.stringify({ LOCALDB_ADMIN_URL: url }),
  }, [process.cwd()]);
  process.exitCode = results.success ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
