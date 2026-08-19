const mockUser = { id: "user-1" };
let getUserResult: { data: { user: typeof mockUser | null } } = { data: { user: mockUser } };
let attemptRows: { error_type: string | null }[] = [];

function makeQueryBuilder() {
  const builder: Record<string, jest.Mock> = {};
  const chain = () => builder;
  builder.select = jest.fn(chain);
  builder.eq = jest.fn(chain);
  builder.not = jest.fn(() => Promise.resolve({ data: attemptRows, error: null }));
  return builder;
}

jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => getUserResult },
    from: () => makeQueryBuilder(),
  }),
}));

import { GET } from "@/app/api/dashboard/error-patterns/route";

describe("GET /api/dashboard/error-patterns", () => {
  beforeEach(() => {
    getUserResult = { data: { user: mockUser } };
    attemptRows = [];
  });

  it("returns 401 when not authenticated", async () => {
    getUserResult = { data: { user: null } };
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns an empty pattern list when there are no mistakes", async () => {
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.total).toBe(0);
    expect(body.patterns).toEqual([]);
  });

  it("aggregates counts per error type, sorted descending", async () => {
    attemptRows = [
      { error_type: "missing_word" },
      { error_type: "punctuation" },
      { error_type: "missing_word" },
      { error_type: "missing_word" },
    ];
    const res = await GET();
    const body = await res.json();
    expect(body.total).toBe(4);
    expect(body.patterns).toEqual([
      { errorType: "missing_word", count: 3, percentage: 75 },
      { errorType: "punctuation", count: 1, percentage: 25 },
    ]);
  });
});
