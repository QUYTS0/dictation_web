/**
 * Which database write path the practice routes use in THIS deployment
 * (save-progress, session/restart, dictation/check). Fixed per deployment by
 * the PRACTICE_WRITE_PATH environment variable — never switched at runtime
 * and never used as a fallback when a call fails:
 *
 *   legacy        — Phase 2 gate-aware bridges (fn_legacy_*). Only for the
 *                   Phase 3 PREPARATION release, which must be live before
 *                   the cutover begins (supabase/PHASE3_RUNBOOK.md, step 1).
 *   authoritative — Phase 3 functions (fn_record_dictation_attempt,
 *                   fn_create_or_get_active_round, fn_update_resume_position,
 *                   fn_restart_round). The default: the only valid setting
 *                   once fn_phase3_activate() has run (the bridges no longer
 *                   exist).
 */
export type PracticeWritePath = "legacy" | "authoritative";

export function getPracticeWritePath(): PracticeWritePath {
  return process.env.PRACTICE_WRITE_PATH === "legacy" ? "legacy" : "authoritative";
}
