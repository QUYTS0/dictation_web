import { azureDictionaryLookup, azureTextTranslate, isAzureTranslatorConfigured, TranslationError } from "@/lib/azureTranslator";

function mockFetchResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function mockFetchOnce(status: number, body: unknown, headers?: Record<string, string>) {
  global.fetch = jest.fn().mockResolvedValue(mockFetchResponse(status, body, headers)) as unknown as typeof fetch;
}

describe("azureTranslator", () => {
  const originalFetch = global.fetch;
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      AZURE_TRANSLATOR_KEY: "test-key",
      AZURE_TRANSLATOR_REGION: "test-region",
      AZURE_TRANSLATOR_ENDPOINT: "https://api.cognitive.microsofttranslator.com",
    };
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  describe("isAzureTranslatorConfigured", () => {
    it("is true when all three env vars are set", () => {
      expect(isAzureTranslatorConfigured()).toBe(true);
    });

    it("is false when any env var is missing", () => {
      delete process.env.AZURE_TRANSLATOR_KEY;
      expect(isAzureTranslatorConfigured()).toBe(false);
    });
  });

  describe("azureDictionaryLookup", () => {
    it("parses translations sorted by confidence, highest first", async () => {
      mockFetchOnce(200, [
        {
          normalizedSource: "run",
          translations: [
            { normalizedTarget: "chạy bộ", displayTarget: "chạy bộ", posTag: "NOUN", confidence: 0.3 },
            { normalizedTarget: "chạy", displayTarget: "chạy", posTag: "VERB", confidence: 0.8 },
          ],
        },
      ]);

      const result = await azureDictionaryLookup("run", "en", "vi");
      expect(result.translations[0]).toMatchObject({ displayTarget: "chạy", posTag: "VERB" });
      expect(result.translations[1]).toMatchObject({ displayTarget: "chạy bộ" });
    });

    it("returns an empty translations array when Azure has no dictionary entry", async () => {
      mockFetchOnce(200, [{ normalizedSource: "asdkjaskd", translations: [] }]);
      const result = await azureDictionaryLookup("asdkjaskd", "en", "vi");
      expect(result.translations).toEqual([]);
    });

    it("throws TRANSLATION_INVALID_RESPONSE for an unexpected shape", async () => {
      mockFetchOnce(200, { not: "an array" });
      await expect(azureDictionaryLookup("run", "en", "vi")).rejects.toMatchObject({
        code: "TRANSLATION_INVALID_RESPONSE",
      });
    });

    it("sends the dictionary/lookup endpoint with from/to and the Ocp-Apim headers", async () => {
      mockFetchOnce(200, [{ normalizedSource: "run", translations: [] }]);
      await azureDictionaryLookup("run", "en", "vi");

      const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
      expect(url).toBe("https://api.cognitive.microsofttranslator.com/dictionary/lookup?api-version=3.0&from=en&to=vi");
      expect(init.headers["Ocp-Apim-Subscription-Key"]).toBe("test-key");
      expect(init.headers["Ocp-Apim-Subscription-Region"]).toBe("test-region");
    });
  });

  describe("azureTextTranslate", () => {
    it("returns the first translation's text", async () => {
      mockFetchOnce(200, [{ translations: [{ text: "Xin chào thế giới", to: "vi" }] }]);
      const result = await azureTextTranslate("Hello world", "en", "vi");
      expect(result.text).toBe("Xin chào thế giới");
    });

    it("hits the /translate endpoint", async () => {
      mockFetchOnce(200, [{ translations: [{ text: "ok", to: "vi" }] }]);
      await azureTextTranslate("ok", "en", "vi");
      const [url] = (global.fetch as jest.Mock).mock.calls[0];
      expect(url).toBe("https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&from=en&to=vi");
    });

    it("throws TRANSLATION_INVALID_RESPONSE when no translation text is present", async () => {
      mockFetchOnce(200, [{ translations: [] }]);
      await expect(azureTextTranslate("hi", "en", "vi")).rejects.toMatchObject({
        code: "TRANSLATION_INVALID_RESPONSE",
      });
    });
  });

  describe("error mapping", () => {
    it("throws TRANSLATION_CONFIG_ERROR when env vars are missing", async () => {
      delete process.env.AZURE_TRANSLATOR_KEY;
      await expect(azureTextTranslate("hi", "en", "vi")).rejects.toMatchObject({
        code: "TRANSLATION_CONFIG_ERROR",
      });
    });

    it("throws TRANSLATION_AUTH_ERROR on 401", async () => {
      mockFetchOnce(401, { error: { message: "unauthorized" } });
      await expect(azureTextTranslate("hi", "en", "vi")).rejects.toMatchObject({
        code: "TRANSLATION_AUTH_ERROR",
        status: 401,
      });
    });

    it("throws TRANSLATION_AUTH_ERROR on 403", async () => {
      mockFetchOnce(403, { error: { message: "forbidden" } });
      await expect(azureTextTranslate("hi", "en", "vi")).rejects.toMatchObject({
        code: "TRANSLATION_AUTH_ERROR",
        status: 403,
      });
    });

    it("throws TRANSLATION_RATE_LIMITED on 429 and captures Retry-After", async () => {
      mockFetchOnce(429, { error: { message: "rate limited" } }, { "Retry-After": "30" });
      await expect(azureTextTranslate("hi", "en", "vi")).rejects.toMatchObject({
        code: "TRANSLATION_RATE_LIMITED",
        status: 429,
        retryAfterSec: 30,
      });
    });

    it("does not retry a 429", async () => {
      mockFetchOnce(429, { error: {} });
      await expect(azureTextTranslate("hi", "en", "vi")).rejects.toMatchObject({ code: "TRANSLATION_RATE_LIMITED" });
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it("retries once on a 5xx then succeeds", async () => {
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce(mockFetchResponse(503, { error: {} }))
        .mockResolvedValueOnce(mockFetchResponse(200, [{ translations: [{ text: "ok" }] }]));
      global.fetch = fetchMock as unknown as typeof fetch;

      const result = await azureTextTranslate("hi", "en", "vi");
      expect(result.text).toBe("ok");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("throws TRANSLATION_SERVICE_ERROR after exhausting retries on repeated 5xx", async () => {
      mockFetchOnce(500, { error: {} });
      await expect(azureTextTranslate("hi", "en", "vi")).rejects.toMatchObject({
        code: "TRANSLATION_SERVICE_ERROR",
        status: 500,
      });
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it("throws TRANSLATION_TIMEOUT when the request aborts", async () => {
      global.fetch = jest.fn().mockImplementation(() => {
        const err = new Error("aborted");
        err.name = "AbortError";
        return Promise.reject(err);
      }) as unknown as typeof fetch;

      await expect(azureTextTranslate("hi", "en", "vi")).rejects.toMatchObject({ code: "TRANSLATION_TIMEOUT" });
    });

    it("throws TRANSLATION_SERVICE_ERROR on a network failure after retrying", async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;
      await expect(azureTextTranslate("hi", "en", "vi")).rejects.toMatchObject({ code: "TRANSLATION_SERVICE_ERROR" });
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it("never logs the subscription key on failure", async () => {
      const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      mockFetchOnce(400, { error: { message: "bad request" } });
      await expect(azureTextTranslate("hi", "en", "vi")).rejects.toMatchObject({ code: "TRANSLATION_INVALID_RESPONSE" });
      const loggedText = errorSpy.mock.calls.map((call) => JSON.stringify(call)).join("\n");
      expect(loggedText).not.toContain("test-key");
    });
  });

  it("is a real TranslationError instance", async () => {
    mockFetchOnce(401, {});
    try {
      await azureTextTranslate("hi", "en", "vi");
      throw new Error("expected azureTextTranslate to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TranslationError);
    }
  });
});
