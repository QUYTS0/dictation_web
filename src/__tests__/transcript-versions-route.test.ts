/**
 * Script Versions routes (Phase 9) — contract with Supabase mocked. The
 * listing's classification, size estimates, per-viewer association and the
 * deletion gate are computed by migration 041 and verified on real
 * PostgreSQL in integration/phase9-script-versions.integration.test.ts.
 */
import { GET as LIST } from "@/app/api/transcripts/[videoId]/versions/route";
import { GET as PREVIEW } from "@/app/api/transcripts/[videoId]/versions/[transcriptId]/preview/route";

const rpc = jest.fn();
const getUser = jest.fn();
const calls: Array<{ table: string; op: string; args: unknown[] }> = [];
const tables: Record<string, { data: unknown; error: unknown }> = {};

function builder(table: string) {
  const b: Record<string, unknown> = {};
  for (const op of ["select", "eq", "order", "insert", "update", "upsert", "delete"]) {
    b[op] = (...args: unknown[]) => {
      calls.push({ table, op, args });
      return b;
    };
  }
  const result = () => tables[table] ?? { data: null, error: null };
  b.maybeSingle = async () => result();
  b.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(result()).then(resolve, reject);
  return b;
}

jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser }, rpc: (...a: unknown[]) => rpc(...a), from: (t: string) => builder(t) }),
}));

const TID = "0b6c1b4e-4d0f-4b8e-9c55-6f1d1d6c2a11";
const list = (videoId: string) => LIST(new Request(`http://localhost/api/transcripts/${videoId}/versions`), { params: Promise.resolve({ videoId }) });
const preview = (videoId: string, transcriptId: string) =>
  PREVIEW(new Request(`http://localhost/api/transcripts/${videoId}/versions/${transcriptId}/preview`), {
    params: Promise.resolve({ videoId, transcriptId }),
  });

beforeEach(() => {
  rpc.mockReset();
  calls.length = 0;
  for (const k of Object.keys(tables)) delete tables[k];
  getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("GET /api/transcripts/[videoId]/versions", () => {
  it("returns the database's listing for the English script; deletion stays disabled", async () => {
    const body = { videoId: "vid1", language: "en", deletionEnabled: false, retentionGraceDays: 30, revisions: [{ transcriptId: TID, version: 2 }] };
    rpc.mockResolvedValue({ data: body, error: null });
    const res = await list("vid1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(body);
    expect(rpc).toHaveBeenCalledWith("fn_transcript_versions", { p_youtube_video_id: "vid1", p_language: "en" });
    expect(rpc).toHaveBeenCalledTimes(1); // never fn_delete_transcript_revision
  });

  it("401 for guests and 400 for a bad id, before any database call", async () => {
    getUser.mockResolvedValueOnce({ data: { user: null } });
    expect((await list("vid1")).status).toBe(401);
    expect((await list("x".repeat(65))).status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("migration 041 missing → 503 with a stable code; other errors → 500", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: "PGRST202", message: "Could not find the function" } });
    const res = await list("vid1");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "script_versions_unavailable" });
    rpc.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    expect((await list("vid1")).status).toBe(500);
  });
});

describe("GET /api/transcripts/[videoId]/versions/[transcriptId]/preview", () => {
  it("returns the revision's sentences in order — a pure read (select only, no RPC)", async () => {
    tables.transcripts = { data: { id: TID, youtube_video_id: "vid1", version: 1, status: "ready", is_current: false }, error: null };
    tables.transcript_segments = {
      data: [
        { segment_index: 0, start_sec: "0", end_sec: "2.5", text_raw: "Hello there." },
        { segment_index: 1, start_sec: "2.5", end_sec: "4", text_raw: "General Kenobi." },
      ],
      error: null,
    };
    const res = await preview("vid1", TID);
    expect(await res.json()).toEqual({
      transcriptId: TID,
      videoId: "vid1",
      version: 1,
      status: "ready",
      isCurrent: false,
      segments: [
        { segmentIndex: 0, start: 0, end: 2.5, text: "Hello there." },
        { segmentIndex: 1, start: 2.5, end: 4, text: "General Kenobi." },
      ],
    });
    // The revision must belong to the video in the URL.
    expect(calls).toContainEqual({ table: "transcripts", op: "eq", args: ["youtube_video_id", "vid1"] });
    expect(calls.map((c) => c.op).filter((op) => ["insert", "update", "upsert", "delete"].includes(op))).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("404 for another video's revision (or none) and for a revision still being generated", async () => {
    tables.transcripts = { data: null, error: null };
    expect(await (await preview("vid1", TID)).json()).toMatchObject({ code: "transcript_not_found" });
    tables.transcripts = { data: { id: TID, youtube_video_id: "vid1", version: 3, status: "processing", is_current: false }, error: null };
    const res = await preview("vid1", TID);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "transcript_not_ready" });
  });

  it("400 for a malformed id; 401 for guests", async () => {
    expect((await preview("vid1", "not-a-uuid")).status).toBe(400);
    getUser.mockResolvedValueOnce({ data: { user: null } });
    expect((await preview("vid1", TID)).status).toBe(401);
    expect(calls).toEqual([]);
  });
});
