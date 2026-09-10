#!/usr/bin/env node
/**
 * Repairs vocabulary_items rows contaminated by the "ⓘ info-icon leaking
 * into selected transcript text" bug (see ScriptTab.tsx's mobile "show
 * meaning" button + getSelectedTranscriptText in
 * src/app/dictation/[videoId]/helpers.ts for the fix that stops new rows
 * from being contaminated).
 *
 * Affected rows are found by RELIABLE SOURCE EVIDENCE ONLY: the exact
 * "ⓘ" glyph (U+24D8 CIRCLED LATIN SMALL LETTER I) appearing in `term` or
 * `sentence_context`. That glyph is not something real English/Vietnamese
 * sentences ever contain on their own, so this match has effectively no
 * false positives — unlike scanning translations for "(i)", which IS
 * legitimate text in plenty of real sentences (numbered sub-points, etc.)
 * and is deliberately NOT used as a detection signal here.
 *
 * What this script does per affected row:
 *   1. Strips the exact "ⓘ" character from `term`/`sentence_context` (never
 *      a broader "remove every symbol/parenthesis" regex) and recomputes
 *      `normalized_term`.
 *   2. Skips (and reports) any row whose cleaned normalized_term would
 *      collide with a DIFFERENT existing row's (user_id, video_id,
 *      segment_index, normalized_term) — the app's real unique constraint
 *      (see supabase/migrations/002_auth_features.sql). Repairing such a
 *      row would require merging two vocabulary records, which this script
 *      deliberately never does; it's left for manual resolution instead.
 *   3. Never touches `translation`. A translation produced from
 *      contaminated input may itself be wrong, but guessing a fix (or
 *      blindly stripping "(i)" from it) risks corrupting a translation that
 *      was actually fine, or silently replacing a wrong one with another
 *      guess. Every repaired row with a non-null translation is listed in
 *      the report as needing manual review/retranslation.
 *   4. Never touches learning progress (next_review_at, interval_days,
 *      ease_factor, repetitions, last_reviewed_at), created_at, id, or any
 *      image/canonical/learning-pattern field.
 *   5. With --apply, also deletes the specific contaminated
 *      vocabulary_translation_cache rows (matched the same way, by the
 *      exact glyph in normalized_text) so future lookups of the clean
 *      phrase can never hit a polluted cache row — the next lookup simply
 *      performs a fresh translation and caches it correctly.
 *
 * Safety: defaults to a dry run that only prints what it *would* do. Pass
 * --apply to actually write. This never touches vocabulary belonging to
 * rows that don't contain the exact contamination glyph — no bulk rewrite,
 * no bulk retranslation.
 *
 * Usage:
 *   node scripts/repair-info-icon-vocab.mjs            # dry run (default)
 *   node scripts/repair-info-icon-vocab.mjs --apply    # perform the writes
 *
 * Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the
 * environment (loaded from .env.local if present and not already set).
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const INFO_ICON = "ⓘ"; // ⓘ — the exact, and only, contamination signal this script trusts.
const VOCAB_TABLE = "vocabulary_items";
const CACHE_TABLE = "vocabulary_translation_cache";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function loadDotEnvLocal() {
  const envPath = path.join(repoRoot, ".env.local");
  if (!existsSync(envPath)) return;
  const contents = readFileSync(envPath, "utf8");
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

/**
 * Snapshot of normalizeVocabularyTerm (src/lib/utils/vocabulary.ts) +
 * normalizeText(text, "relaxed") (src/lib/utils/text.ts). Duplicated rather
 * than imported because this is a standalone Node script with no build
 * step, so it can't import the app's TypeScript modules — same tradeoff
 * src/lib/translate.ts already makes for stripEdgePunctuation. Keep in sync
 * with those two functions if their normalization rules ever change.
 */
