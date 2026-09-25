import { NextRequest } from "next/server";

const mockUser = { id: "user-1" };
let getUserResult: { data: { user: typeof mockUser | null } } = { data: { user: mockUser } };
let deletedRows: { id: string }[] = [];
let deleteError: { message: string } | null = null;
let lastDeleteIds: string[] | null = null;
let lastDeleteUserId: string | null = null;

function makeQueryBuilder() {
  const builder: Record<string, jest.Mock> = {};
  builder.delete = jest.fn(() => builder);
  builder.in = jest.fn((_col: string, ids: string[]) => {
    lastDeleteIds = ids;
    return builder;
  });
  builder.eq = jest.fn((_col: string, userId: string) => {
    lastDeleteUserId = userId;
    return builder;
  });
  builder.select = jest.fn(() =>
    Promise.resolve({ data: deleteError ? null : deletedRows, error: deleteError })
  );
  return builder;
}

jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => getUserResult },
    from: () => makeQueryBuilder(),
  }),
}));

import { POST } from "@/app/api/vocabulary/bulk-delete/route";
import { MAX_BULK_SELECTABLE_ITEMS } from "@/lib/utils/vocabulary";

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/vocabulary/bulk-delete", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("POST /api/vocabulary/bulk-delete", () => {
  beforeEach(() => {
    getUserResult = { data: { user: mockUser } };
    deletedRows = [];
    deleteError = null;
    lastDeleteIds = null;
    lastDeleteUserId = null;
  });

  it("returns 401 when not authenticated", async () => {
    getUserResult = { data: { user: null } };
    const res = await POST(makeRequest({ ids: ["a"] }));
    expect(res.status).toBe(401);
  });

  it("returns 400 when ids is missing or empty", async () => {
    expect((await POST(makeRequest({}))).status).toBe(400);
    expect((await POST(makeRequest({ ids: [] }))).status).toBe(400);
  });

  it("returns 400 when ids exceeds the shared MAX_BULK_SELECTABLE_ITEMS cap", async () => {
    const ids = Array.from({ length: MAX_BULK_SELECTABLE_ITEMS + 1 }, (_, i) => `id-${i}`);
    const res = await POST(makeRequest({ ids }));
    expect(res.status).toBe(400);
  });

  it("accepts exactly MAX_BULK_SELECTABLE_ITEMS ids", async () => {
    const ids = Array.from({ length: MAX_BULK_SELECTABLE_ITEMS }, (_, i) => `id-${i}`);
    deletedRows = ids.map((id) => ({ id }));
    const res = await POST(makeRequest({ ids }));
    expect(res.status).toBe(200);
  });

  it("returns 400 when ids contains a non-string entry", async () => {
    const res = await POST(makeRequest({ ids: ["a", 123] }));
    expect(res.status).toBe(400);
  });

  it("scopes the delete to the caller's own rows and returns exactly what the DB actually deleted", async () => {
    // "not-mine" is included in the request but the (mocked) DB only
    // reports back the two rows that actually matched user_id — the route
    // must trust that result, not echo the request back.
    deletedRows = [{ id: "a" }, { id: "b" }];
    const res = await POST(makeRequest({ ids: ["a", "b", "not-mine"] }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.deletedIds).toEqual(["a", "b"]);
    expect(lastDeleteIds).toEqual(["a", "b", "not-mine"]);
    expect(lastDeleteUserId).toBe(mockUser.id);
  });

  it("returns 500 on a database error", async () => {
    deleteError = { message: "boom" };
    const res = await POST(makeRequest({ ids: ["a"] }));
    expect(res.status).toBe(500);
  });
});
