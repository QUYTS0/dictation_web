const fromMock = jest.fn();
const storageFromMock = jest.fn();

jest.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => ({
    from: (table: string) => fromMock(table),
    storage: { from: (bucket: string) => storageFromMock(bucket) },
  }),
}));

import {
  assetMatchesKey,
  cacheAudioAsset,
  getAudioAssetById,
  getCachedAudioAsset,
  resolvePlaybackUrl,
  storagePathFor,
  touchAudioAsset,
} from "@/lib/vocabularyAudioCache";

const key = {
  voice: "en-US-JennyNeural",
  locale: "en-US",
  outputFormat: "audio-24khz-48kbitrate-mono-mp3",
  synthesisVersion: "v1",
  normalizedText: "run",
};

const assetRow = {
  id: "asset-1",
  storage_path: "azure/abc.mp3",
  voice: key.voice,
  locale: key.locale,
  output_format: key.outputFormat,
  synthesis_version: key.synthesisVersion,
  normalized_text: key.normalizedText,
};

const asset = {
  id: "asset-1",
  storagePath: "azure/abc.mp3",
  voice: key.voice,
  locale: key.locale,
  outputFormat: key.outputFormat,
  synthesisVersion: key.synthesisVersion,
  normalizedText: key.normalizedText,
};

beforeEach(() => {
  fromMock.mockReset();
  storageFromMock.mockReset();
});

describe("storagePathFor", () => {
  it("is deterministic for the same key", () => {
    expect(storagePathFor(key)).toBe(storagePathFor({ ...key }));
  });

  it("differs when normalizedText differs", () => {
    expect(storagePathFor(key)).not.toBe(storagePathFor({ ...key, normalizedText: "sprint" }));
  });

  it("uses the .mp3 extension for an mp3 output format", () => {
    expect(storagePathFor(key)).toMatch(/^azure\/[0-9a-f]{64}\.mp3$/);
  });
});

describe("assetMatchesKey", () => {
  it("matches when every identity field is identical", () => {
    expect(assetMatchesKey(asset, key)).toBe(true);
  });

  it("does not match when synthesis_version differs (e.g. after a version bump)", () => {
    expect(assetMatchesKey(asset, { ...key, synthesisVersion: "v2" })).toBe(false);
  });

  it("does not match when normalizedText differs", () => {
    expect(assetMatchesKey(asset, { ...key, normalizedText: "sprint" })).toBe(false);
  });

  it("does not match when voice/locale/outputFormat differ", () => {
    expect(assetMatchesKey(asset, { ...key, voice: "en-GB-SoniaNeural" })).toBe(false);
    expect(assetMatchesKey(asset, { ...key, locale: "en-GB" })).toBe(false);
    expect(assetMatchesKey(asset, { ...key, outputFormat: "riff-24khz-16bit-mono-pcm" })).toBe(false);
  });
});

describe("getCachedAudioAsset", () => {
  it("returns the full cached asset identity when one exists", async () => {
    const builder: Record<string, jest.Mock> = {};
    const chain = () => builder;
    builder.select = jest.fn(chain);
    builder.eq = jest.fn(chain);
    builder.maybeSingle = jest.fn(() => Promise.resolve({ data: assetRow, error: null }));
    fromMock.mockReturnValue(builder);

    const result = await getCachedAudioAsset(key);
    expect(result).toEqual(asset);
    expect(fromMock).toHaveBeenCalledWith("vocabulary_audio_assets");
  });

  it("returns null when nothing is cached", async () => {
    const builder: Record<string, jest.Mock> = {};
    const chain = () => builder;
    builder.select = jest.fn(chain);
    builder.eq = jest.fn(chain);
    builder.maybeSingle = jest.fn(() => Promise.resolve({ data: null, error: null }));
    fromMock.mockReturnValue(builder);

    expect(await getCachedAudioAsset(key)).toBeNull();
  });

  it("returns null (not a throw) on a database error", async () => {
    const builder: Record<string, jest.Mock> = {};
    const chain = () => builder;
    builder.select = jest.fn(chain);
    builder.eq = jest.fn(chain);
    builder.maybeSingle = jest.fn(() => Promise.resolve({ data: null, error: { message: "db down" } }));
    fromMock.mockReturnValue(builder);

    expect(await getCachedAudioAsset(key)).toBeNull();
  });
});

