/**
 * TypeScript ↔ SQL grading parity on REAL PostgreSQL.
 *
 * Runs identical inputs through src/lib/utils/text.ts (normalizeText,
 * checkAnswer, classifyError) and through the SQL functions installed by
 * migration 037 (fn_normalize_dictation_text, fn_classify_dictation_error),
 * for every match mode, and requires identical normalized strings,
 * correctness decisions and error types. Fixtures + a seeded fuzz corpus.
 * Skipped unless LOCALDB_ADMIN_URL is set (see localdb/harness.ts).
 */
import { HAS_LOCALDB, createTestDb, type TestDb, type PgClient } from "./localdb/harness";
import { normalizeText, checkAnswer, classifyError } from "@/lib/utils/text";
import type { MatchMode } from "@/lib/types";

const d = HAS_LOCALDB ? describe : describe.skip;
if (!HAS_LOCALDB) console.warn("[phase3-scoring-parity] skipped — LOCALDB_ADMIN_URL not set");

const MODES: MatchMode[] = ["exact", "relaxed", "learning"];

// [expected, user] pairs.
const FIXTURES: Array<[string, string]> = [
  ["Hello world.", "hello world"],
  ["Hello world.", "Hello World"],
  ["  Hello   world  ", "Hello world"],
  ["Hello\tworld\n", "hello world"],
  ["Hello world", "hello world"], // NBSP (the 032 divergence)
  ["Hello world", "hello world"], // em space
  ["Hello　world", "hello world"], // ideographic space
  ["﻿Hello world", "hello world"], // BOM
  ["Hello world", "hello world"], // line separator
  ["It’s fine", "it's fine"], // curly apostrophe
  ["It`s fine", "It's fine"],
  ["It´s fine", "its fine"],
  ["“Quoted” text", '"quoted" text'],
  ["Wait—what?", "wait what"],
  ["Wait–what", "wait-what"],
  ["Well… okay", "well okay"],
  ["Well... okay", "well okay"],
  ["I can't do it.", "I cant do it"],
  ["I can't do it.", "i can't do it"],
  ["They're here", "theyre here"],
  ["rock 'n' roll", "rock n roll"],
  ["the dogs' bones", "the dogs bones"],
  ["It costs $5,000.", "it costs 5000"],
  ["Room 101", "room 101"],
  ["under_score", "underscore"],
  ["Café au lait", "cafe au lait"],
  ["Café au lait", "Café au lait"], // combining acute → NFC
  ["naïve résumé", "naive resume"],
  ["Straße", "strasse"],
  ["Emoji 😀 here", "emoji here"],
  ["", ""],
  ["   ", ""],
  ["Hello", "   "],
  ["One two three", "one two"],
  ["One two", "one two three"],
  ["One two", "one too"],
  ["Hello, world!", "Hello world"],
  ["HELLO", "hello"],
  ["mixed CASE Words", "Mixed case words"],
  ["tab\tseparated\twords", "tab separated words"],
  ["x ' y", "x y"],
  ["don't stop", "dont stop"],
];

// Deterministic PRNG (mulberry32).
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ALPHABET = [
  ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  ..."  .,!?;:'\"-_()[]$%&",
  "\t", "\n", "\r", " ", " ", " ", " ", "　", "﻿", " ",
  "‘", "’", "“", "”", "–", "—", "…", "`", "´",
  "é", "ü", "ß", "ñ", "́", "̈", "Ω", "中", "😀",
];
function fuzzCorpus(n: number, seed: number): Array<[string, string]> {
  const r = rng(seed);
  const word = () => Array.from({ length: 1 + Math.floor(r() * 6) }, () => ALPHABET[Math.floor(r() * ALPHABET.length)]).join("");
  const sentence = () => Array.from({ length: Math.floor(r() * 6) }, word).join(r() < 0.8 ? " " : " ");
  const out: Array<[string, string]> = [];
  for (let i = 0; i < n; i++) {
    const a = sentence();
    // Half the time derive the answer from the expected text so matches occur.
    const b = r() < 0.5 ? a.toLowerCase().replace(/[.,!?]/g, r() < 0.5 ? "" : " ") : sentence();
    out.push([a, b]);
  }
  return out;
}

