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

jest.mock("@/lib/azureTts", () => {
  const actual = jest.requireActual("@/lib/azureTts");
  return {
    ...actual,
    isAzureTtsConfigured: jest.fn(() => true),
    synthesizeSpeech: jest.fn(),
  };
});

jest.mock("@/lib/vocabularyAudioCache", () => {
  const actual = jest.requireActual("@/lib/vocabularyAudioCache");
  return {
    ...actual,
    getCachedAudioAsset: jest.fn(),
    getAudioAssetById: jest.fn(),
    cacheAudioAsset: jest.fn(),
    resolvePlaybackUrl: jest.fn((path: string) => Promise.resolve(`https://cdn.example.com/${path}`)),
    touchAudioAsset: jest.fn(),
  };
});

jest.mock("@/lib/rateLimit", () => ({
  checkAzureTtsQuota: jest.fn(() => Promise.resolve({ allowed: true })),
  checkAzureTtsRate: jest.fn(() => Promise.resolve({ allowed: true })),
  isQuotaBackendConfigured: jest.fn(() => true),
  isProductionEnvironment: jest.fn(() => false),
}));

import { POST } from "@/app/api/vocabulary/pronounce/route";
import { isAzureTtsConfigured, synthesizeSpeech, AzureTtsError } from "@/lib/azureTts";
import {
  cacheAudioAsset,
  getAudioAssetById,
  getCachedAudioAsset,
  touchAudioAsset,
} from "@/lib/vocabularyAudioCache";
import { checkAzureTtsQuota, checkAzureTtsRate, isProductionEnvironment, isQuotaBackendConfigured } from "@/lib/rateLimit";

const mockIsConfigured = isAzureTtsConfigured as jest.Mock;
const mockSynthesize = synthesizeSpeech as jest.Mock;
const mockGetCached = getCachedAudioAsset as jest.Mock;
const mockGetById = getAudioAssetById as jest.Mock;
const mockCacheAsset = cacheAudioAsset as jest.Mock;
const mockTouch = touchAudioAsset as jest.Mock;
const mockQuota = checkAzureTtsQuota as jest.Mock;
const mockRate = checkAzureTtsRate as jest.Mock;
const mockQuotaBackendConfigured = isQuotaBackendConfigured as jest.Mock;
const mockIsProduction = isProductionEnvironment as jest.Mock;

// The default synthesis identity the route resolves to (DEFAULT_TTS_VOICE/
// LOCALE/OUTPUT_FORMAT/TTS_SYNTHESIS_VERSION in azureTts.ts) — assets
// returned by mocks must carry this identity to be treated as current by
// assetMatchesKey (the real, un-mocked implementation).
const CURRENT_IDENTITY = {
  voice: "en-US-JennyNeural",
  locale: "en-US",
  outputFormat: "audio-24khz-48kbitrate-mono-mp3",
  synthesisVersion: "v1",
};

function currentAsset(id: string, storagePath: string, normalizedText: string, overrides: Record<string, unknown> = {}) {
  return { id, storagePath, normalizedText, ...CURRENT_IDENTITY, ...overrides };
}

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/vocabulary/pronounce", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function makeItemBuilder(item: Record<string, unknown> | null) {
  const builder: Record<string, jest.Mock> = {};
  const chain = () => builder;
  builder.select = jest.fn(chain);
  builder.eq = jest.fn(chain);
  builder.is = jest.fn(chain);
  builder.maybeSingle = jest.fn(() => Promise.resolve({ data: item, error: null }));
  builder.update = jest.fn(chain);
  return builder;
}

function baseItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "item-1",
    user_id: "user-1",
    term: "run",
    normalized_term: "run",
    canonical_form: null,
    audio_url: null,
    pronunciation_audio_asset_id: null,
    ...overrides,
  };
}

