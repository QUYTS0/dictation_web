import { lookupWordDetails } from "@/lib/dictionary";

function mockFetchOnce(status: number, body: unknown) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as unknown as typeof fetch;
}

const BASE_MEANING = {
  partOfSpeech: "verb",
  definitions: [{ definition: "to move at a speed faster than a walk" }],
};

describe("lookupWordDetails phonetic/audio pairing", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("prefers a single phonetics[] element that carries both text and audio over mixing two different entries", async () => {
    mockFetchOnce(200, [
      {
        phonetics: [
          { text: "/rʌn/" }, // UK-only text, no audio
          { audio: "https://example.com/run-au.mp3" }, // AU-only audio, no text
          { text: "/rʌn/", audio: "https://example.com/run-us.mp3" }, // paired US entry
        ],
        meanings: [BASE_MEANING],
      },
    ]);

    const result = await lookupWordDetails("run");

    expect(result?.phonetic).toBe("/rʌn/");
    expect(result?.audioUrl).toBe("https://example.com/run-us.mp3");
  });

  it("falls back to independent text/audio selection only when no single element has both", async () => {
    mockFetchOnce(200, [
      {
        phonetics: [{ text: "/rʌn/" }, { audio: "https://example.com/run-au.mp3" }],
        meanings: [BASE_MEANING],
      },
    ]);

    const result = await lookupWordDetails("run");

    expect(result?.phonetic).toBe("/rʌn/");
    expect(result?.audioUrl).toBe("https://example.com/run-au.mp3");
  });

  it("falls back to the top-level phonetic string when no phonetics[] entry has text", async () => {
    mockFetchOnce(200, [
      {
        phonetic: "/rʌn/",
        phonetics: [{ audio: "https://example.com/run-au.mp3" }],
        meanings: [BASE_MEANING],
      },
    ]);

    const result = await lookupWordDetails("run");

    expect(result?.phonetic).toBe("/rʌn/");
    expect(result?.audioUrl).toBe("https://example.com/run-au.mp3");
  });

  it("returns null audioUrl when nothing in phonetics[] has audio", async () => {
    mockFetchOnce(200, [
      {
        phonetics: [{ text: "/rʌn/" }],
        meanings: [BASE_MEANING],
      },
    ]);

    const result = await lookupWordDetails("run");

    expect(result?.audioUrl).toBeNull();
  });

  it("never calls the API for a phrase (contains whitespace)", async () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    const result = await lookupWordDetails("give up");

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
