/**
 * GET /api/history/videos/<videoId>/round-list — the report page's round
 * selector source: owner + video scoped, newest first, offset-paged, exact
 * total, and a plain table read (no RPC, no write).
 */
import { NextRequest } from "next/server";

type Call = [string, ...unknown[]];
let calls: Call[] = [];
let result: { data: unknown; error: unknown; count: number | null } = { data: [], error: null, count: 0 };
let user: { id: string } | null = { id: "user-1" };

function builder(table: string) {
  calls.push(["from", table]);
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order", "range", "insert", "update", "delete", "upsert"]) {
    b[m] = (...args: unknown[]) => {
      calls.push([m, ...args]);
      return b;
    };
  }
  b.then = (resolve: (v: unknown) => unknown) => resolve(result);
  return b;
}
const rpc = jest.fn();
jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user } }) }, rpc, from: (t: string) => builder(t) }),
}));

import { GET } from "@/app/api/history/videos/[videoId]/round-list/route";

const get = (videoId: string, qs = "") =>
  GET(new NextRequest(`http://localhost/api/history/videos/${videoId}/round-list${qs}`), { params: Promise.resolve({ videoId }) });

beforeEach(() => {
  calls = [];
  user = { id: "user-1" };
  rpc.mockReset();
  result = { data: [], error: null, count: 0 };
});

it("lists only this user's rounds of this video, newest first, one page, with the exact total", async () => {
  result = {
    data: [
      { id: "r2", round_number: 2, status: "active", provenance: "current", started_at: "2026-09-25T00:00:00Z", transcript_id: "tB" },
      { id: "r1", round_number: 1, status: "completed", provenance: "legacy_unverified", started_at: "2026-09-01T00:00:00Z", transcript_id: "tA" },
    ],
    error: null,
    count: 3,
  };
  const res = await get("vidA", "?offset=0&limit=2");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    videoId: "vidA",
    total: 3,
    offset: 0,
    hasMore: true,
    items: [
      { roundId: "r2", roundNumber: 2, status: "active", provenance: "current", startedAt: "2026-09-25T00:00:00Z", transcriptId: "tB" },
      { roundId: "r1", roundNumber: 1, status: "completed", provenance: "legacy_unverified", startedAt: "2026-09-01T00:00:00Z", transcriptId: "tA" },
    ],
  });
  expect(calls).toEqual([
    ["from", "learning_sessions"],
    ["select", "id, round_number, status, provenance, started_at, transcript_id", { count: "exact" }],
    ["eq", "user_id", "user-1"],
    ["eq", "youtube_video_id", "vidA"],
    ["order", "started_at", { ascending: false }],
    ["order", "id", { ascending: false }],
    ["range", 0, 1],
  ]);
  expect(rpc).not.toHaveBeenCalled();
});

it("pages by offset (clamped limit) and reports the last page", async () => {
  result = { data: [{ id: "r0", round_number: 1, status: "completed", provenance: "current", started_at: "2026-01-01T00:00:00Z", transcript_id: null }], error: null, count: 121 };
  const body = await (await get("vidA", "?offset=120&limit=999")).json();
  expect(body).toMatchObject({ total: 121, offset: 120, hasMore: false });
  expect(calls).toContainEqual(["range", 120, 219]); // limit capped at 100
});

it("rejects a signed-out request and an invalid video id; a database error is a 500", async () => {
  user = null;
  expect((await get("vidA")).status).toBe(401);
  user = { id: "user-1" };
  expect((await get(" ")).status).toBe(400);
  result = { data: null, error: { message: "boom" }, count: null };
  jest.spyOn(console, "error").mockImplementation(() => {});
  expect((await get("vidA")).status).toBe(500);
});
