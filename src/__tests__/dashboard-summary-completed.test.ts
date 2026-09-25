// "Completed videos" on the Dashboard counts distinct VIDEOS with a round
// completed under the authoritative (Phase 3) rule; videos whose only
// completion predates the cutover are reported separately as "earlier
// (unverified)" — a video is never counted in both.
const tables: Record<string, unknown[]> = {};

function builder(table: string) {
  const result = { data: tables[table] ?? [], error: null, count: (tables[table] ?? []).length };
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "order", "limit"]) b[m] = () => b;
  b.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(result).then(resolve, reject);
  return b;
}

jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    from: (t: string) => builder(t),
  }),
}));

import { GET } from "@/app/api/dashboard/summary/route";

const round = (id: string, video: string, status: string, provenance: string) => ({
  id,
  youtube_video_id: video,
  status,
  provenance,
  accuracy: 80,
  video_current_time: 0,
  updated_at: "2026-09-01T00:00:00Z",
  current_segment_index: 0,
  total_attempts: 1,
});

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
});

it("dedupes by video and never counts a verified video again as 'earlier (unverified)'", async () => {
  tables.learning_sessions = [
    round("r1", "vidA", "completed", "legacy_unverified"),
    round("r2", "vidA", "completed", "current"), // same video, verified later
    round("r3", "vidA", "completed", "current"), // second verified round, same video
    round("r4", "vidB", "completed", "legacy_unverified"),
    round("r5", "vidB", "completed", "legacy_unverified"),
    round("r6", "vidC", "completed", "current"),
    round("r7", "vidD", "active", "current"),
  ];
  const json = await (await GET()).json();
  expect(json.completedVideos).toBe(2); // vidA, vidC
  expect(json.legacyCompletedVideos).toBe(1); // vidB only
});
