import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

// "N/M evaluated" = distinct sentences of the displayed round/revision with a
// SAVED successful Azure evaluation. Recording, practice credit and Word
// Match never count; pending/failed/unsaved takes neither add nor remove a
// sentence; live and restored state agree. Mocked HTTP only — no Azure.
import { useShadowingEvaluations } from "@/app/dictation/[videoId]/useShadowingEvaluations";
import { buildShadowingRoundSummary, type ShadowingRoundSummary } from "@/lib/practice/shadowingSummary";
import { EvaluationSessionSummary } from "@/app/dictation/[videoId]/components/EvaluationSessionSummary";
import type { ShadowingAttemptDto, ShadowingSegmentResults } from "@/lib/practice/shadowingTypes";

const TEXT = ["One two three.", "Four five six.", "Seven eight nine.", "Ten eleven twelve."];
const referenceTextFor = (i: number) => TEXT[i] ?? "";
const fetchMock = jest.fn();

// Azure accuracy per sentence 0..2; sentence 3 only has Word Match (accuracy 20).
const AZURE = [
  { pron: 60, acc: 50, flu: 70, comp: 90, pros: null },
  { pron: 80, acc: 70, flu: 80, comp: 100, pros: 75 },
  { pron: 90, acc: 90, flu: 60, comp: 80, pros: 85 },
];

function dto(segmentIndex: number, attemptId: string, createdAt: string, azure: Partial<ShadowingAttemptDto["azure"]> = {}, wordMatch: Partial<ShadowingAttemptDto["wordMatch"]> = {}): ShadowingAttemptDto {
  return {
    attemptId,
    clientAttemptId: `c-${attemptId}`,
    roundId: "round-1",
    youtubeVideoId: "vid",
    transcriptId: "tr-1",
    segmentIndex,
    createdAt,
    recordingDurationSec: 2,
    isPracticeValid: true,
    validityBasis: "client_reported",
    studySessionId: null,
    azure: {
      status: "not_evaluated", seq: 0, requestedAt: null, evaluatedAt: null, pronunciationScore: null, accuracyScore: null,
      fluencyScore: null, completenessScore: null, prosodyScore: null, errorReason: null, engineVersion: null, detail: null,
      ...azure,
    },
    wordMatch: { status: null, seq: 0, accuracy: null, completeness: null, evaluatedAt: null, detail: null, ...wordMatch },
  };
}

const azureOk = (i: number, at: string) => ({
  status: "completed" as const,
  seq: 1,
  evaluatedAt: at,
  pronunciationScore: AZURE[i].pron,
  accuracyScore: AZURE[i].acc,
  fluencyScore: AZURE[i].flu,
  completenessScore: AZURE[i].comp,
  prosodyScore: AZURE[i].pros,
  detail: { recognizedText: TEXT[i], words: [] },
});

function evaluatedSegment(i: number): ShadowingSegmentResults {
  const at = `2026-09-01T10:0${i}:00.000Z`;
  const d = dto(i, `a${i}`, at, azureOk(i, at));
  return { segmentIndex: i, attemptCount: 1, latestAttempt: d, latestSuccessfulAzureAttempt: d, latestWordMatchAttempt: null,
    azureHistory: [{ attemptId: d.attemptId, createdAt: at, evaluatedAt: at, pronunciationScore: AZURE[i].pron, accuracyScore: AZURE[i].acc,
      fluencyScore: AZURE[i].flu, completenessScore: AZURE[i].comp, prosodyScore: AZURE[i].pros, words: [] }] };
}

/** Sentence 3: recorded + Word Match, no Azure (optionally a pending/failed one). */
function recordedOnly(azure: Partial<ShadowingAttemptDto["azure"]> = {}): ShadowingSegmentResults {
  const d = dto(3, "a3", "2026-09-01T10:05:00.000Z", azure, {
    status: "completed", seq: 1, accuracy: 20, completeness: 40, evaluatedAt: "2026-09-01T10:05:01.000Z",
    detail: { recognizedText: "ten", problemWords: [] },
  });
  return { segmentIndex: 3, attemptCount: 1, latestAttempt: d, latestSuccessfulAzureAttempt: null, latestWordMatchAttempt: d, azureHistory: [] };
}