beforeEach(() => {
  getUserResult = { data: { user: mockUser } };
  jest.clearAllMocks();
  // mockReset (not just clearAllMocks, which only clears call history) so a
  // resolved/rejected implementation set by one test — e.g.
  // mockSynthesize.mockResolvedValue(...) — can never leak into a later
  // test that expects synthesis not to be reached at all. Scoped to just
  // these two mocks rather than jest.resetAllMocks(), which would also wipe
  // resolvePlaybackUrl's default factory implementation above.
  mockSynthesize.mockReset();
  mockCacheAsset.mockReset();
  mockIsConfigured.mockReturnValue(true);
  mockQuota.mockResolvedValue({ allowed: true });
  mockRate.mockResolvedValue({ allowed: true });
  mockQuotaBackendConfigured.mockReturnValue(true);
  mockIsProduction.mockReturnValue(false);
  mockGetCached.mockResolvedValue(null);
  mockGetById.mockResolvedValue(null);
});

describe("POST /api/vocabulary/pronounce — auth and lookup", () => {
  it("requires authentication", async () => {
    getUserResult = { data: { user: null } };
    const res = await POST(makeRequest({ itemId: "item-1" }));
    expect(res.status).toBe(401);
  });

  it("requires itemId", async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
  });

  it("returns NOT_FOUND when the item doesn't exist or isn't owned by the user", async () => {
    fromMock.mockReturnValue(makeItemBuilder(null));
    const res = await POST(makeRequest({ itemId: "item-1" }));
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(body.code).toBe("NOT_FOUND");
  });
});

