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

jest.mock("@/lib/translate", () => ({ translateText: jest.fn() }));
jest.mock("@/lib/dictionary", () => ({ lookupWordDetails: jest.fn() }));
jest.mock("@/lib/image", () => ({ lookupWordImage: jest.fn() }));

import { POST } from "@/app/api/vocabulary/route";
import { translateText } from "@/lib/translate";
import { lookupWordDetails } from "@/lib/dictionary";
import { lookupWordImage } from "@/lib/image";

const mockTranslateText = translateText as jest.Mock;
const mockLookupWordDetails = lookupWordDetails as jest.Mock;
const mockLookupWordImage = lookupWordImage as jest.Mock;

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/vocabulary", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function makeSaveBuilder() {
  const builder: Record<string, jest.Mock> = {};
  const chain = () => builder;
  let saved: Record<string, unknown> | null = null;
  builder.select = jest.fn(chain);
  builder.match = jest.fn(chain);
  builder.eq = jest.fn(chain);
  builder.maybeSingle = jest.fn(() => Promise.resolve({ data: null, error: null }));
  builder.insert = jest.fn((payload: Record<string, unknown>) => {
    saved = { id: "item-new", ...payload };
    return builder;
  });
  builder.single = jest.fn(() => Promise.resolve({ data: saved, error: null }));
  return builder;
}

beforeEach(() => {
  getUserResult = { data: { user: mockUser } };
  jest.clearAllMocks();
  fromMock.mockImplementation(() => makeSaveBuilder());
  mockLookupWordDetails.mockResolvedValue(null);
  mockLookupWordImage.mockResolvedValue(null);
});

const baseBody = {
  videoId: "v1",
  segmentIndex: 0,
  term: "run",
  sentenceContext: "I like to run.",
};

describe("POST /api/vocabulary (save)", () => {
  it("saves successfully even when translation fails (never blocks the save)", async () => {
    mockTranslateText.mockRejectedValue(new Error("Azure is down"));

    const res = await POST(makeRequest(baseBody));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.item.translation).toBeNull();
    expect(body.item.translation_source).toBeNull();
  });

  it("saves the Azure translation and marks its source as azure", async () => {
    mockTranslateText.mockResolvedValue({ text: "chạy", source: "azure" });

    const res = await POST(makeRequest(baseBody));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.item.translation).toBe("chạy");
    expect(body.item.translation_source).toBe("azure");
  });

  it("reuses a precomputed translation from the popover preview instead of calling translateText again", async () => {
    const res = await POST(
      makeRequest({ ...baseBody, translation: "chạy", translationSource: "azure" })
    );
    const body = await res.json();

    expect(mockTranslateText).not.toHaveBeenCalled();
    expect(body.item.translation).toBe("chạy");
    expect(body.item.translation_source).toBe("azure");
  });

  it("defaults a precomputed translation with no explicit source to azure", async () => {
    const res = await POST(makeRequest({ ...baseBody, translation: "chạy" }));
    const body = await res.json();

    expect(body.item.translation_source).toBe("azure");
  });
});
