/**
 * Phase 8 — retirement guard. The pre-cutover write path is gone: the
 * fn_legacy_* bridges were dropped by fn_phase3_activate() (Phase 3), and
 * Phase 8 removed the runtime branch that could still select them
 * (PRACTICE_WRITE_PATH=legacy). This keeps it gone: no runtime file may
 * call a retired bridge, read the retired switch, or send a client
 * completion claim with a checkpoint save.
 *
 * Migrations, operator scripts and the upgrade/rehearsal integration tests
 * legitimately keep these names (historical artifacts) — only application
 * runtime code under src/app and src/lib is scanned.
 */
import fs from "fs";
import path from "path";

const SRC = path.join(__dirname, "..");
const RUNTIME_DIRS = ["app", "lib", "components", "hooks", "store", "context"].map((d) => path.join(SRC, d));

function runtimeFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return runtimeFiles(full);
    return /\.(ts|tsx)$/.test(e.name) ? [full] : [];
  });
}
const files = RUNTIME_DIRS.flatMap(runtimeFiles);
const offenders = (pattern: RegExp) =>
  files.filter((f) => pattern.test(fs.readFileSync(f, "utf8"))).map((f) => path.relative(SRC, f).replace(/\\/g, "/"));

describe("Phase 8 — retired pre-cutover write path stays retired", () => {
  it("scans the real runtime tree", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("no runtime code calls a retired fn_legacy_* bridge", () => {
    expect(offenders(/rpc\(\s*["'`]fn_legacy_/)).toEqual([]);
  });

  it("no runtime code reads the retired PRACTICE_WRITE_PATH switch", () => {
    expect(offenders(/process\.env\.PRACTICE_WRITE_PATH|getPracticeWritePath/)).toEqual([]);
  });

  it("the removed switch and bridge-error modules do not exist", () => {
    expect(fs.existsSync(path.join(SRC, "lib/practice/writePath.ts"))).toBe(false);
    expect(fs.existsSync(path.join(SRC, "lib/supabase/legacyBridgeErrors.ts"))).toBe(false);
  });

  it("the practice client never sends a completion claim with a checkpoint save", () => {
    const api = fs.readFileSync(path.join(SRC, "app/dictation/[videoId]/api.ts"), "utf8");
    const save = api.slice(api.indexOf("export async function saveProgress"), api.indexOf("export async function fetchResumeSession"));
    expect(save).not.toMatch(/\bstatus\b|\baccuracy\b|\btotalAttempts\b/);
    const session = fs.readFileSync(path.join(SRC, "app/dictation/[videoId]/useDictationSession.ts"), "utf8");
    expect(session).not.toMatch(/triggerAutoSave\([^)]*"completed"/);
  });
});