const round = (segments: ShadowingSegmentResults[], transcriptId = "tr-1") => ({
  roundId: "round-1", youtubeVideoId: "vid", transcriptId, roundStatus: "active", evaluationTimeoutSec: 120, segments,
});
const respond = (body: unknown) => fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => body } as Response);

function mountEvaluations(totalCount = 110, transcriptId = "tr-1") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return renderHook(
    () =>
      useShadowingEvaluations({
        videoId: "vid", transcriptId, userId: "user-1", roundId: "round-1", eligibleSentences: totalCount, recordedSentences: null, referenceTextFor,
      }),
    { wrapper }
  );
}
async function loaded(segments: ShadowingSegmentResults[], totalCount = 110) {
  respond(round(segments));
  const hook = mountEvaluations(totalCount);
  await waitFor(() => expect(Object.keys(hook.result.current.evaluations).length).toBe(segments.length));
  return hook;
}
const meta = (i: number) => ({ referenceText: TEXT[i], wordCount: 3, audioDuration: 2 });

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
  sessionStorage.clear();
  localStorage.clear();
});

describe("evaluated coverage (restored from the server)", () => {
  it("1/11. three Azure-evaluated sentences + one recorded with Word Match only → 3 evaluated; Word Match never feeds Azure aggregates", async () => {
    const { result } = await loaded([evaluatedSegment(0), evaluatedSegment(1), evaluatedSegment(2), recordedOnly()]);
    const s = result.current.summary;
    expect(s.coverage.scoredSentences).toBe(3);
    expect(s.coverage.eligibleSentences).toBe(110);
    expect(s.coverage.allScored).toBe(false);
    // Equal word counts → plain means of the three Azure values; Word Match's 20/40 are not included.
    expect(s.metrics.accuracy?.value).toBeCloseTo((50 + 70 + 90) / 3);
    expect(s.metrics.completeness?.value).toBeCloseTo((90 + 100 + 80) / 3);
    // A metric Azure didn't return is excluded, not 0.
    expect(s.metrics.prosody).toEqual({ value: (75 + 85) / 2, sentences: 2 });
    // Word Match stays a separate figure.
    expect(s.coverage.wordMatchSentences).toBe(1);
    expect(s.weakestSentences.map((w) => w.segmentIndex).sort()).toEqual([0, 1, 2]);
    expect(s.weakestSentences.some((w) => w.usedFallbackScore)).toBe(false);

    render(<EvaluationSessionSummary summary={s} onJumpToSegment={() => {}} />);
    // The component's own rounding: Math.round(3 / 110 * 100) = 3.
    expect(screen.getByText(`3/110 scored · ${Math.round((3 / 110) * 100)}%`)).toBeInTheDocument();
  });

  it("2/3/7. a pending, failed or expired latest take doesn't add a sentence — or remove an earlier evaluation of it", async () => {
    const earlier = evaluatedSegment(1);
    const failedNewer = dto(1, "a1-new", "2026-09-01T11:00:00.000Z", { status: "failed", seq: 1, errorReason: "expired" });
    const { result } = await loaded([
      evaluatedSegment(0),
      { ...earlier, attemptCount: 2, latestAttempt: failedNewer },
      evaluatedSegment(2),
      recordedOnly({ status: "pending", seq: 1, requestedAt: "2026-09-01T10:05:02.000Z" }),
    ]);
    expect(result.current.summary.coverage.scoredSentences).toBe(3);
    expect(result.current.evaluations[1].lastSuccessfulTrueEvaluation?.attemptId).toBe("a1");

    respond(round([evaluatedSegment(0), evaluatedSegment(1), evaluatedSegment(2), recordedOnly({ status: "failed", seq: 1, errorReason: "expired" })]));
    act(() => result.current.reloadFromServer());
    await waitFor(() => expect(result.current.evaluations[3].trueEvaluation?.status).toBe("failed"));
    expect(result.current.summary.coverage.scoredSentences).toBe(3);
  });

  it("6. several successful evaluations of one sentence count once, using the LATEST (not the best) score", async () => {
    const at1 = "2026-09-01T10:00:00.000Z";
    const at2 = "2026-09-01T10:30:00.000Z";
    const first = dto(0, "a0-first", at1, { ...azureOk(0, at1), pronunciationScore: 95, accuracyScore: 95 });
    const latest = dto(0, "a0-latest", at2, { ...azureOk(0, at2), pronunciationScore: 40, accuracyScore: 40 });
    const seg: ShadowingSegmentResults = {
      segmentIndex: 0, attemptCount: 2, latestAttempt: latest, latestSuccessfulAzureAttempt: latest, latestWordMatchAttempt: null,
      azureHistory: [first, latest].map((d) => ({ attemptId: d.attemptId, createdAt: d.createdAt, evaluatedAt: d.azure.evaluatedAt,
        pronunciationScore: d.azure.pronunciationScore, accuracyScore: d.azure.accuracyScore, fluencyScore: null, completenessScore: null, prosodyScore: null, words: [] })),
    };
    const { result } = await loaded([seg]);
    expect(result.current.summary.coverage.scoredSentences).toBe(1);
    expect(result.current.summary.metrics.pronunciation?.value).toBe(40);
  });

  it("8. results of a round pinned to another revision don't count", async () => {
    respond(round([evaluatedSegment(0), evaluatedSegment(1)], "tr-old"));
    const { result } = mountEvaluations(110, "tr-new");
    await waitFor(() => expect(result.current.serverLoadError).not.toBeNull());
    expect(result.current.summary.coverage.scoredSentences).toBe(0);
  });
});