describe("getAudioAssetById", () => {
  it("returns the full asset identity for a matching id", async () => {
    const builder: Record<string, jest.Mock> = {};
    const chain = () => builder;
    builder.select = jest.fn(chain);
    builder.eq = jest.fn(chain);
    builder.maybeSingle = jest.fn(() => Promise.resolve({ data: assetRow, error: null }));
    fromMock.mockReturnValue(builder);

    expect(await getAudioAssetById("asset-1")).toEqual(asset);
  });

  it("returns null when the id doesn't exist", async () => {
    const builder: Record<string, jest.Mock> = {};
    const chain = () => builder;
    builder.select = jest.fn(chain);
    builder.eq = jest.fn(chain);
    builder.maybeSingle = jest.fn(() => Promise.resolve({ data: null, error: null }));
    fromMock.mockReturnValue(builder);

    expect(await getAudioAssetById("missing")).toBeNull();
  });
});

describe("touchAudioAsset", () => {
  it("updates last_used_at and does not throw on failure", async () => {
    const builder: Record<string, jest.Mock> = {};
    const chain = () => builder;
    builder.update = jest.fn(chain);
    builder.eq = jest.fn(() => Promise.resolve({ error: { message: "db down" } }));
    fromMock.mockReturnValue(builder);

    await expect(touchAudioAsset("asset-1")).resolves.toBeUndefined();
    expect(builder.update).toHaveBeenCalledWith(expect.objectContaining({ last_used_at: expect.any(String) }));
  });
});

describe("resolvePlaybackUrl", () => {
  it("returns a signed, time-limited URL from private storage (not a public one)", async () => {
    const createSignedUrl = jest.fn(() =>
      Promise.resolve({ data: { signedUrl: "https://cdn.example.com/azure/abc.mp3?token=xyz" }, error: null })
    );
    storageFromMock.mockReturnValue({ createSignedUrl });

    const result = await resolvePlaybackUrl("azure/abc.mp3");

    expect(result).toBe("https://cdn.example.com/azure/abc.mp3?token=xyz");
    expect(storageFromMock).toHaveBeenCalledWith("vocabulary-audio");
    expect(createSignedUrl).toHaveBeenCalledWith("azure/abc.mp3", expect.any(Number));
  });

  it("returns null (not a throw) when the object is missing / signing fails", async () => {
    storageFromMock.mockReturnValue({
      createSignedUrl: jest.fn(() => Promise.resolve({ data: null, error: { message: "Object not found" } })),
    });

    expect(await resolvePlaybackUrl("azure/missing.mp3")).toBeNull();
  });

  it("returns null (not a throw) when the Supabase client itself throws", async () => {
    storageFromMock.mockImplementation(() => {
      throw new Error("Missing Supabase environment variables.");
    });

    expect(await resolvePlaybackUrl("azure/abc.mp3")).toBeNull();
  });
});

describe("cacheAudioAsset", () => {
  const writeArgs = { ...key, text: "run", audio: Buffer.from("fake-mp3-bytes"), charCount: 3 };

  it("uploads to storage then upserts the row, returning the full asset identity", async () => {
    const uploadMock = jest.fn(() => Promise.resolve({ error: null }));
    storageFromMock.mockReturnValue({ upload: uploadMock });

    const dbBuilder: Record<string, jest.Mock> = {};
    dbBuilder.upsert = jest.fn(() => dbBuilder);
    dbBuilder.select = jest.fn(() => dbBuilder);
    dbBuilder.single = jest.fn(() => Promise.resolve({ data: assetRow, error: null }));
    fromMock.mockReturnValue(dbBuilder);

    const result = await cacheAudioAsset(writeArgs);

    expect(uploadMock).toHaveBeenCalledWith(
      storagePathFor(key),
      writeArgs.audio,
      expect.objectContaining({ contentType: "audio/mpeg", upsert: true })
    );
    expect(dbBuilder.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ normalized_text: "run", voice: key.voice }),
      { onConflict: "voice,locale,output_format,synthesis_version,normalized_text" }
    );
    expect(result).toEqual(asset);
  });

  it("returns null and never upserts when the storage upload fails", async () => {
    const uploadMock = jest.fn(() => Promise.resolve({ error: { message: "storage down" } }));
    storageFromMock.mockReturnValue({ upload: uploadMock });

    const result = await cacheAudioAsset(writeArgs);

    expect(result).toBeNull();
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("returns null when the upload succeeds but the DB upsert fails", async () => {
    storageFromMock.mockReturnValue({ upload: jest.fn(() => Promise.resolve({ error: null })) });

    const dbBuilder: Record<string, jest.Mock> = {};
    dbBuilder.upsert = jest.fn(() => dbBuilder);
    dbBuilder.select = jest.fn(() => dbBuilder);
    dbBuilder.single = jest.fn(() => Promise.resolve({ data: null, error: { message: "db down" } }));
    fromMock.mockReturnValue(dbBuilder);

    expect(await cacheAudioAsset(writeArgs)).toBeNull();
  });
});
