import { NextRequest } from "next/server";

const mockUser = { id: "user-1" };
let user: typeof mockUser | null = mockUser;
let attempt: { data: unknown; error: unknown } = { data: null, error: null };
let explanation: { data: unknown; error: unknown } = { data: null, error: null };
let video: { data: unknown; error: unknown } = { data: null, error: null };
const filters: Record<string, Array<[string, unknown]>> = {};

function builder(table: string, result: () => { data: unknown; error: unknown }) {
  filters[table] = [];
  const b: Record<string, jest.Mock> = {};
  const chain = () => b;
  b.select = jest.fn(chain);
  b.eq = jest.fn((col: string, val: unknown) => {
    filters[table].push([col, val]);
    return b;
  });
  b.order = jest.fn(chain);
  b.limit = jest.fn(chain);
  b.maybeSingle = jest.fn(async () => result());
  return b;
}

jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user } }) },
    from: (table: string) =>
      builder(table, () => (table === "attempt_logs" ? attempt : table === "attempt_explanations" ? explanation : video)),
  }),
}));

import { GET } from "@/app/api/dashboard/mistake-example/route";

const req = (errorType?: string) =>
  new NextRequest(`http://localhost/api/dashboard/mistake-example${errorType === undefined ? "" : `?errorType=${errorType}`}`);

const ROW = {
  id: "att-1",
  expected_text: "cells work like a built-in GPS",
  user_text: "cells works like built-in GPS",
  created_at: "2026-11-20T10:00:00Z",
  learning_sessions: { youtube_video_id: "vid1" },
};

beforeEach(() => {
  user = mockUser;
  attempt = { data: ROW, error: null };
  explanation = { data: { explanation: "Plural subject: use the base verb." }, error: null };
  video = { data: { title: "Sense of direction" }, error: null };
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("GET /api/dashboard/mistake-example", () => {
  it("400 for a missing or unknown type (incl. 'none')", async () => {
    for (const t of [undefined, "", "bogus", "none"]) expect((await GET(req(t))).status).toBe(400);
  });

  it("401 when signed out", async () => {
    user = null;
    expect((await GET(req("wrong_form"))).status).toBe(401);
  });

  it("the latest incorrect attempt of that type, scoped to the caller, with title and SAVED explanation", async () => {
    const res = await GET(req("wrong_form"));
    expect(res.status).toBe(200);
    expect((await res.json()).example).toEqual({
      attemptId: "att-1",
      expectedText: "cells work like a built-in GPS",
      userText: "cells works like built-in GPS",
      createdAt: "2026-11-20T10:00:00Z",
      videoId: "vid1",
      videoTitle: "Sense of direction",
      explanation: "Plural subject: use the base verb.",
    });
    expect(filters.attempt_logs).toEqual(
      expect.arrayContaining([
        ["is_correct", false],
        ["error_type", "wrong_form"],
        ["learning_sessions.user_id", "user-1"],
      ])
    );
    expect(filters.attempt_explanations).toEqual([["attempt_id", "att-1"]]);
  });

  it("no recorded mistake of that type → example null", async () => {
    attempt = { data: null, error: null };
    expect(await (await GET(req("missing_word"))).json()).toEqual({ example: null });
  });

  it("a failed explanation or title lookup leaves them out — never the example", async () => {
    explanation = { data: null, error: { message: "boom" } };
    video = { data: null, error: { message: "boom" } };
    const { example } = await (await GET(req("wrong_form"))).json();
    expect(example).toMatchObject({ attemptId: "att-1", explanation: null, videoTitle: null });
  });

  it("the attempt query failing is a 500", async () => {
    attempt = { data: null, error: { message: "boom" } };
    expect((await GET(req("wrong_form"))).status).toBe(500);
  });
});
