/**
 * End-to-end regression coverage for the confirmed bug: pronunciation audio
 * could get synthesized again for an item that had already played it once.
 *
 * Root cause (see "Vocabulary Audio Audit and Azure TTS Plan.md"): a legacy
 * row's canonical_form starts out null, so its first-ever pronunciation
 * resolves and links an asset keyed on `term`. VocabularyDetailDialog's
 * legacy backfill effect later PATCHes canonical_form in (still keyed to
 * the exact same value the client already resolved via the highlight
 * cache) — which flips the item's EFFECTIVE pronunciation text from `term`
 * to `canonical_form`. The PATCH route's old payload only invalidated
 * audio_url/pronunciation_audio_asset_id when `term` itself changed, so the
 * stale term-keyed link survived the backfill — and the next tap silently
 * resolved a different (canonical_form-keyed) identity, missing every
 * cache and paying for a real Azure call for audio the user had just heard.
 *
 * Unlike the route-level unit tests (which mock vocabularyAudioCache.ts
 * entirely), this file exercises the REAL cache module against a small
 * in-memory fake standing in for both the anon-key and service-role
 * Supabase clients (sharing one table so a write through one is visible to
 * a read through the other, the way two real Postgres roles against the
 * same table would be) — the closest this test suite gets to a real
 * database without one. Azure itself is still mocked (no real quota
 * consumed); Storage is a fake in-memory object map.
 */
import { NextRequest } from "next/server";

// ---- Minimal in-memory fake standing in for a Supabase table + query builder ----
// Supports exactly the chain shapes vocabulary/route.ts, vocabulary/pronounce/
// route.ts, and vocabularyAudioCache.ts actually issue: .select().eq()/.is()
// .../.maybeSingle()|.single(), .update(payload)...(awaited directly or via
// .select().single()), .insert(payload).select().single(),
// .upsert(payload, {onConflict}).select().single().
type Row = Record<string, unknown>;

class FakeTable {
  rows: Row[] = [];
}

class FakeQueryBuilder implements PromiseLike<{ data: unknown; error: null }> {
  private filters: Array<{ col: string; val: unknown; op: "eq" | "is" }> = [];
  private op: "select" | "update" | "insert" | "upsert" | null = "select";
  private payload: Row | null = null;
  private terminal: "maybeSingle" | "single" | null = null;
  private onConflictCols: string[] | null = null;

  constructor(private table: FakeTable) {}

  eq(col: string, val: unknown) {
    this.filters.push({ col, val, op: "eq" });
    return this;
  }
  is(col: string, val: unknown) {
    this.filters.push({ col, val, op: "is" });
    return this;
  }
  match(obj: Row) {
    for (const [col, val] of Object.entries(obj)) this.filters.push({ col, val, op: "eq" });
    return this;
  }
  select() {
    if (this.op === null) this.op = "select";
    return this;
  }
  maybeSingle() {
    this.terminal = "maybeSingle";
    return this.run();
  }
  single() {
    this.terminal = "single";
    return this.run();
  }
  update(payload: Row) {
    this.op = "update";
    this.payload = payload;
    return this;
  }
  insert(payload: Row) {
    this.op = "insert";
    this.payload = { id: `row-${this.table.rows.length + 1}`, ...payload };
    return this;
  }
  upsert(payload: Row, opts: { onConflict: string }) {
    this.op = "upsert";
    this.payload = payload;
    this.onConflictCols = opts.onConflict.split(",");
    return this;
  }

  private matches(row: Row): boolean {
    return this.filters.every(({ col, val, op }) => (op === "is" ? row[col] === val : row[col] === val));
  }

  private applyAndCollect(): Row[] {
    if (this.op === "insert" && this.payload) {
      this.table.rows.push(this.payload);
      return [this.payload];
    }
    if (this.op === "upsert" && this.payload && this.onConflictCols) {
      const existingIdx = this.table.rows.findIndex((row) =>
        this.onConflictCols!.every((col) => row[col] === this.payload![col])
      );
      if (existingIdx === -1) {
        const created = { id: `row-${this.table.rows.length + 1}`, ...this.payload };
        this.table.rows.push(created);
        return [created];
      }
      this.table.rows[existingIdx] = { ...this.table.rows[existingIdx], ...this.payload };
      return [this.table.rows[existingIdx]];
    }
    const matched = this.table.rows.filter((row) => this.matches(row));
    if (this.op === "update" && this.payload) {
      for (const row of matched) Object.assign(row, this.payload);
    }
    return matched;
  }

