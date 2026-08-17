import { NextRequest } from "next/server";

const mockUser = { id: "user-1" };
let getUserResult: { data: { user: typeof mockUser | null } } = { data: { user: mockUser } };
let existingItem: { interval_days: number; ease_factor: number; repetitions: number } | null = {
  interval_days: 0,
  ease_factor: 2.5,
  repetitions: 0,
};
let updatedItem: Record<string, unknown> | null = null;

function makeQueryBuilder() {
  const builder: Record<string, jest.Mock> = {};
  const chain = () => builder;
  builder.select = jest.fn(chain);
  builder.eq = jest.fn(chain);
  builder.lte = jest.fn(chain);
  builder.order = jest.fn(chain);
  builder.limit = jest.fn(() => Promise.resolve({ data: [], error: null }));
  builder.maybeSingle = jest.fn(() => Promise.resolve({ data: existingItem, error: null }));
  builder.update = jest.fn((payload: Record<string, unknown>) => {
    updatedItem = { ...existingItem, ...payload, id: "item-1", user_id: mockUser.id };
    return builder;
  });
  builder.single = jest.fn(() => Promise.resolve({ data: updatedItem, error: null }));
  return builder;
}

jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => getUserResult },
    from: () => makeQueryBuilder(),
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
    updatedItem = null;
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

  it("schedules a fresh item 1 day out on 'good'", async () => {
    const res = await POST(makeRequest({ itemId: "item-1", grade: "good" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.item.repetitions).toBe(1);
    expect(body.item.interval_days).toBe(1);
  });

  it("returns 404 when the item doesn't belong to the user", async () => {
    existingItem = null;
    const res = await POST(makeRequest({ itemId: "missing", grade: "good" }));
    expect(res.status).toBe(404);
  });
});
