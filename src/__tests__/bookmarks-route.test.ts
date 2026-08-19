import { NextRequest } from "next/server";

const mockUser = { id: "user-1" };
let getUserResult: { data: { user: typeof mockUser | null } } = { data: { user: mockUser } };
const fromMock = jest.fn();

jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => getUserResult },
    from: (table: string) => fromMock(table),
  }),
}));

import { GET, POST, PATCH, DELETE } from "@/app/api/bookmarks/route";

function makeGetRequest(query = ""): NextRequest {
  return new NextRequest(`http://localhost/api/bookmarks${query}`);
}

function makeJsonRequest(method: string, body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/bookmarks", {
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function makeDeleteRequest(id: string): NextRequest {
  return new NextRequest(`http://localhost/api/bookmarks?id=${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

beforeEach(() => {
  getUserResult = { data: { user: mockUser } };
  fromMock.mockReset();
});

describe("GET /api/bookmarks", () => {
  it("returns 401 when not authenticated", async () => {
    getUserResult = { data: { user: null } };
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(401);
  });

  it("returns the user's bookmarks joined with video titles", async () => {
    const rows = [{ id: "bm-1", user_id: mockUser.id, video_id: "v1", segment_index: 0 }];
    const bookmarksBuilder: Record<string, jest.Mock> = {};
    const bmChain = () => bookmarksBuilder;
    bookmarksBuilder.select = jest.fn(bmChain);
    bookmarksBuilder.eq = jest.fn(bmChain);
    bookmarksBuilder.order = jest.fn(() => Promise.resolve({ data: rows, error: null }));

    const videosBuilder: Record<string, jest.Mock> = {};
    videosBuilder.select = jest.fn(() => videosBuilder);
    videosBuilder.in = jest.fn(() => Promise.resolve({ data: [{ youtube_video_id: "v1", title: "My Video" }], error: null }));

    fromMock.mockImplementation((table: string) => (table === "bookmarks" ? bookmarksBuilder : videosBuilder));

    const res = await GET(makeGetRequest());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ id: "bm-1", videoTitle: "My Video" });
  });
});

describe("POST /api/bookmarks", () => {
  it("returns 401 when not authenticated", async () => {
    getUserResult = { data: { user: null } };
    const res = await POST(makeJsonRequest("POST", { videoId: "v1", segmentIndex: 0, startSec: 1, sentenceText: "Hi" }));
    expect(res.status).toBe(401);
  });

  it("returns 400 when required fields are missing", async () => {
    const res = await POST(makeJsonRequest("POST", { videoId: "v1" }));
    expect(res.status).toBe(400);
  });

  it("inserts a new bookmark when none exists yet", async () => {
    const builder: Record<string, jest.Mock> = {};
    const chain = () => builder;
    let inserted: Record<string, unknown> | null = null;
    builder.select = jest.fn(chain);
    builder.match = jest.fn(chain);
    builder.maybeSingle = jest.fn(() => Promise.resolve({ data: null, error: null }));
    builder.insert = jest.fn((payload: Record<string, unknown>) => {
      inserted = { id: "bm-new", ...payload };
      return builder;
    });
    builder.single = jest.fn(() => Promise.resolve({ data: inserted, error: null }));
    fromMock.mockReturnValue(builder);

    const res = await POST(
      makeJsonRequest("POST", { videoId: "v1", segmentIndex: 2, startSec: 12.5, sentenceText: "Hello there" })
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.item).toMatchObject({ video_id: "v1", segment_index: 2, sentence_text: "Hello there" });
  });

  it("updates the existing bookmark on the same segment instead of duplicating", async () => {
    const builder: Record<string, jest.Mock> = {};
    const chain = () => builder;
    let updated: Record<string, unknown> | null = null;
    builder.select = jest.fn(chain);
    builder.match = jest.fn(chain);
    builder.maybeSingle = jest.fn(() => Promise.resolve({ data: { id: "bm-1" }, error: null }));
    builder.update = jest.fn((payload: Record<string, unknown>) => {
      updated = { id: "bm-1", ...payload };
      return builder;
    });
    builder.eq = jest.fn(chain);
    builder.single = jest.fn(() => Promise.resolve({ data: updated, error: null }));
    fromMock.mockReturnValue(builder);

    const res = await POST(
      makeJsonRequest("POST", { videoId: "v1", segmentIndex: 2, startSec: 13, sentenceText: "Updated text" })
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.item).toMatchObject({ id: "bm-1", sentence_text: "Updated text" });
  });
});

describe("PATCH /api/bookmarks", () => {
  it("returns 401 when not authenticated", async () => {
    getUserResult = { data: { user: null } };
    const res = await PATCH(makeJsonRequest("PATCH", { id: "bm-1", note: "hi" }));
    expect(res.status).toBe(401);
  });

  it("returns 400 when id is missing", async () => {
    const res = await PATCH(makeJsonRequest("PATCH", { note: "hi" }));
    expect(res.status).toBe(400);
  });

  it("updates the note", async () => {
    const builder: Record<string, jest.Mock> = {};
    const chain = () => builder;
    builder.update = jest.fn(chain);
    builder.eq = jest.fn(chain);
    builder.select = jest.fn(chain);
    builder.single = jest.fn(() =>
      Promise.resolve({ data: { id: "bm-1", note: "updated note" }, error: null })
    );
    fromMock.mockReturnValue(builder);

    const res = await PATCH(makeJsonRequest("PATCH", { id: "bm-1", note: "updated note" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.item.note).toBe("updated note");
  });
});

describe("DELETE /api/bookmarks", () => {
  it("returns 401 when not authenticated", async () => {
    getUserResult = { data: { user: null } };
    const res = await DELETE(makeDeleteRequest("bm-1"));
    expect(res.status).toBe(401);
  });

  it("returns 400 when id is missing", async () => {
    const res = await DELETE(makeGetRequest());
    expect(res.status).toBe(400);
  });

  it("returns 404 when nothing was deleted", async () => {
    const builder: Record<string, jest.Mock> = {};
    const chain = () => builder;
    builder.delete = jest.fn(chain);
    builder.eq = jest.fn(chain);
    builder.select = jest.fn(() => Promise.resolve({ data: [], error: null }));
    fromMock.mockReturnValue(builder);

    const res = await DELETE(makeDeleteRequest("missing"));
    expect(res.status).toBe(404);
  });

  it("deletes the bookmark", async () => {
    const builder: Record<string, jest.Mock> = {};
    const chain = () => builder;
    builder.delete = jest.fn(chain);
    builder.eq = jest.fn(chain);
    builder.select = jest.fn(() => Promise.resolve({ data: [{ id: "bm-1" }], error: null }));
    fromMock.mockReturnValue(builder);

    const res = await DELETE(makeDeleteRequest("bm-1"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
  });
});
