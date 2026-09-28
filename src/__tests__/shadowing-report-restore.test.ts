import { NextRequest } from "next/server";

// Report fidelity, data path: what the live report uses → what is stored
// (the real Word Match route / toStoredAzureResult / recovery token) → the
// read DTO → what the page restores. The SQL itself passes the stored
// jsonb through unchanged (integration/phase4-shadowing covers the reads);
// here the stored detail is JSON round-tripped the way jsonb returns it.
const serviceRpc = jest.fn();
const getUser = jest.fn();
const rows: Record<string, unknown> = {};

function builder(table: string) {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq"]) b[m] = () => b;
  b.maybeSingle = async () => ({ data: rows[table] ?? null, error: null });
  return b;
}

jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser }, rpc: jest.fn(), from: (t: string) => builder(t) }),
  createServiceClient: () => ({ rpc: serviceRpc }),
}));

import { PATCH } from "@/app/api/practice/attempt/[attemptId]/word-match/route";
import { toStoredAzureResult } from "@/lib/practice/azureEvaluation";
import { issueRecoveryToken, verifyRecoveryToken, type RecoveryResult } from "@/lib/practice/recoveryToken";
import { azureResultFrom, entryFromServer, wordMatchFrom } from "@/app/dictation/[videoId]/shadowingServerMerge";
import { checkAnswer } from "@/lib/utils/text";
import { computeWordMatch } from "@/lib/practice/wordMatch";
import type { AzurePronunciationResult } from "@/lib/azureSpeech";
import type { ShadowingAttemptDto, ShadowingSegmentResults } from "@/lib/practice/shadowingTypes";

const ATTEMPT = "7b0c3b9e-0000-4000-8000-000000000001";
const EARLIER = "7b0c3b9e-0000-4000-8000-000000000002";
// Repeated words ("the" ×2, "cat" ×2) so positions matter.
const PINNED = "The cat saw the other cat today.";

/** jsonb returns the same structure (key order aside). */
const viaJsonb = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function dto(over: {
  attemptId?: string;
  createdAt?: string;
  azure?: Partial<ShadowingAttemptDto["azure"]>;
  wordMatch?: Partial<ShadowingAttemptDto["wordMatch"]>;
}): ShadowingAttemptDto {
  return {
    attemptId: over.attemptId ?? ATTEMPT,
    clientAttemptId: "c-1",
    roundId: "round-1",
    youtubeVideoId: "vid",
    transcriptId: "tr-1",
    segmentIndex: 4,
    createdAt: over.createdAt ?? "2026-09-01T10:00:00.000Z",
    recordingDurationSec: 3,
    isPracticeValid: true,
    validityBasis: "client_reported",
    studySessionId: null,
    azure: {
      status: "not_evaluated",
      seq: 0,
      requestedAt: null,
      evaluatedAt: null,
      pronunciationScore: null,
      accuracyScore: null,
      fluencyScore: null,
      completenessScore: null,
      prosodyScore: null,
      errorReason: null,
      engineVersion: null,
      detail: null,
      ...over.azure,
    },
    wordMatch: { status: null, seq: 0, accuracy: null, completeness: null, evaluatedAt: null, detail: null, ...over.wordMatch },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  rows.shadowing_attempts = { id: ATTEMPT, segment_id: "seg-1", transcript_id: "tr-1", segment_index: 4 };
  rows.transcript_segments = { text_raw: PINNED, transcript_id: "tr-1", segment_index: 4 };
  serviceRpc.mockResolvedValue({ data: { applied: true, seq: 1, status: "completed" }, error: null });
});

async function storeWordMatch(recognizedText: string) {
  const req = new NextRequest(`http://localhost/api/practice/attempt/${ATTEMPT}/word-match`, {
    method: "PATCH",
    body: JSON.stringify({ status: "completed", recognizedText }),
    headers: { "Content-Type": "application/json" },
  });
  const res = await PATCH(req, { params: Promise.resolve({ attemptId: ATTEMPT }) });
  expect(res.status).toBe(200);
  const args = serviceRpc.mock.calls[0][1];
  return dto({
    wordMatch: {
      status: "completed",
      seq: 1,
      accuracy: args.p_accuracy,
      completeness: args.p_completeness,
      evaluatedAt: "2026-09-01T10:00:05.000Z",
      detail: viaJsonb(args.p_detail),
    },
  });
}

describe("Word Match: live → stored → restored keeps the same differences", () => {
  // Second "cat" said as "hat", "other" missing, "really" inserted.
  const HEARD = "the cat saw the hat really today";

  it("restores the recognized text, so the Details comparison is identical, occurrence by occurrence", async () => {
    const live = computeWordMatch(PINNED, HEARD);
    const liveDiff = checkAnswer(PINNED, HEARD, "relaxed").diff;
    const restored = wordMatchFrom(await storeWordMatch(HEARD));

    expect(restored.recognizedText).toBe(HEARD);
    expect(restored.accuracy).toBeCloseTo(live.accuracy);
    expect(restored.completeness).toBeCloseTo(live.completeness);
    expect(restored.problemWords).toEqual(live.problemWords);
    const restoredDiff = checkAnswer(PINNED, restored.recognizedText!, "relaxed").diff;
    expect(restoredDiff).toEqual(liveDiff);
    // Positions are preserved: the FIRST "cat" is correct, the SECOND is the difference.
    const cats = restoredDiff.filter((t) => t.word.replace(/\W/g, "").toLowerCase() === "cat");
    expect(cats.map((t) => t.status)).toEqual(["correct", "missing"]);
    expect(restored).toMatchObject({ status: "completed", persisted: true, restored: true, evaluatedAt: "2026-09-01T10:00:05.000Z" });
  });

  it("keeps 'nothing recognized' (empty text) distinct from 'detail not saved' (no text)", async () => {
    const empty = wordMatchFrom(await storeWordMatch(""));
    expect(empty.recognizedText).toBe("");
    const legacy = wordMatchFrom(dto({ wordMatch: { status: "completed", seq: 1, accuracy: 45, completeness: 60, detail: null } }));
    expect(legacy.recognizedText).toBeUndefined();
    expect(legacy.accuracy).toBe(45);
    expect(legacy.problemWords).toEqual([]);
  });
});

