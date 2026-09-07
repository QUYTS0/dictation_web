import { createHash } from "crypto";

/** Deterministic hash of a single segment's raw text — stored per cache row
 *  so a read can detect "this row was computed for different text than the
 *  segment currently has" even if (transcript_id, segment_index) matches. */
export function hashSegmentText(textRaw: string): string {
  return createHash("sha256").update(textRaw, "utf8").digest("hex");
}
