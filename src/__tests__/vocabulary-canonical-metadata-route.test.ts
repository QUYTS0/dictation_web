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

import { POST, PATCH } from "@/app/api/vocabulary/route";
import { translateText } from "@/lib/translate";
import { lookupWordDetails } from "@/lib/dictionary";
import { lookupWordImage } from "@/lib/image";

const mockTranslateText = translateText as jest.Mock;
const mockLookupWordDetails = lookupWordDetails as jest.Mock;
const mockLookupWordImage = lookupWordImage as jest.Mock;

function makePostRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/vocabulary", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function makePatchRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/vocabulary", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

/** Simulates real Postgres update-only-listed-columns behavior: `.update()`
 *  merges its payload onto whatever row already exists rather than
 *  replacing it wholesale — this is load-bearing for the "omitted field
 *  preserves existing value" tests below to mean anything. */
function makeBuilder(existingRow: Record<string, unknown> | null) {
  const builder: Record<string, jest.Mock> = {};
  const chain = () => builder;
  let row: Record<string, unknown> | null = existingRow;

  builder.select = jest.fn(chain);
  builder.match = jest.fn(chain);
  builder.eq = jest.fn(chain);
  // Real Supabase returns whatever columns were .select()-ed; POST's dedupe
  // check only reads .id off this, PATCH's own lookup reads the full row —
  // returning the full row here satisfies both without tracking which
  // .select() arg was used.
  builder.maybeSingle = jest.fn(() => Promise.resolve({ data: existingRow, error: null }));
  builder.insert = jest.fn((payload: Record<string, unknown>) => {
    row = { id: "item-new", ...payload };
    return builder;
  });
  builder.update = jest.fn((payload: Record<string, unknown>) => {
    row = { ...(row ?? {}), ...payload };
    return builder;
  });
  builder.single = jest.fn(() => Promise.resolve({ data: row, error: null }));
  return builder;
}

function setupExisting(existingRow: Record<string, unknown> | null) {
  fromMock.mockImplementation(() => makeBuilder(existingRow));
}

beforeEach(() => {
  getUserResult = { data: { user: mockUser } };
  jest.clearAllMocks();
  mockLookupWordDetails.mockResolvedValue(null);
  mockLookupWordImage.mockResolvedValue(null);
  mockTranslateText.mockResolvedValue({ text: "translated", source: "azure" });
});

const baseBody = {
  videoId: "v1",
  segmentIndex: 0,
  term: "given up",
  sentenceContext: "He has given up.",
};