describe("evaluated coverage (live transitions on the page)", () => {
  it("2/3/4/5. pending, failure and an unsaved score keep 3; saving it (recovery) makes 4 exactly once", async () => {
    const { result } = await loaded([evaluatedSegment(0), evaluatedSegment(1), evaluatedSegment(2), recordedOnly()]);
    const origin = result.current.scopeKey;
    const count = () => result.current.summary.coverage.scoredSentences;
    // What the server holds once the recovery write succeeded: the hook
    // re-reads the round after every confirmed save (server order wins).
    const savedA3 = (() => {
      const at = "2026-09-01T10:05:00.000Z";
      const d = dto(3, "a3", at, { ...azureOk(0, at), pronunciationScore: 55, accuracyScore: 55, seq: 2 });
      return { ...recordedOnly(), latestAttempt: d, latestSuccessfulAzureAttempt: d,
        azureHistory: [{ attemptId: "a3", createdAt: at, evaluatedAt: at, pronunciationScore: 55, accuracyScore: 55, fluencyScore: null, completenessScore: null, prosodyScore: null, words: [] }] };
    })();

    act(() => result.current.startTrueEvaluation(origin, 3, meta(3)));
    expect(count()).toBe(3); // pending
    act(() => result.current.failTrueEvaluation(origin, 3, "Evaluation failed."));
    expect(count()).toBe(3); // provider failure
    act(() => result.current.startTrueEvaluation(origin, 3, meta(3)));
    act(() =>
      result.current.completeTrueEvaluation(origin, 3, { pronunciationScore: 55, accuracyScore: 55, attemptId: "a3", seq: 2, persistence: "unsaved", clipId: "blob:3" })
    );
    expect(result.current.evaluations[3].trueEvaluation?.persistence).toBe("unsaved"); // still shown as not saved
    expect(count()).toBe(3); // persistence failed
    respond(round([evaluatedSegment(0), evaluatedSegment(1), evaluatedSegment(2), savedA3]));
    act(() => result.current.setTrueEvaluationPersistence(origin, 3, "a3", "saved"));
    expect(count()).toBe(4); // recovery succeeded
    await waitFor(() => expect(result.current.evaluations[3].lastSuccessfulTrueEvaluation?.restored).toBe(true)); // reconciled with the server
    expect(count()).toBe(4);
    act(() => result.current.setTrueEvaluationPersistence(origin, 3, "a3", "saved"));
    expect(count()).toBe(4); // once
  });

  it("superseded / conflicting results never count", async () => {
    const { result } = await loaded([recordedOnly()]);
    const origin = result.current.scopeKey;
    for (const persistence of ["superseded", "conflict"] as const) {
      act(() => result.current.completeTrueEvaluation(origin, 3, { pronunciationScore: 70, attemptId: "a3", seq: 1, persistence }));
      expect(result.current.summary.coverage.scoredSentences).toBe(0);
    }
  });

  it("7. a new take on an evaluated sentence (recorded, evaluating, failed) keeps the sentence counted", async () => {
    const { result } = await loaded([evaluatedSegment(0)]);
    const origin = result.current.scopeKey;
    act(() => result.current.startWordMatch(origin, 0, meta(0)));
    act(() => result.current.completeWordMatch(origin, 0, { recognizedText: "one", accuracy: 33, completeness: 33, problemWords: [] }));
    act(() => result.current.startTrueEvaluation(origin, 0, meta(0)));
    expect(result.current.summary.coverage.scoredSentences).toBe(1);
    act(() => result.current.failTrueEvaluation(origin, 0, "Evaluation failed."));
    expect(result.current.summary.coverage.scoredSentences).toBe(1);
    expect(result.current.summary.metrics.accuracy?.value).toBe(50); // Azure, not the new Word Match 33
  });

  it("8. a late result from another round's scope never changes this summary", async () => {
    const { result } = await loaded([recordedOnly()]);
    const otherRoundOrigin = "user-1.vid.tr-1.round-OTHER";
    act(() => result.current.completeTrueEvaluation(otherRoundOrigin, 3, { pronunciationScore: 70, attemptId: "x", seq: 1, persistence: "saved" }));
    expect(result.current.summary.coverage.scoredSentences).toBe(0);
  });

  it("9. live and restored state give the same numerator, denominator and aggregate inputs", async () => {
    // Live: the same three saved evaluations + Word Match on the fourth, produced on the page.
    respond(round([]));
    const live = mountEvaluations(110);
    await act(async () => {});
    const origin = live.result.current.scopeKey;
    for (const i of [0, 1, 2]) {
      act(() => live.result.current.startTrueEvaluation(origin, i, meta(i)));
      act(() =>
        live.result.current.completeTrueEvaluation(origin, i, {
          pronunciationScore: AZURE[i].pron, accuracyScore: AZURE[i].acc, fluencyScore: AZURE[i].flu,
          completenessScore: AZURE[i].comp, prosodyScore: AZURE[i].pros ?? undefined, words: [], attemptId: `a${i}`, seq: 1, persistence: "saved",
        })
      );
    }
    act(() => live.result.current.startWordMatch(origin, 3, meta(3)));
    act(() => live.result.current.completeWordMatch(origin, 3, { recognizedText: "ten", accuracy: 20, completeness: 40, problemWords: [], attemptId: "a3", persisted: true }));

    const restored = await loaded([evaluatedSegment(0), evaluatedSegment(1), evaluatedSegment(2), recordedOnly()]);
    const pick = (s: ShadowingRoundSummary) => ({
      coverage: s.coverage,
      metrics: s.metrics,
      wordMatch: s.wordMatchAccuracy,
      weakest: s.weakestSentences.map((w) => [w.segmentIndex, w.score]),
    });
    expect(pick(live.result.current.summary)).toEqual(pick(restored.result.current.summary));
  });
});