describe("POST /api/vocabulary/pronounce — dictionary path", () => {
  it("returns dictionary audio directly for a single word with audio_url, never calling Azure", async () => {
    fromMock.mockReturnValue(makeItemBuilder(baseItem({ audio_url: "https://dict.example.com/run.mp3" })));
    const res = await POST(makeRequest({ itemId: "item-1" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ audioUrl: "https://dict.example.com/run.mp3", source: "dictionary" });
    expect(mockSynthesize).not.toHaveBeenCalled();
    expect(mockGetCached).not.toHaveBeenCalled();
  });

  it("does not use the dictionary shortcut for a multi-word term even if audio_url happens to be set", async () => {
    fromMock.mockReturnValue(
      makeItemBuilder(baseItem({ term: "give up", audio_url: "https://dict.example.com/give-up.mp3" }))
    );
    mockSynthesize.mockResolvedValue({ audio: Buffer.from("bytes"), contentType: "audio/mpeg" });
    mockCacheAsset.mockResolvedValue(currentAsset("asset-new", "azure/xyz.mp3", "give up"));

    const res = await POST(makeRequest({ itemId: "item-1" }));
    const body = await res.json();

    expect(body.source).toBe("synthesized");
    expect(mockSynthesize).toHaveBeenCalled();
  });

  it("skips the dictionary shortcut when preferGenerated is set (explicit recovery action)", async () => {
    fromMock.mockReturnValue(makeItemBuilder(baseItem({ audio_url: "https://dict.example.com/run-broken.mp3" })));
    mockSynthesize.mockResolvedValue({ audio: Buffer.from("bytes"), contentType: "audio/mpeg" });
    mockCacheAsset.mockResolvedValue(currentAsset("asset-new", "azure/run.mp3", "run"));

    const res = await POST(makeRequest({ itemId: "item-1", preferGenerated: true }));
    const body = await res.json();

    expect(body.source).toBe("synthesized");
    expect(mockSynthesize).toHaveBeenCalled();
  });
});

describe("POST /api/vocabulary/pronounce — already-linked asset (checked before dictionary)", () => {
  it("resolves via pronunciation_audio_asset_id without a fresh cache lookup", async () => {
    fromMock.mockReturnValue(makeItemBuilder(baseItem({ pronunciation_audio_asset_id: "asset-1" })));
    mockGetById.mockResolvedValue(currentAsset("asset-1", "azure/existing.mp3", "run"));

    const res = await POST(makeRequest({ itemId: "item-1" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ audioUrl: "https://cdn.example.com/azure/existing.mp3", source: "cached" });
    expect(mockTouch).toHaveBeenCalledWith("asset-1");
    expect(mockGetCached).not.toHaveBeenCalled();
    expect(mockSynthesize).not.toHaveBeenCalled();
  });

  it("prefers a previously-linked generated asset over dictionary audio (recovery flow keeps working on later opens)", async () => {
    fromMock.mockReturnValue(
      makeItemBuilder(
        baseItem({ audio_url: "https://dict.example.com/run-broken.mp3", pronunciation_audio_asset_id: "asset-1" })
      )
    );
    mockGetById.mockResolvedValue(currentAsset("asset-1", "azure/generated.mp3", "run"));

    const res = await POST(makeRequest({ itemId: "item-1" }));
    const body = await res.json();

    expect(body).toEqual({ audioUrl: "https://cdn.example.com/azure/generated.mp3", source: "cached" });
  });

  it("falls through to a fresh cache lookup when the linked asset is missing", async () => {
    fromMock.mockReturnValue(makeItemBuilder(baseItem({ term: "give up", normalized_term: "give up", pronunciation_audio_asset_id: "asset-stale" })));
    mockGetById.mockResolvedValue(null);
    mockGetCached.mockResolvedValue(currentAsset("asset-2", "azure/fresh.mp3", "give up"));

    const res = await POST(makeRequest({ itemId: "item-1" }));
    const body = await res.json();

    expect(body).toEqual({ audioUrl: "https://cdn.example.com/azure/fresh.mp3", source: "cached" });
  });

  it("falls through to a fresh cache lookup when the linked asset's identity no longer matches (e.g. after a synthesis_version bump)", async () => {
    fromMock.mockReturnValue(makeItemBuilder(baseItem({ term: "give up", normalized_term: "give up", pronunciation_audio_asset_id: "asset-old" })));
    mockGetById.mockResolvedValue(currentAsset("asset-old", "azure/old-version.mp3", "give up", { synthesisVersion: "v0" }));
    mockGetCached.mockResolvedValue(currentAsset("asset-current", "azure/current.mp3", "give up"));

    const res = await POST(makeRequest({ itemId: "item-1" }));
    const body = await res.json();

    expect(body).toEqual({ audioUrl: "https://cdn.example.com/azure/current.mp3", source: "cached" });
    expect(mockGetCached).toHaveBeenCalled();
  });

  it("falls through when the linked asset's identity matches but its Storage object can't be resolved (missing/broken)", async () => {
    const { resolvePlaybackUrl } = jest.requireMock("@/lib/vocabularyAudioCache");
    fromMock.mockReturnValue(makeItemBuilder(baseItem({ term: "give up", normalized_term: "give up", pronunciation_audio_asset_id: "asset-broken" })));
    mockGetById.mockResolvedValue(currentAsset("asset-broken", "azure/broken.mp3", "give up"));
    (resolvePlaybackUrl as jest.Mock).mockImplementationOnce(() => Promise.resolve(null));
    mockGetCached.mockResolvedValue(currentAsset("asset-current", "azure/current.mp3", "give up"));

    const res = await POST(makeRequest({ itemId: "item-1" }));
    const body = await res.json();

    expect(body).toEqual({ audioUrl: "https://cdn.example.com/azure/current.mp3", source: "cached" });
  });
});

describe("POST /api/vocabulary/pronounce — shared cache", () => {
  it("returns a shared cache hit without calling Azure, and links the asset back to the item", async () => {
    const builder = makeItemBuilder(baseItem({ term: "give up", normalized_term: "give up" }));
    fromMock.mockReturnValue(builder);
    mockGetCached.mockResolvedValue(currentAsset("asset-shared", "azure/shared.mp3", "give up"));

    const res = await POST(makeRequest({ itemId: "item-1" }));
    const body = await res.json();

    expect(body).toEqual({ audioUrl: "https://cdn.example.com/azure/shared.mp3", source: "cached" });
    expect(mockSynthesize).not.toHaveBeenCalled();
    expect(builder.update).toHaveBeenCalledWith({ pronunciation_audio_asset_id: "asset-shared" });
    // The link is conditional on the text this request actually resolved
    // for (Section 3 fix) — it must never be an unconditional update keyed
    // only on item id.
    expect(builder.eq).toHaveBeenCalledWith("normalized_term", "give up");
    expect(builder.is).toHaveBeenCalledWith("canonical_form", null);
  });

  it("guards the link with an explicit canonical_form equality check when one is persisted", async () => {
    const builder = makeItemBuilder(baseItem({ term: "given up", normalized_term: "given up", canonical_form: "give up" }));
    fromMock.mockReturnValue(builder);
    mockGetCached.mockResolvedValue(currentAsset("asset-shared", "azure/shared.mp3", "give up"));

    await POST(makeRequest({ itemId: "item-1" }));

    expect(builder.eq).toHaveBeenCalledWith("canonical_form", "give up");
  });

  it("uses canonical_form over the surface term when present", async () => {
    fromMock.mockReturnValue(makeItemBuilder(baseItem({ term: "given up", canonical_form: "give up" })));
    mockSynthesize.mockResolvedValue({ audio: Buffer.from("bytes"), contentType: "audio/mpeg" });
    mockCacheAsset.mockResolvedValue(currentAsset("asset-new", "azure/xyz.mp3", "give up"));

    await POST(makeRequest({ itemId: "item-1" }));

    expect(mockSynthesize).toHaveBeenCalledWith(expect.objectContaining({ text: "give up" }));
  });
});

describe("POST /api/vocabulary/pronounce — synthesis", () => {
  it("synthesizes, caches, and links the asset on a full miss", async () => {
    const builder = makeItemBuilder(baseItem({ term: "give up", normalized_term: "give up" }));
    fromMock.mockReturnValue(builder);
    mockSynthesize.mockResolvedValue({ audio: Buffer.from("bytes"), contentType: "audio/mpeg" });
    mockCacheAsset.mockResolvedValue(currentAsset("asset-new", "azure/new.mp3", "give up"));

    const res = await POST(makeRequest({ itemId: "item-1" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ audioUrl: "https://cdn.example.com/azure/new.mp3", source: "synthesized" });
    expect(builder.update).toHaveBeenCalledWith({ pronunciation_audio_asset_id: "asset-new" });
  });

  it("returns TTS_NOT_CONFIGURED without checking quota/rate or calling Azure when unconfigured", async () => {
    fromMock.mockReturnValue(makeItemBuilder(baseItem({ term: "give up" })));
    mockIsConfigured.mockReturnValue(false);

    const res = await POST(makeRequest({ itemId: "item-1" }));
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.code).toBe("TTS_NOT_CONFIGURED");
    expect(mockQuota).not.toHaveBeenCalled();
    expect(mockSynthesize).not.toHaveBeenCalled();
  });

  it("returns TTS_QUOTA_EXCEEDED and never calls Azure when the monthly budget is spent", async () => {
    fromMock.mockReturnValue(makeItemBuilder(baseItem({ term: "give up" })));
    mockQuota.mockResolvedValue({ allowed: false, retryAfterSec: 100 });

    const res = await POST(makeRequest({ itemId: "item-1" }));
    const body = await res.json();

    expect(res.status).toBe(429);
    expect(body.code).toBe("TTS_QUOTA_EXCEEDED");
    expect(mockSynthesize).not.toHaveBeenCalled();
  });

  it("returns TTS_RATE_LIMITED and never calls Azure when the shared rate limit is hit", async () => {
    fromMock.mockReturnValue(makeItemBuilder(baseItem({ term: "give up" })));
    mockRate.mockResolvedValue({ allowed: false, retryAfterSec: 5 });

    const res = await POST(makeRequest({ itemId: "item-1" }));
    const body = await res.json();

    expect(res.status).toBe(429);
    expect(body.code).toBe("TTS_RATE_LIMITED");
    expect(mockSynthesize).not.toHaveBeenCalled();
  });

  it("maps a thrown AzureTtsError's code onto the response and never caches", async () => {
    fromMock.mockReturnValue(makeItemBuilder(baseItem({ term: "give up" })));
    mockSynthesize.mockRejectedValue(new AzureTtsError("upstream failed", "TTS_UPSTREAM_ERROR", 500));

    const res = await POST(makeRequest({ itemId: "item-1" }));
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.code).toBe("TTS_UPSTREAM_ERROR");
    expect(mockCacheAsset).not.toHaveBeenCalled();
  });

  it("returns TTS_STORAGE_ERROR when the cache write fails after a successful synthesis", async () => {
    fromMock.mockReturnValue(makeItemBuilder(baseItem({ term: "give up" })));
    mockSynthesize.mockResolvedValue({ audio: Buffer.from("bytes"), contentType: "audio/mpeg" });
    mockCacheAsset.mockResolvedValue(null);

    const res = await POST(makeRequest({ itemId: "item-1" }));
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.code).toBe("TTS_STORAGE_ERROR");
  });

  it("concurrent misses for the same text each attempt synthesis (documented limitation, not deduplicated)", async () => {
    fromMock.mockReturnValue(makeItemBuilder(baseItem({ term: "give up" })));
    mockSynthesize.mockResolvedValue({ audio: Buffer.from("bytes"), contentType: "audio/mpeg" });
    mockCacheAsset.mockResolvedValue(currentAsset("asset-new", "azure/new.mp3", "give up"));

    await Promise.all([
      POST(makeRequest({ itemId: "item-1" })),
      POST(makeRequest({ itemId: "item-1" })),
      POST(makeRequest({ itemId: "item-1" })),
    ]);

    expect(mockSynthesize).toHaveBeenCalledTimes(3);
  });
});