  private run(): Promise<{ data: unknown; error: null }> {
    const matched = this.applyAndCollect();
    if (this.terminal === "single") return Promise.resolve({ data: matched[0] ?? null, error: null });
    if (this.terminal === "maybeSingle") return Promise.resolve({ data: matched[0] ?? null, error: null });
    return Promise.resolve({ data: matched, error: null });
  }

  // Makes a bare `await builder.update(...).eq(...)` (no terminal .select())
  // resolve the same way linkAssetToItem/touchAudioAsset use it.
  then<TResult1 = { data: unknown; error: null }, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return this.run().then(onfulfilled, onrejected);
  }
}

const vocabularyItemsTable = new FakeTable();
const vocabularyAudioAssetsTable = new FakeTable();
const fakeStorageObjects = new Set<string>();

function fakeFrom(tableName: string) {
  if (tableName === "vocabulary_items") return new FakeQueryBuilder(vocabularyItemsTable) as unknown;
  if (tableName === "vocabulary_audio_assets") return new FakeQueryBuilder(vocabularyAudioAssetsTable) as unknown;
  throw new Error(`unexpected table in fake: ${tableName}`);
}

const fakeStorage = {
  from: () => ({
    upload: (path: string) => {
      fakeStorageObjects.add(path);
      return Promise.resolve({ error: null });
    },
    createSignedUrl: (path: string) => {
      if (!fakeStorageObjects.has(path)) {
        return Promise.resolve({ data: null, error: { message: "Object not found", statusCode: "404" } });
      }
      return Promise.resolve({ data: { signedUrl: `https://fake-storage.example.com/${path}` }, error: null });
    },
  }),
};

const mockUser = { id: "user-1" };

jest.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: mockUser } }) },
    from: (table: string) => fakeFrom(table),
  }),
  createServiceClient: () => ({
    from: (table: string) => fakeFrom(table),
    storage: fakeStorage,
  }),
}));

jest.mock("@/lib/translate", () => ({ translateText: jest.fn() }));
jest.mock("@/lib/dictionary", () => ({ lookupWordDetails: jest.fn() }));
jest.mock("@/lib/image", () => ({ lookupWordImage: jest.fn() }));

jest.mock("@/lib/rateLimit", () => ({
  checkRateLimit: jest.fn(async () => null),
  checkAzureTtsQuota: jest.fn(async () => ({ allowed: true })),
  checkAzureTtsRate: jest.fn(async () => ({ allowed: true })),
  isQuotaBackendConfigured: jest.fn(() => true),
  isProductionEnvironment: jest.fn(() => false),
}));

jest.mock("@/lib/azureTts", () => {
  const actual = jest.requireActual("@/lib/azureTts");
  return {
    ...actual,
    isAzureTtsConfigured: jest.fn(() => true),
    synthesizeSpeech: jest.fn(async () => ({ audio: Buffer.from("fake-mp3-bytes"), contentType: "audio/mpeg" })),
  };
});

import { PATCH } from "@/app/api/vocabulary/route";
import { POST as pronounce } from "@/app/api/vocabulary/pronounce/route";
import { synthesizeSpeech } from "@/lib/azureTts";

const mockSynthesize = synthesizeSpeech as jest.Mock;

