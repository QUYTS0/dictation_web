import { NextRequest } from "next/server";

// Phase 3: the resume response seeds the client's sentence-accuracy map with
// the LATEST Dictation result per practiced sentence of the round.
const round = {
  id: "round-1",
  current_segment_index: 2,
  video_current_time: 5,
  accuracy: 50,
  total_attempts: 4,
  updated_at: "2026-01-01T00:00:00Z",
  status: "active",
  transcript_id: "rev-A",
  round_number: 3,
  provenance: "legacy_unverified",
  required_sentence_count: 10,
};
// Newest first, as the route orders them.
const attempts = [
  { segment_index: 1, is_correct: true, created_at: "2026-01-01T00:00:04Z", id: "d" },
  { segment_index: 0, is_correct: false, created_at: "2026-01-01T00:00:03Z", id: "c" },
  { segment_index: 1, is_correct: false, created_at: "2026-01-01T00:00:02Z", id: "b" },
  { segment_index: 0, is_correct: true, created_at: "2026-01-01T00:00:01Z", id: "a" },
];

function builder(result: unknown) {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order", "limit"]) b[m] = () => b;
  b.maybeSingle = async () => result;
  b.then = (res: (v: unknown) => unknown) => Promise.resolve(result).then(res);
  return b;
}

jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    from: (table: string) =>
      table === "attempt_logs" ? builder({ data: attempts, error: null }) : builder({ data: round, error: null }),
  }),
}));

import { GET } from "@/app/api/session/resume/route";

it("returns the latest result per sentence plus round number, provenance and required count", async () => {
  const res = await GET(new NextRequest("http://localhost/api/session/resume?videoId=vid1"));
  const { session } = await res.json();
  expect(session).toMatchObject({
    sessionId: "round-1",
    roundNumber: 3,
    provenance: "legacy_unverified",
    requiredSentenceCount: 10,
    latestDictationResults: [
      { segmentIndex: 0, isCorrect: false },
      { segmentIndex: 1, isCorrect: true },
    ],
  });
});
