jest.mock("@/lib/azureTranslator", () => {
  const actual = jest.requireActual("@/lib/azureTranslator");
  return {
    ...actual,
    azureDictionaryLookup: jest.fn(),
    azureTextTranslate: jest.fn(),
  };
});

jest.mock("@/lib/translationCache", () => ({
  getCachedTranslation: jest.fn(),
  setCachedTranslation: jest.fn(),
}));

import { translateText, classifySelectionType, TranslationError } from "@/lib/translate";
import { azureDictionaryLookup, azureTextTranslate } from "@/lib/azureTranslator";
import { getCachedTranslation, setCachedTranslation } from "@/lib/translationCache";

const mockDictLookup = azureDictionaryLookup as jest.Mock;
const mockTextTranslate = azureTextTranslate as jest.Mock;
const mockGetCached = getCachedTranslation as jest.Mock;
const mockSetCached = setCachedTranslation as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockGetCached.mockResolvedValue(null);
  mockSetCached.mockResolvedValue(undefined);
});

describe("classifySelectionType", () => {
  it("classifies a single token as a word", () => {
    expect(classifySelectionType("run")).toBe("word");
  });

  it("classifies a short multi-word selection as a phrase", () => {
    expect(classifySelectionType("make sense of")).toBe("phrase");
  });

  it("classifies a long or sentence-punctuated selection as a sentence", () => {
    expect(classifySelectionType("This is a complete sentence.")).toBe("sentence");
    expect(classifySelectionType("one two three four five six seven eight")).toBe("sentence");
  });
});

describe("translateText", () => {
  it("returns a cached translation without calling Azure", async () => {
    mockGetCached.mockResolvedValue({ translation: "xin chào", metadata: null });

    const result = await translateText("hello", "vi");

    expect(result).toMatchObject({ text: "xin chào", source: "azure" });
    expect(mockDictLookup).not.toHaveBeenCalled();
    expect(mockTextTranslate).not.toHaveBeenCalled();
    expect(mockSetCached).not.toHaveBeenCalled();
  });

  it("uses Dictionary Lookup for a single word", async () => {
    mockDictLookup.mockResolvedValue({
      normalizedSource: "run",
      translations: [{ normalizedTarget: "chạy", displayTarget: "chạy", posTag: "VERB", confidence: 0.9 }],
    });

    const result = await translateText("run", "vi");

    expect(result).toMatchObject({ text: "chạy", source: "azure" });
    expect(mockDictLookup).toHaveBeenCalledWith("run", "en", "vi");
    expect(mockTextTranslate).not.toHaveBeenCalled();
  });

  it("strips leading/trailing punctuation from a word before dictionary lookup", async () => {
    mockDictLookup.mockResolvedValue({
      normalizedSource: "run",
      translations: [{ normalizedTarget: "chạy", displayTarget: "chạy", confidence: 0.9 }],
    });

    await translateText('"run,"', "vi");

    expect(mockDictLookup).toHaveBeenCalledWith("run", "en", "vi");
  });

  it("falls back to Text Translation when Dictionary Lookup has no usable result", async () => {
    mockDictLookup.mockResolvedValue({ normalizedSource: "zzyzx", translations: [] });
    mockTextTranslate.mockResolvedValue({ text: "zzyzx (dịch)" });

    const result = await translateText("zzyzx", "vi");

    expect(mockDictLookup).toHaveBeenCalled();
    expect(mockTextTranslate).toHaveBeenCalledWith("zzyzx", "en", "vi");
    expect(result).toMatchObject({ text: "zzyzx (dịch)", source: "azure" });
  });

  it("uses Text Translation directly for a phrase", async () => {
    mockTextTranslate.mockResolvedValue({ text: "chào buổi sáng" });

    const result = await translateText("good morning", "vi");

    expect(mockDictLookup).not.toHaveBeenCalled();
    expect(mockTextTranslate).toHaveBeenCalledWith("good morning", "en", "vi");
    expect(result.text).toBe("chào buổi sáng");
  });

  it("uses Text Translation directly for a sentence", async () => {
    mockTextTranslate.mockResolvedValue({ text: "Đây là một câu ví dụ." });

    const result = await translateText("This is an example sentence.", "vi");

    expect(mockDictLookup).not.toHaveBeenCalled();
    expect(mockTextTranslate).toHaveBeenCalledWith("This is an example sentence.", "en", "vi");
    expect(result.text).toBe("Đây là một câu ví dụ.");
  });

  it("caches a successful translation", async () => {
    mockTextTranslate.mockResolvedValue({ text: "chào buổi sáng" });

    await translateText("good morning", "vi");

    expect(mockSetCached).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceLanguage: "en",
        targetLanguage: "vi",
        selectionType: "phrase",
        normalizedText: "good morning",
        translation: "chào buổi sáng",
      })
    );
  });

  it("does not cache a failed translation", async () => {
    mockTextTranslate.mockRejectedValue(new TranslationError("TRANSLATION_SERVICE_ERROR", "down"));

    await expect(translateText("good morning", "vi")).rejects.toMatchObject({ code: "TRANSLATION_SERVICE_ERROR" });
    expect(mockSetCached).not.toHaveBeenCalled();
  });

  it("propagates a typed Azure error (rate limited) instead of swallowing it", async () => {
    mockDictLookup.mockRejectedValue(new TranslationError("TRANSLATION_RATE_LIMITED", "slow down", 429, 30));

    await expect(translateText("run", "vi")).rejects.toMatchObject({
      code: "TRANSLATION_RATE_LIMITED",
      status: 429,
      retryAfterSec: 30,
    });
    expect(mockSetCached).not.toHaveBeenCalled();
  });

  it("propagates a configuration error", async () => {
    mockDictLookup.mockRejectedValue(new TranslationError("TRANSLATION_CONFIG_ERROR", "not configured"));

    await expect(translateText("run", "vi")).rejects.toMatchObject({ code: "TRANSLATION_CONFIG_ERROR" });
  });

  it("rejects empty input without calling Azure", async () => {
    await expect(translateText("   ", "vi")).rejects.toMatchObject({ code: "TRANSLATION_INVALID_INPUT" });
    expect(mockDictLookup).not.toHaveBeenCalled();
    expect(mockTextTranslate).not.toHaveBeenCalled();
  });

  it("rejects input longer than the maximum length without calling Azure", async () => {
    const tooLong = "a".repeat(1000);
    await expect(translateText(tooLong, "vi")).rejects.toMatchObject({ code: "TRANSLATION_INVALID_INPUT" });
    expect(mockDictLookup).not.toHaveBeenCalled();
    expect(mockTextTranslate).not.toHaveBeenCalled();
  });
});
