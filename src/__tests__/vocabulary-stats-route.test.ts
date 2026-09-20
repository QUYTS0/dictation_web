const mockUser = { id: "user-1" };
let getUserResult: { data: { user: typeof mockUser | null } } = { data: { user: mockUser } };
// Queue of { count, error } results consumed in call order. The route issues
// its five count queries (total, new, due, learning, reviewable) inside one
// `Promise.all([...])` array literal, which evaluates left-to-right, so
// `from()` is called in that exact, deterministic order.
let countQueue: Array<{ count: number | null; error: unknown }> = [];

function makeQueryBuilder(result: { count: number | null; error: unknown }) {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  builder.select = jest.fn(chain);
  builder.eq = jest.fn(chain);
  builder.is = jest.fn(chain);
  builder.not = jest.fn(chain);
  builder.lte = jest.fn(chain);
  builder.gt = jest.fn(chain);
  // Mimics supabase-js's PostgrestFilterBuilder: awaitable directly, with no
  // terminal .single()/.limit() call for a head-count-only query.
  builder.then = (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve);
  return builder;
}

jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => getUserResult },
    from: () => makeQueryBuilder(countQueue.shift() ?? { count: 0, error: null }),
  }),
}));

import { GET } from "@/app/api/vocabulary/stats/route";

describe("GET /api/vocabulary/stats", () => {
  beforeEach(() => {
    getUserResult = { data: { user: mockUser } };
    countQueue = [];
  });

  it("returns 401 when not authenticated", async () => {
    getUserResult = { data: { user: null } };
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns total/new/due/learning/reviewable from independent exact counts", async () => {
    countQueue = [
      { count: 254, error: null }, // total
      { count: 40, error: null }, // new
      { count: 12, error: null }, // due
      { count: 202, error: null }, // learning
      { count: 52, error: null }, // reviewable (new + due, but computed independently)
    ];
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ total: 254, new: 40, due: 12, learning: 202, reviewable: 52 });
  });

  it("defaults a null count to 0", async () => {
    countQueue = [
      { count: null, error: null },
      { count: null, error: null },
      { count: null, error: null },
      { count: null, error: null },
      { count: null, error: null },
    ];
    const res = await GET();
    const body = await res.json();
    expect(body).toEqual({ total: 0, new: 0, due: 0, learning: 0, reviewable: 0 });
  });

  it("returns 500 when any of the count queries errors", async () => {
    countQueue = [
      { count: 254, error: null },
      { count: 0, error: new Error("boom") },
      { count: 0, error: null },
      { count: 0, error: null },
      { count: 0, error: null },
    ];
    const res = await GET();
    expect(res.status).toBe(500);
  });

  it("returns 500 when only the reviewable count query errors", async () => {
    countQueue = [
      { count: 254, error: null },
      { count: 40, error: null },
      { count: 12, error: null },
      { count: 202, error: null },
      { count: 0, error: new Error("boom") },
    ];
    const res = await GET();
    expect(res.status).toBe(500);
  });
});
