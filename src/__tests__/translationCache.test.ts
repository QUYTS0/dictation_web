const fromMock = jest.fn();

jest.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => ({ from: (table: string) => fromMock(table) }),
}));

import { getCachedTranslation, setCachedTranslation } from "@/lib/translationCache";

beforeEach(() => {
  fromMock.mockReset();
});

describe("getCachedTranslation", () => {
  const key = { sourceLanguage: "en", targetLanguage: "vi", selectionType: "word" as const, normalizedText: "run" };

  it("returns the cached row when one exists", async () => {
    const builder: Record<string, jest.Mock> = {};
    const chain = () => builder;
    builder.select = jest.fn(chain);
    builder.eq = jest.fn(chain);
    builder.maybeSingle = jest.fn(() =>
      Promise.resolve({ data: { translation: "chạy", metadata: { alternatives: [{ text: "chạy bộ" }] } }, error: null })
    );
    fromMock.mockReturnValue(builder);

    const result = await getCachedTranslation(key);
    expect(result).toEqual({ translation: "chạy", metadata: { alternatives: [{ text: "chạy bộ" }] } });
    expect(fromMock).toHaveBeenCalledWith("vocabulary_translation_cache");
  });

  it("returns null when nothing is cached", async () => {
    const builder: Record<string, jest.Mock> = {};
    const chain = () => builder;
    builder.select = jest.fn(chain);
    builder.eq = jest.fn(chain);
    builder.maybeSingle = jest.fn(() => Promise.resolve({ data: null, error: null }));
    fromMock.mockReturnValue(builder);

    expect(await getCachedTranslation(key)).toBeNull();
  });

  it("returns null (not a throw) on a database error", async () => {
    const builder: Record<string, jest.Mock> = {};
    const chain = () => builder;
    builder.select = jest.fn(chain);
    builder.eq = jest.fn(chain);
    builder.maybeSingle = jest.fn(() => Promise.resolve({ data: null, error: { message: "db down" } }));
    fromMock.mockReturnValue(builder);

    expect(await getCachedTranslation(key)).toBeNull();
  });

  it("returns null (not a throw) when the Supabase client itself throws (e.g. missing env vars)", async () => {
    fromMock.mockImplementation(() => {
      throw new Error("Missing Supabase environment variables.");
    });

    expect(await getCachedTranslation(key)).toBeNull();
  });
});

describe("setCachedTranslation", () => {
  const key = {
    sourceLanguage: "en",
    targetLanguage: "vi",
    selectionType: "word" as const,
    normalizedText: "run",
    translation: "chạy",
  };

  it("upserts on the unique (source, target, selection_type, normalized_text) key", async () => {
    const builder: Record<string, jest.Mock> = {};
    builder.upsert = jest.fn(() => Promise.resolve({ error: null }));
    fromMock.mockReturnValue(builder);

    await setCachedTranslation(key);

    expect(fromMock).toHaveBeenCalledWith("vocabulary_translation_cache");
    expect(builder.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        source_language: "en",
        target_language: "vi",
        selection_type: "word",
        normalized_text: "run",
        translation: "chạy",
        provider: "azure",
      }),
      { onConflict: "source_language,target_language,selection_type,normalized_text" }
    );
  });

  it("does not throw when the write fails", async () => {
    const builder: Record<string, jest.Mock> = {};
    builder.upsert = jest.fn(() => Promise.resolve({ error: { message: "db down" } }));
    fromMock.mockReturnValue(builder);

    await expect(setCachedTranslation(key)).resolves.toBeUndefined();
  });
});