function pronounceRequest(body: unknown) {
  return new NextRequest("http://localhost/api/vocabulary/pronounce", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function patchRequest(body: unknown) {
  return new NextRequest("http://localhost/api/vocabulary", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vocabularyItemsTable.rows.length = 0;
  vocabularyAudioAssetsTable.rows.length = 0;
  fakeStorageObjects.clear();
  mockSynthesize.mockClear();
});

describe("pronunciation persistence across the backfill race (end-to-end, real cache module)", () => {
  it("does not resynthesize once canonical_form settles: exactly one Azure call across pre-backfill play, backfill, and every later request", async () => {
    // A legacy phrase saved before the canonical-metadata migration existed
    // for this row: canonical_form/pronunciation_audio_asset_id both null.
    vocabularyItemsTable.rows.push({
      id: "item-1",
      user_id: "user-1",
      term: "given up",
      normalized_term: "given up",
      sentence_context: "He has given up.",
      canonical_form: null,
      learning_pattern: null,
      audio_url: null,
      pronunciation_audio_asset_id: null,
    });

    // 1) First-ever tap, BEFORE the client's backfill PATCH has landed —
    // resolves/synthesizes under `term` ("given up").
    const first = await pronounce(pronounceRequest({ itemId: "item-1" }));
    expect(first.status).toBe(200);
    expect(mockSynthesize).toHaveBeenCalledTimes(1);
    expect(mockSynthesize).toHaveBeenCalledWith(expect.objectContaining({ text: "given up" }));

    // 2) The dialog's backfill effect now persists the highlight-cache-
    // resolved canonical form — the fix under test invalidates the stale
    // term-keyed link as part of this same PATCH.
    const backfill = await PATCH(patchRequest({ id: "item-1", canonicalForm: "give up" }));
    expect(backfill.status).toBe(200);
    const afterBackfill = vocabularyItemsTable.rows[0];
    expect(afterBackfill.canonical_form).toBe("give up");
    expect(afterBackfill.pronunciation_audio_asset_id).toBeNull();

    // 3) Next tap: the effective text is now "give up", genuinely different
    // from the previously-cached "given up" — ONE more synthesis is
    // expected and correct here (a real different pronunciation identity),
    // not a bug. This call also links the new asset back to the item.
    const second = await pronounce(pronounceRequest({ itemId: "item-1" }));
    expect(second.status).toBe(200);
    expect(mockSynthesize).toHaveBeenCalledTimes(2);
    expect(mockSynthesize).toHaveBeenLastCalledWith(expect.objectContaining({ text: "give up" }));
    expect(vocabularyItemsTable.rows[0].pronunciation_audio_asset_id).not.toBeNull();

    // 4) Every subsequent request for this item — simulating close/reopen,
    // a page reload, signing out and back in, or a different device (all of
    // which start with nothing but the itemId and hit this same route) —
    // must reuse the linked asset with NO further Azure calls.
    for (let i = 0; i < 3; i++) {
      const replay = await pronounce(pronounceRequest({ itemId: "item-1" }));
      const body = await replay.json();
      expect(replay.status).toBe(200);
      expect(body.source).toBe("cached");
    }
    expect(mockSynthesize).toHaveBeenCalledTimes(2);
  });

  it("a second saved item needing the exact same final pronunciation reuses the shared asset with no additional Azure call", async () => {
    vocabularyItemsTable.rows.push(
      {
        id: "item-1",
        user_id: "user-1",
        term: "given up",
        normalized_term: "given up",
        canonical_form: "give up",
        pronunciation_audio_asset_id: null,
      },
      {
        id: "item-2",
        user_id: "user-1",
        term: "give up",
        normalized_term: "give up",
        canonical_form: null,
        pronunciation_audio_asset_id: null,
      }
    );

    const first = await pronounce(pronounceRequest({ itemId: "item-1" }));
    expect(first.status).toBe(200);
    expect(mockSynthesize).toHaveBeenCalledTimes(1);

    // Different saved item, different surface term, but the SAME resolved
    // pronunciation text ("give up") — must hit the shared cache, not
    // synthesize a duplicate clip.
    const second = await pronounce(pronounceRequest({ itemId: "item-2" }));
    const body = await second.json();
    expect(second.status).toBe(200);
    expect(body.source).toBe("cached");
    expect(mockSynthesize).toHaveBeenCalledTimes(1);
  });

  it("editing the term after synthesis invalidates the link and the NEW text synthesizes independently, without corrupting the old shared asset", async () => {
    vocabularyItemsTable.rows.push({
      id: "item-1",
      user_id: "user-1",
      term: "run",
      normalized_term: "run",
      sentence_context: "I like to run.",
      canonical_form: null,
      audio_url: null,
      pronunciation_audio_asset_id: null,
    });

    await pronounce(pronounceRequest({ itemId: "item-1" }));
    expect(mockSynthesize).toHaveBeenCalledTimes(1);
    expect(vocabularyItemsTable.rows[0].pronunciation_audio_asset_id).not.toBeNull();

    await PATCH(patchRequest({ id: "item-1", term: "sprint" }));
    expect(vocabularyItemsTable.rows[0].pronunciation_audio_asset_id).toBeNull();
    expect(vocabularyItemsTable.rows[0].normalized_term).toBe("sprint");

    const afterEdit = await pronounce(pronounceRequest({ itemId: "item-1" }));
    const body = await afterEdit.json();
    expect(body.source).toBe("synthesized");
    expect(mockSynthesize).toHaveBeenCalledTimes(2);
    expect(mockSynthesize).toHaveBeenLastCalledWith(expect.objectContaining({ text: "sprint" }));

    // The original "run" asset is still sitting in the shared cache,
    // untouched and reusable by any other item that still needs it.
    expect(vocabularyAudioAssetsTable.rows.some((r) => r.normalized_text === "run")).toBe(true);
  });
});