describe("Azure: live → stored (direct and recovery) → restored keeps scores and per-word feedback", () => {
  const live: AzurePronunciationResult = {
    pronScore: 71,
    accuracy: 80,
    fluency: 66,
    completeness: 90,
    prosody: null, // not returned → must stay unavailable, never 0
    recognizedText: "The cat saw the cat today.",
    rawResult: { RecognitionStatus: "Success" },
    words: [
      { word: "the", accuracyScore: 95, errorType: "None", offset: 100, duration: 50 },
      { word: "cat", accuracyScore: 40, errorType: "Mispronunciation", offset: 200, duration: 60,
        phonemes: [{ phoneme: "k", accuracyScore: 30 }, { phoneme: "æ", accuracyScore: 50 }, { phoneme: "t", accuracyScore: 40 }],
        syllables: [{ syllable: "kæt", accuracyScore: 40, grapheme: "cat" }] },
      { word: "saw", accuracyScore: 88, errorType: "None" },
      { word: "the", accuracyScore: 91, errorType: "None" },
      { word: "other", accuracyScore: null, errorType: "Omission" },
      { word: "cat", accuracyScore: 97, errorType: "None", prosodyFeedback: { breakErrorType: "UnexpectedBreak", breakConfidence: 0.8 } },
      { word: "today", accuracyScore: 85, errorType: "None" },
    ],
  };

  function restoreFrom(stored: RecoveryResult) {
    return azureResultFrom(
      dto({
        azure: {
          status: "completed",
          seq: 1,
          evaluatedAt: "2026-09-01T10:00:09.000Z",
          pronunciationScore: stored.pronunciationScore,
          accuracyScore: stored.accuracyScore,
          fluencyScore: stored.fluencyScore,
          completenessScore: stored.completenessScore,
          prosodyScore: stored.prosodyScore,
          engineVersion: stored.engineVersion,
          detail: viaJsonb(stored.detail) as ShadowingAttemptDto["azure"]["detail"],
        },
      })
    );
  }

  it("restores every word in order with its own score, error label and sub-word detail; missing metrics stay unavailable", () => {
    const restored = restoreFrom(toStoredAzureResult(live)!);
    expect(restored.words).toEqual(viaJsonb(live.words)); // both "the" and both "cat" separately, same order
    expect(restored.words!.filter((w) => w.word === "cat").map((w) => [w.accuracyScore, w.errorType])).toEqual([
      [40, "Mispronunciation"],
      [97, "None"],
    ]);
    expect(restored).toMatchObject({
      status: "completed",
      pronunciationScore: 71,
      accuracyScore: 80,
      fluencyScore: 66,
      completenessScore: 90,
      recognizedText: live.recognizedText,
      attemptId: ATTEMPT,
      persistence: "saved",
      restored: true,
      evaluatedAt: "2026-09-01T10:00:09.000Z",
    });
    expect(restored.prosodyScore).toBeUndefined();
    // The raw provider payload is intentionally not stored.
    expect(restored.rawAzureResult).toBeUndefined();
  });

  it("a recovery-token replay stores exactly what the direct write stores, so both restore the same report", () => {
    const direct = toStoredAzureResult(live)!;
    const secret = "s".repeat(40);
    const token = issueRecoveryToken(secret, { userId: "user-1", attemptId: ATTEMPT, seq: 1, result: direct });
    const verified = verifyRecoveryToken(secret, token);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.payload.result).toEqual(direct);
    expect(restoreFrom(verified.payload.result)).toEqual(restoreFrom(direct));
  });

  it("a summary-only (detail-less) record restores its scores and no invented words", () => {
    const restored = azureResultFrom(
      dto({ azure: { status: "completed", seq: 1, pronunciationScore: 64, accuracyScore: 70, fluencyScore: null, detail: null } })
    );
    expect(restored.pronunciationScore).toBe(64);
    expect(restored.words).toEqual([]);
    expect(restored.recognizedText).toBeUndefined();
    expect(restored.fluencyScore).toBeUndefined();
  });
});

describe("attempt identity on restore", () => {
  it("a newer unevaluated recording never takes over an earlier saved evaluation", () => {
    const earlier = dto({
      attemptId: EARLIER,
      createdAt: "2026-09-01T09:00:00.000Z",
      azure: { status: "completed", seq: 1, pronunciationScore: 70, detail: { recognizedText: "x", words: [] } },
    });
    const newest = dto({ attemptId: ATTEMPT, createdAt: "2026-09-01T10:00:00.000Z" });
    const seg: ShadowingSegmentResults = {
      segmentIndex: 4,
      attemptCount: 2,
      latestAttempt: newest,
      latestSuccessfulAzureAttempt: earlier,
      latestWordMatchAttempt: null,
      azureHistory: [],
    };
    const entry = entryFromServer(seg, PINNED);
    expect(entry.lastSuccessfulTrueEvaluation?.attemptId).toBe(EARLIER);
    expect(entry.trueEvaluation?.attemptId).toBe(EARLIER);
    expect(entry.latestRecording).toMatchObject({ attemptId: ATTEMPT, azureStatus: "not_evaluated" });
    expect(entry.referenceText).toBe(PINNED);
  });
});