async function sqlNormalize(c: PgClient, texts: string[], mode: MatchMode): Promise<string[]> {
  const r = await c.query(
    `select fn_normalize_dictation_text(t, $2) as n from unnest($1::text[]) with ordinality as u(t, i) order by i`,
    [texts, mode]
  );
  return r.rows.map((x) => x.n as string);
}
async function sqlClassify(c: PgClient, pairs: Array<[string, string]>): Promise<string[]> {
  const r = await c.query(
    `select fn_classify_dictation_error(e, u) as t
       from unnest($1::text[], $2::text[]) with ordinality as x(e, u, i) order by i`,
    [pairs.map((p) => p[0]), pairs.map((p) => p[1])]
  );
  return r.rows.map((x) => x.t as string);
}

async function assertParity(c: PgClient, pairs: Array<[string, string]>) {
  const mismatches: string[] = [];
  for (const mode of MODES) {
    const exp = await sqlNormalize(c, pairs.map((p) => p[0]), mode);
    const usr = await sqlNormalize(c, pairs.map((p) => p[1]), mode);
    const incorrect: Array<[string, string]> = [];
    const incorrectTs: string[] = [];
    pairs.forEach(([e, u], i) => {
      const ts = checkAnswer(e, u, mode);
      if (normalizeText(e, mode) !== exp[i]) mismatches.push(`${mode} norm expected ${JSON.stringify(e)}: ts=${JSON.stringify(ts.normalizedExpected)} sql=${JSON.stringify(exp[i])}`);
      if (normalizeText(u, mode) !== usr[i]) mismatches.push(`${mode} norm user ${JSON.stringify(u)}: ts=${JSON.stringify(ts.normalizedUser)} sql=${JSON.stringify(usr[i])}`);
      const sqlCorrect = exp[i] === usr[i];
      if (ts.isCorrect !== sqlCorrect) mismatches.push(`${mode} correctness ${JSON.stringify([e, u])}: ts=${ts.isCorrect} sql=${sqlCorrect}`);
      if (!ts.isCorrect) {
        incorrect.push([ts.normalizedExpected, ts.normalizedUser]);
        incorrectTs.push(ts.errorType);
      }
    });
    const sqlTypes = await sqlClassify(c, incorrect);
    incorrect.forEach(([e, u], i) => {
      // checkAnswer's errorType == classifyError(normalizedExpected, normalizedUser)
      expect(classifyError(e, u)).toBe(incorrectTs[i]);
      if (sqlTypes[i] !== incorrectTs[i]) mismatches.push(`${mode} errorType ${JSON.stringify([e, u])}: ts=${incorrectTs[i]} sql=${sqlTypes[i]}`);
    });
  }
  expect(mismatches).toEqual([]);
}

d("TypeScript ↔ SQL grading parity (real PostgreSQL)", () => {
  let db: TestDb;
  let c: PgClient;
  beforeAll(async () => {
    db = await createTestDb("parity");
    c = await db.connect();
  }, 120_000);
  afterAll(async () => {
    await c?.end();
    await db?.drop();
  });

  it("fixtures: normalized text, correctness and error type are identical in all three modes", async () => {
    await assertParity(c, FIXTURES);
  });

  it("seeded fuzz corpus (3 seeds × 400 pairs) is identical in all three modes", async () => {
    for (const seed of [1, 42, 20260925]) {
      await assertParity(c, fuzzCorpus(400, seed));
    }
  });

  it("the 036-era (032) normalizer really diverged — documents what 037 fixed", async () => {
    // Reproduce the 032 body inline and show the NBSP case differs from TS.
    const r = await c.query(
      `select lower(regexp_replace(regexp_replace(btrim(regexp_replace(btrim($1), '\\s+', ' ', 'g')), '[^A-Za-z0-9\\s'']', '', 'g'), '\\s+', ' ', 'g')) as old`,
      ["Hello world"]
    );
    expect(normalizeText("Hello world", "relaxed")).toBe("hello world");
    expect(r.rows[0].old).not.toBe("hello world");
  });
});
