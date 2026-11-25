import { NextRequest } from "next/server";

const mockUser = { id: "user-1" };
let getUserResult: { data: { user: typeof mockUser | null } } = { data: { user: mockUser } };
let existingItem: { interval_days: number; ease_factor: number; repetitions: number } | null = {
  interval_days: 0,
  ease_factor: 2.5,
  repetitions: 0,
};
// What fn_record_vocabulary_review (migration 046) answers: the updated row,
// null for a missing/foreign item, or an error.
let rpcResult: { data: unknown; error: { message?: string; code?: string } | null } | null = null;
const rpc = jest.fn(async (_fn: string, args: Record<string, unknown>) => {
  if (rpcResult) return rpcResult;
  return {
    data: {
      ...existingItem,
      id: args.p_item_id,
      user_id: mockUser.id,
      interval_days: args.p_interval_days,
      ease_factor: args.p_ease_factor,
      repetitions: args.p_repetitions,
      next_review_at: args.p_next_review_at,
    },
    error: null,
  };
});

function makeQueryBuilder() {
  const builder: Record<string, jest.Mock> = {};
  const chain = () => builder;
  builder.select = jest.fn(chain);
  builder.eq = jest.fn(chain);
  builder.lte = jest.fn(chain);
  builder.order = jest.fn(chain);
  builder.limit = jest.fn(() => Promise.resolve({ data: [], error: null }));
  builder.maybeSingle = jest.fn(() => Promise.resolve({ data: existingItem, error: null }));
  builder.update = jest.fn(() => {
    throw new Error("the review must be written through fn_record_vocabulary_review, never a direct update");
  });
  return builder;
}

jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => getUserResult },
    from: () => makeQueryBuilder(),
    rpc,
  }),
}));

import { POST } from "@/app/api/vocabulary/review/route";

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/vocabulary/review", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("POST /api/vocabulary/review", () => {
  beforeEach(() => {
    getUserResult = { data: { user: mockUser } };
    existingItem = { interval_days: 0, ease_factor: 2.5, repetitions: 0 };
    rpcResult = null;
    rpc.mockClear();
  });

  it("returns 401 when not authenticated", async () => {
    getUserResult = { data: { user: null } };
    const res = await POST(makeRequest({ itemId: "item-1", grade: "good" }));
    expect(res.status).toBe(401);
  });

  it("returns 400 for an invalid grade", async () => {
    const res = await POST(makeRequest({ itemId: "item-1", grade: "bogus" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when itemId is missing", async () => {
    const res = await POST(makeRequest({ grade: "good" }));
    expect(res.status).toBe(400);
  });

  it("schedules a fresh item 1 day out on 'good', through the one write function with the viewer's timezone", async () => {
    const res = await POST(makeRequest({ itemId: "item-1", grade: "good", timeZone: "Asia/Ho_Chi_Minh" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.item.repetitions).toBe(1);
    expect(body.item.interval_days).toBe(1);
    expect(rpc).toHaveBeenCalledTimes(1);
    const [fn, args] = rpc.mock.calls[0];
    expect(fn).toBe("fn_record_vocabulary_review");
    expect(args).toMatchObject({ p_item_id: "item-1", p_grade: "good", p_interval_days: 1, p_repetitions: 1, p_time_zone: "Asia/Ho_Chi_Minh" });
    expect(Date.parse(args.p_next_review_at as string)).toBeGreaterThan(Date.now());
  });

  it("a missing or invalid timezone is sent as null (the review then counts for its UTC day)", async () => {
    for (const timeZone of [undefined, "Mars/Olympus", "+07:00", 42]) {
      rpc.mockClear();
      const res = await POST(makeRequest({ itemId: "item-1", grade: "easy", timeZone }));
      expect(res.status).toBe(200);
      expect(rpc.mock.calls[0][1].p_time_zone).toBeNull();
    }
  });

  it("returns 404 when the item doesn't belong to the user (no write attempted)", async () => {
    existingItem = null;
    const res = await POST(makeRequest({ itemId: "missing", grade: "good" }));
    expect(res.status).toBe(404);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("returns 404 when the item disappears between the read and the write", async () => {
    rpcResult = { data: null, error: null };
    const res = await POST(makeRequest({ itemId: "item-1", grade: "good" }));
    expect(res.status).toBe(404);
  });

  it("migration 046 not applied yet → a retryable 503, not a crash", async () => {
    rpcResult = { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
    const res = await POST(makeRequest({ itemId: "item-1", grade: "good" }));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("learning_data_unavailable");
  });
});