describe("denominator edge cases", () => {
  it("10. no eligible sentences / unknown denominator: no percentage, never 'complete', no NaN", () => {
    for (const eligibleSentences of [0, null]) {
      const s = buildShadowingRoundSummary({ eligibleSentences, recordedSentences: 0, sentences: [] });
      expect(s.coverage).toMatchObject({ scoredSentences: 0, allScored: false, allRecorded: false });
      expect(s.metrics.pronunciation).toBeNull();
    }
    const s = buildShadowingRoundSummary({ eligibleSentences: 0, recordedSentences: 0, sentences: [] });
    render(<EvaluationSessionSummary summary={s} onJumpToSegment={() => {}} />);
    expect(screen.getByText("0 scored")).toBeInTheDocument();
    expect(screen.queryByText(/NaN|%/)).toBeNull();
  });

  it("11. Word Match-only sentences: 0 evaluated and no Azure aggregate at all", async () => {
    const { result } = await loaded([recordedOnly()], 4);
    const s = result.current.summary;
    expect(s.coverage.scoredSentences).toBe(0);
    expect(Object.values(s.metrics)).toEqual([null, null, null, null, null]);
    expect(s.weakestSentences).toEqual([]);
    expect(s.priorities).toEqual([]);
    expect(s.detail.availability).toBe("no_scores");
  });
});