function normalizeVocabularyTermLocal(term) {
  let result = term
    .replace(/[‘’`´]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/–|—/g, "-")
    .replace(/…/g, "...");
  result = result.trim().normalize("NFC").replace(/\s+/g, " ");
  result = result
    .replace(/[^\w\s']|_/g, "")
    .replace(/'\s/g, " ")
    .toLowerCase();
  result = result.trim().normalize("NFC").replace(/\s+/g, " ");
  return result.trim();
}

function stripInfoIcon(text) {
  return text.split(INFO_ICON).join("").replace(/\s+/g, " ").trim();
}

async function main() {
  loadDotEnvLocal();
  const apply = process.argv.includes("--apply");

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    console.error(
      "Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Set them in the environment or .env.local."
    );
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log(apply ? "Running in APPLY mode — this will write to the database.\n" : "Running in DRY-RUN mode — no writes will be made. Pass --apply to write.\n");

  const { data: rows, error } = await supabase
    .from(VOCAB_TABLE)
    .select("id,user_id,video_id,segment_index,term,normalized_term,sentence_context,translation,canonical_form")
    .or(`term.ilike.%${INFO_ICON}%,sentence_context.ilike.%${INFO_ICON}%`);

  if (error) {
    console.error("Failed to query vocabulary_items:", error.message);
    process.exit(1);
  }

  if (!rows || rows.length === 0) {
    console.log("No contaminated rows found (no term/sentence_context contains the ⓘ glyph).");
    return;
  }

  console.log(`Found ${rows.length} row(s) containing the ⓘ contamination glyph.\n`);

  const repaired = [];
  const skippedCollisions = [];
  const needsTranslationReview = [];

  for (const row of rows) {
    const cleanTerm = stripInfoIcon(row.term);
    const cleanSentenceContext = stripInfoIcon(row.sentence_context);
    const cleanNormalizedTerm = normalizeVocabularyTermLocal(cleanTerm);

    if (!cleanTerm || !cleanNormalizedTerm) {
      needsTranslationReview.push({
        id: row.id,
        reason: "cleaning the term left it empty — needs manual correction, not automated repair",
        term: row.term,
      });
      continue;
    }

    // Guard against creating a duplicate under the app's real unique
    // constraint (user_id, video_id, segment_index, normalized_term) —
    // never auto-merge, just report it.
    const { data: collision, error: collisionError } = await supabase
      .from(VOCAB_TABLE)
      .select("id")
      .eq("user_id", row.user_id)
      .eq("video_id", row.video_id)
      .eq("segment_index", row.segment_index)
      .eq("normalized_term", cleanNormalizedTerm)
      .neq("id", row.id)
      .maybeSingle();

    if (collisionError) {
      console.error(`  [skip] ${row.id}: collision check failed — ${collisionError.message}`);
      continue;
    }

    if (collision) {
      skippedCollisions.push({ id: row.id, collidesWithId: collision.id, cleanTerm });
      continue;
    }

    if (apply) {
      const { error: updateError } = await supabase
        .from(VOCAB_TABLE)
        .update({
          term: cleanTerm,
          normalized_term: cleanNormalizedTerm,
          sentence_context: cleanSentenceContext,
        })
        .eq("id", row.id);
      if (updateError) {
        console.error(`  [error] ${row.id}: update failed — ${updateError.message}`);
        continue;
      }
    }

    repaired.push({ id: row.id, before: row.term, after: cleanTerm });
    if (row.translation) {
      needsTranslationReview.push({
        id: row.id,
        reason: "term was contaminated, so its translation may be too — review/retranslate manually",
        term: cleanTerm,
        translation: row.translation,
      });
    }
  }

  if (apply && repaired.length > 0) {
    const { error: cacheError } = await supabase
      .from(CACHE_TABLE)
      .delete()
      .ilike("normalized_text", `%${INFO_ICON}%`);
    if (cacheError) {
      console.error("Failed to invalidate contaminated translation cache rows:", cacheError.message);
    } else {
      console.log("Invalidated contaminated vocabulary_translation_cache rows.\n");
    }
  }

  console.log(`${apply ? "Repaired" : "Would repair"} ${repaired.length} row(s):`);
  for (const r of repaired) console.log(`  ${r.id}: "${r.before}" -> "${r.after}"`);

  if (skippedCollisions.length > 0) {
    console.log(`\nSkipped ${skippedCollisions.length} row(s) — cleaning would collide with an existing item (needs manual merge decision, not automated):`);
    for (const s of skippedCollisions) console.log(`  ${s.id} would collide with ${s.collidesWithId} (clean term: "${s.cleanTerm}")`);
  }

  if (needsTranslationReview.length > 0) {
    console.log(`\n${needsTranslationReview.length} record(s) need manual review:`);
    for (const n of needsTranslationReview) {
      console.log(`  ${n.id}: ${n.reason}${n.translation ? ` (current translation: "${n.translation}")` : ""}`);
    }
  }

  if (!apply) {
    console.log("\nDry run only — re-run with --apply to write these changes.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