describe("POST /api/vocabulary/pronounce — quota backend availability (fail closed in production only)", () => {
  it("fails open (proceeds to synthesize) when the quota backend is unconfigured outside production", async () => {
    mockIsProduction.mockReturnValue(false);
    fromMock.mockReturnValue(makeItemBuilder(baseItem({ term: "give up" })));
    mockQuotaBackendConfigured.mockReturnValue(false);
    mockSynthesize.mockResolvedValue({ audio: Buffer.from("bytes"), contentType: "audio/mpeg" });
    mockCacheAsset.mockResolvedValue(currentAsset("asset-new", "azure/new.mp3", "give up"));

    const res = await POST(makeRequest({ itemId: "item-1" }));

    expect(res.status).toBe(200);
    expect(mockSynthesize).toHaveBeenCalled();
  });

  it("fails closed (never calls Azure) when the quota backend is unconfigured in production", async () => {
    mockIsProduction.mockReturnValue(true);
    fromMock.mockReturnValue(makeItemBuilder(baseItem({ term: "give up" })));
    mockQuotaBackendConfigured.mockReturnValue(false);

    const res = await POST(makeRequest({ itemId: "item-1" }));
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.code).toBe("TTS_QUOTA_EXCEEDED");
    expect(mockSynthesize).not.toHaveBeenCalled();
  });

  it("fails closed when the quota backend throws in production", async () => {
    mockIsProduction.mockReturnValue(true);
    fromMock.mockReturnValue(makeItemBuilder(baseItem({ term: "give up" })));
    mockQuota.mockRejectedValue(new Error("ECONNREFUSED"));

    const res = await POST(makeRequest({ itemId: "item-1" }));
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.code).toBe("TTS_QUOTA_EXCEEDED");
    expect(mockSynthesize).not.toHaveBeenCalled();
  });

  it("fails open when the quota backend throws outside production", async () => {
    mockIsProduction.mockReturnValue(false);
    fromMock.mockReturnValue(makeItemBuilder(baseItem({ term: "give up" })));
    mockQuota.mockRejectedValue(new Error("ECONNREFUSED"));
    mockSynthesize.mockResolvedValue({ audio: Buffer.from("bytes"), contentType: "audio/mpeg" });
    mockCacheAsset.mockResolvedValue(currentAsset("asset-new", "azure/new.mp3", "give up"));

    const res = await POST(makeRequest({ itemId: "item-1" }));

    expect(res.status).toBe(200);
    expect(mockSynthesize).toHaveBeenCalled();
  });

  it("dictionary audio and already-cached assets never reach the quota backend check at all", async () => {
    mockIsProduction.mockReturnValue(true);
    mockQuotaBackendConfigured.mockReturnValue(false);
    fromMock.mockReturnValue(makeItemBuilder(baseItem({ audio_url: "https://dict.example.com/run.mp3" })));

    const res = await POST(makeRequest({ itemId: "item-1" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.source).toBe("dictionary");
  });
});