describe("POST /api/vocabulary — canonical metadata persistence", () => {
  it("1. new save with both canonical fields writes both", async () => {
    setupExisting(null);
    const res = await POST(makePostRequest({ ...baseBody, canonicalForm: "give up", learningPattern: "give up + object" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.item.canonical_form).toBe("give up");
    expect(body.item.learning_pattern).toBe("give up + object");
  });

  it("2. new save without either field writes null/null", async () => {
    setupExisting(null);
    const res = await POST(makePostRequest(baseBody));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.item.canonical_form).toBeNull();
    expect(body.item.learning_pattern).toBeNull();
  });

  it("3. existing item with no canonical metadata backfills it on a later save that supplies it", async () => {
    setupExisting({
      id: "item-1",
      term: "given up",
      canonical_form: null,
      learning_pattern: null,
    });

    const res = await POST(makePostRequest({ ...baseBody, canonicalForm: "give up", learningPattern: "give up + object" }));
    const body = await res.json();

    expect(body.item.canonical_form).toBe("give up");
    expect(body.item.learning_pattern).toBe("give up + object");
  });

  it("4. existing item WITH canonical metadata, re-saved WITHOUT it, keeps the existing metadata (never nulled)", async () => {
    setupExisting({
      id: "item-1",
      term: "given up",
      canonical_form: "give up",
      learning_pattern: "give up + object",
    });

    // e.g. a manual re-selection of the same text with no highlight match —
    // the request simply omits canonicalForm/learningPattern entirely.
    const res = await POST(makePostRequest(baseBody));
    const body = await res.json();

    expect(body.item.canonical_form).toBe("give up");
    expect(body.item.learning_pattern).toBe("give up + object");
  });

  it("6. rejects a non-string canonicalForm with 400 and performs no write", async () => {
    setupExisting(null);
    const res = await POST(makePostRequest({ ...baseBody, canonicalForm: { not: "a string" } }));

    expect(res.status).toBe(400);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("6b. rejects a non-string learningPattern with 400 and performs no write", async () => {
    setupExisting(null);
    const res = await POST(makePostRequest({ ...baseBody, learningPattern: 123 }));

    expect(res.status).toBe(400);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("normalizes whitespace in a supplied canonicalForm", async () => {
    setupExisting(null);
    const res = await POST(makePostRequest({ ...baseBody, canonicalForm: "  give   up  " }));
    const body = await res.json();

    expect(body.item.canonical_form).toBe("give up");
  });

  it("truncates an over-long canonicalForm rather than rejecting it", async () => {
    setupExisting(null);
    const longValue = "x".repeat(500);
    const res = await POST(makePostRequest({ ...baseBody, canonicalForm: longValue }));
    const body = await res.json();

    expect(body.item.canonical_form.length).toBe(200);
  });
});

describe("PATCH /api/vocabulary — note-only edits preserve canonical metadata", () => {
  it("5. a note-only update never touches canonical_form/learning_pattern (VocabularyUpdateRequest doesn't carry them)", async () => {
    setupExisting({
      id: "item-1",
      user_id: "user-1",
      term: "given up",
      normalized_term: "given up",
      sentence_context: "He has given up.",
      canonical_form: "give up",
      learning_pattern: "give up + object",
    });

    const res = await PATCH(makePatchRequest({ id: "item-1", note: "remember this one" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.item.canonical_form).toBe("give up");
    expect(body.item.learning_pattern).toBe("give up + object");
    expect(body.item.note).toBe("remember this one");
  });
});

describe("PATCH /api/vocabulary — term-change invalidates term-derived metadata", () => {
  function existingRowWithFullMetadata() {
    return {
      id: "item-1",
      user_id: "user-1",
      term: "run",
      normalized_term: "run",
      sentence_context: "I like to run.",
      canonical_form: "run",
      learning_pattern: "run + object",
      audio_url: "https://example.com/run.mp3",
      pronunciation_audio_asset_id: "asset-1",
      phonetic: "/rʌn/",
      part_of_speech: "verb",
      definition: "to move fast",
      definition_source: "free_dictionary",
    };
  }

  it("nulls canonical_form/learning_pattern/audio_url/pronunciation_audio_asset_id/phonetic/part_of_speech/definition/definition_source when the normalized term actually changes", async () => {
    setupExisting(existingRowWithFullMetadata());

    const res = await PATCH(makePatchRequest({ id: "item-1", term: "sprint" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.item.canonical_form).toBeNull();
    expect(body.item.learning_pattern).toBeNull();
    expect(body.item.audio_url).toBeNull();
    expect(body.item.pronunciation_audio_asset_id).toBeNull();
    expect(body.item.phonetic).toBeNull();
    expect(body.item.part_of_speech).toBeNull();
    expect(body.item.definition).toBeNull();
    expect(body.item.definition_source).toBeNull();
  });

  it("does NOT invalidate anything when the submitted term normalizes to the same value (e.g. whitespace/case-only difference)", async () => {
    setupExisting(existingRowWithFullMetadata());

    const res = await PATCH(makePatchRequest({ id: "item-1", term: "  Run  " }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.item.canonical_form).toBe("run");
    expect(body.item.audio_url).toBe("https://example.com/run.mp3");
    expect(body.item.pronunciation_audio_asset_id).toBe("asset-1");
  });

  it("leaves term-derived metadata untouched when only note/translation change (regression for existing preserve behavior)", async () => {
    setupExisting(existingRowWithFullMetadata());

    const res = await PATCH(makePatchRequest({ id: "item-1", note: "keep practicing", translation: "chạy" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.item.canonical_form).toBe("run");
    expect(body.item.audio_url).toBe("https://example.com/run.mp3");
    expect(body.item.pronunciation_audio_asset_id).toBe("asset-1");
    expect(body.item.phonetic).toBe("/rʌn/");
  });
});

describe("PATCH /api/vocabulary — legacy canonical-form backfill (heading/pronunciation consistency)", () => {
  it("fills canonical_form/learning_pattern when the persisted values are null and the term isn't changing", async () => {
    setupExisting({
      id: "item-1",
      user_id: "user-1",
      term: "jumped at",
      normalized_term: "jumped at",
      sentence_context: "She jumped at the opportunity.",
      canonical_form: null,
      learning_pattern: null,
    });

    const res = await PATCH(
      makePatchRequest({ id: "item-1", canonicalForm: "jump at", learningPattern: "jump at + object" })
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.item.canonical_form).toBe("jump at");
    expect(body.item.learning_pattern).toBe("jump at + object");
  });

  it("never overwrites an existing, already-verified canonical_form with a backfill value", async () => {
    setupExisting({
      id: "item-1",
      user_id: "user-1",
      term: "given up",
      normalized_term: "given up",
      sentence_context: "He has given up.",
      canonical_form: "give up",
      learning_pattern: "give up + object",
    });

    const res = await PATCH(makePatchRequest({ id: "item-1", canonicalForm: "some other form" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.item.canonical_form).toBe("give up");
  });

  it("does not apply a backfill value when the term is changing in the same request — term-change invalidation wins", async () => {
    setupExisting({
      id: "item-1",
      user_id: "user-1",
      term: "jumped at",
      normalized_term: "jumped at",
      sentence_context: "She jumped at the opportunity.",
      canonical_form: null,
      learning_pattern: null,
    });

    const res = await PATCH(makePatchRequest({ id: "item-1", term: "sprint", canonicalForm: "jump at" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.item.canonical_form).toBeNull();
  });

  it("rejects a non-string canonicalForm backfill with 400", async () => {
    setupExisting({ id: "item-1", user_id: "user-1", term: "jumped at", normalized_term: "jumped at" });

    const res = await PATCH(makePatchRequest({ id: "item-1", canonicalForm: { not: "a string" } }));

    expect(res.status).toBe(400);
  });
});
