import { escapeCsvField, buildCsvRow } from "@/lib/utils/csv";

describe("csv utils", () => {
  it("leaves plain fields unquoted", () => {
    expect(escapeCsvField("hello")).toBe("hello");
  });

  it("quotes and escapes fields containing commas, quotes, or newlines", () => {
    expect(escapeCsvField('say "hi", ok')).toBe('"say ""hi"", ok"');
    expect(escapeCsvField("line1\nline2")).toBe('"line1\nline2"');
  });

  it("builds a comma-joined row with per-field escaping", () => {
    expect(buildCsvRow(["Front", "Back, with comma", "Tags"])).toBe('Front,"Back, with comma",Tags');
  });
});

const mockUser = { id: "user-1" };
let getUserResult: { data: { user: typeof mockUser | null } } = { data: { user: mockUser } };
let vocabRows: { term: string; sentence_context: string; note: string | null; video_id: string }[] = [];

function makeQueryBuilder() {
  const builder: Record<string, jest.Mock> = {};
  const chain = () => builder;
  builder.select = jest.fn(chain);
  builder.eq = jest.fn(chain);
  builder.order = jest.fn(() => Promise.resolve({ data: vocabRows, error: null }));
  return builder;
}

jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => getUserResult },
    from: () => makeQueryBuilder(),
  }),
}));

import { GET } from "@/app/api/vocabulary/export/route";

describe("GET /api/vocabulary/export", () => {
  beforeEach(() => {
    getUserResult = { data: { user: mockUser } };
    vocabRows = [];
  });

  it("returns 401 when not authenticated", async () => {
    getUserResult = { data: { user: null } };
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns a header-only CSV when there is no vocabulary", async () => {
    const res = await GET();
    const text = await res.text();
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(res.headers.get("Content-Disposition")).toContain("vocabulary-anki-export.csv");
    expect(text).toBe("Front,Back,Tags");
  });

  it("maps term/sentence_context/note/video_id to Front/Back/Tags", async () => {
    vocabRows = [
      { term: "hello", sentence_context: "Hello, world", note: "greeting", video_id: "abc-123" },
    ];
    const res = await GET();
    const text = await res.text();
    const lines = text.split("\r\n");
    expect(lines[0]).toBe("Front,Back,Tags");
    expect(lines[1]).toBe('hello,"Hello, world<br>greeting",abc-123');
  });

  it("sanitizes video ids into safe Anki tags", async () => {
    vocabRows = [{ term: "hi", sentence_context: "Hi there", note: null, video_id: "abc def!" }];
    const res = await GET();
    const text = await res.text();
    expect(text.split("\r\n")[1]).toBe("hi,Hi there,abc_def_");
  });
});
