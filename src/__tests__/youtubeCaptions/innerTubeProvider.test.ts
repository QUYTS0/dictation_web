const fetchCaptionTracks = jest.fn();
const fetchTimedText = jest.fn();

jest.mock("@/lib/youtubeCaptions/innerTubeClient", () => ({
  fetchCaptionTracks: (...args: unknown[]) => fetchCaptionTracks(...args),
  fetchTimedText: (...args: unknown[]) => fetchTimedText(...args),
}));

import { fetchViaInnerTube } from "@/lib/youtubeCaptions/innerTubeProvider";
import { TranscriptFetchError } from "@/lib/youtubeCaptions/errors";

const XML = '<text start="0" dur="2">Hello and welcome.</text><text start="2" dur="2">This is a test.</text>';

beforeEach(() => {
  fetchCaptionTracks.mockReset();
  fetchTimedText.mockReset();
});

describe("fetchViaInnerTube (English provider)", () => {
  it("43. never appends tlang= to the fetched timed-text URL — this is the English path, not translation", async () => {
    fetchCaptionTracks.mockResolvedValue({
      tracks: [{ baseUrl: "https://www.youtube.com/api/timedtext?v=abc&lang=en", languageCode: "en" }],
      diagnostics: { httpStatus: 200, trackCount: 1 },
    });
    fetchTimedText.mockResolvedValue({ httpStatus: 200, contentType: "text/xml", text: XML });

    await fetchViaInnerTube("abc12345678");

    expect(fetchTimedText).toHaveBeenCalledTimes(1);
    const [calledUrl] = fetchTimedText.mock.calls[0];
    expect(calledUrl).not.toContain("tlang=");
    expect(calledUrl).toBe("https://www.youtube.com/api/timedtext?v=abc&lang=en");
  });

  it("selects an English track and returns validated cues", async () => {
    fetchCaptionTracks.mockResolvedValue({
      tracks: [
        { baseUrl: "https://youtube.com/x?lang=fr", languageCode: "fr" },
        { baseUrl: "https://youtube.com/x?lang=en-US", languageCode: "en-US" },
      ],
      diagnostics: { httpStatus: 200, trackCount: 2 },
    });
    fetchTimedText.mockResolvedValue({ httpStatus: 200, contentType: "text/xml", text: XML });

    const result = await fetchViaInnerTube("abc12345678");
    expect(result.languageCode).toBe("en-US");
    expect(result.cues).toHaveLength(2);
    expect(result.provider).toBe("innertube-raw");
  });

  it("throws LANGUAGE_NOT_FOUND when no track is English", async () => {
    fetchCaptionTracks.mockResolvedValue({
      tracks: [{ baseUrl: "https://youtube.com/x?lang=fr", languageCode: "fr" }],
      diagnostics: { httpStatus: 200, trackCount: 1 },
    });
    await expect(fetchViaInnerTube("abc12345678")).rejects.toMatchObject({ code: "LANGUAGE_NOT_FOUND" });
  });

  it("throws CAPTIONS_DISABLED when InnerTube reports no tracks at all", async () => {
    fetchCaptionTracks.mockResolvedValue({ tracks: null, diagnostics: { httpStatus: 200, trackCount: 0 } });
    await expect(fetchViaInnerTube("abc12345678")).rejects.toMatchObject({ code: "CAPTIONS_DISABLED" });
  });

  it("throws YOUTUBE_RATE_LIMITED on an HTTP 429 from InnerTube", async () => {
    fetchCaptionTracks.mockResolvedValue({ tracks: null, diagnostics: { httpStatus: 429, trackCount: 0 } });
    await expect(fetchViaInnerTube("abc12345678")).rejects.toMatchObject({ code: "YOUTUBE_RATE_LIMITED" });
  });

  it("throws INVALID_PROVIDER_RESPONSE for an HTML challenge page instead of timed text", async () => {
    fetchCaptionTracks.mockResolvedValue({
      tracks: [{ baseUrl: "https://youtube.com/x?lang=en", languageCode: "en" }],
      diagnostics: { httpStatus: 200, trackCount: 1 },
    });
    fetchTimedText.mockResolvedValue({
      httpStatus: 200,
      contentType: "text/html",
      text: '<html><body><div class="g-recaptcha"></div></body></html>',
    });
    await expect(fetchViaInnerTube("abc12345678")).rejects.toBeInstanceOf(TranscriptFetchError);
  });

  it("throws TIMEOUT on an aborted request", async () => {
    fetchCaptionTracks.mockImplementation(() => {
      const err = new Error("aborted");
      err.name = "AbortError";
      return Promise.reject(err);
    });
    await expect(fetchViaInnerTube("abc12345678")).rejects.toMatchObject({ code: "TIMEOUT" });
  });
});
