import { fetchYoutubeTranslatedCaptions } from "@/lib/youtubeTranslatedCaptions";

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: () => "application/json" },
  } as unknown as Response;
}

function textResponse(body: string, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => JSON.parse(body),
    text: async () => body,
    headers: { get: () => "text/xml" },
  } as unknown as Response;
}

const originalFetch = global.fetch;

describe("fetchYoutubeTranslatedCaptions — regression (output unchanged by the innerTubeClient/parseTimedText extraction)", () => {
  afterEach(() => {
    global.fetch = originalFetch;
    jest.resetAllMocks();
  });

  it("42. produces srv3-format cues with the same raw (ms) offset/duration units as before", async () => {
    const tracksResponse = jsonResponse({
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [{ baseUrl: "https://www.youtube.com/api/timedtext?v=abc&lang=en", languageCode: "en", kind: undefined }],
        },
      },
    });
    const xml = '<p t="1000" d="2000">Hello there</p><p t="3000" d="1500">How are you</p>';
    const timedTextResponse = textResponse(xml);

    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(tracksResponse) // InnerTube track list
      .mockResolvedValueOnce(timedTextResponse); // translated timedtext
    global.fetch = fetchMock as unknown as typeof fetch;

    const cues = await fetchYoutubeTranslatedCaptions("abc12345678", "vi");

    expect(cues).toEqual([
      { text: "Hello there", offset: 1000, duration: 2000 },
      { text: "How are you", offset: 3000, duration: 1500 },
    ]);

    // Confirms the second call's URL carries &tlang= (this IS the translation path).
    const secondCallUrl = fetchMock.mock.calls[1][0] as string;
    expect(secondCallUrl).toContain("tlang=vi");
  });

  it("produces classic-format cues with the same raw (seconds) offset/duration units as before", async () => {
    const tracksResponse = jsonResponse({
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [{ baseUrl: "https://www.youtube.com/api/timedtext?v=abc&lang=en", languageCode: "en" }],
        },
      },
    });
    const xml = '<text start="1.5" dur="2.25">Bonjour</text>';
    const timedTextResponse = textResponse(xml);

    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(tracksResponse)
      .mockResolvedValueOnce(timedTextResponse) as unknown as typeof fetch;

    const cues = await fetchYoutubeTranslatedCaptions("abc12345678", "vi");
    expect(cues).toEqual([{ text: "Bonjour", offset: 1.5, duration: 2.25 }]);
  });

  it("returns null when the video has no caption tracks at all", async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(jsonResponse({ captions: {} })) as unknown as typeof fetch;
    const cues = await fetchYoutubeTranslatedCaptions("abc12345678", "vi");
    expect(cues).toBeNull();
  });

  it("returns null when the only track is already in the target language", async () => {
    const tracksResponse = jsonResponse({
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [{ baseUrl: "https://www.youtube.com/api/timedtext?v=abc&lang=vi", languageCode: "vi" }],
        },
      },
    });
    global.fetch = jest.fn().mockResolvedValueOnce(tracksResponse) as unknown as typeof fetch;
    const cues = await fetchYoutubeTranslatedCaptions("abc12345678", "vi");
    expect(cues).toBeNull();
  });

  it("returns null (never throws) on a network failure", async () => {
    global.fetch = jest.fn().mockRejectedValueOnce(new Error("network down")) as unknown as typeof fetch;
    await expect(fetchYoutubeTranslatedCaptions("abc12345678", "vi")).resolves.toBeNull();
  });
});
