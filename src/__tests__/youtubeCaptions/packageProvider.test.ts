import { fetchViaPackage } from "@/lib/youtubeCaptions/packageProvider";

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    clone() {
      return jsonResponse(body, status);
    },
  } as unknown as Response;
}

function htmlResponse(body: string, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    clone() {
      return htmlResponse(body, status);
    },
  } as unknown as Response;
}

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  jest.resetAllMocks();
});

describe("fetchViaPackage — playabilityStatus reclassification", () => {
  it("classifies a LOGIN_REQUIRED playabilityStatus as YOUTUBE_BOT_BLOCKED instead of CAPTIONS_DISABLED", async () => {
    // Mirrors an observed production log: InnerTube AND the webpage scrape
    // both report playabilityStatus=LOGIN_REQUIRED with zero caption
    // tracks, for a video that genuinely has captions when viewed normally
    // — YouTube's anti-bot response to an unauthenticated datacenter
    // request, not evidence the video lacks captions.
    const innerTubeJson = { playabilityStatus: { status: "LOGIN_REQUIRED" }, captions: {} };
    const webpageHtml =
      'var ytInitialPlayerResponse = {"playabilityStatus":{"status":"LOGIN_REQUIRED"},"captions":{}};';

    global.fetch = jest
      .fn()
      .mockImplementation(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/youtubei/v1/player")) return jsonResponse(innerTubeJson);
        return htmlResponse(webpageHtml);
      }) as unknown as typeof fetch;

    await expect(fetchViaPackage("abc12345678", "en")).rejects.toMatchObject({
      code: "YOUTUBE_BOT_BLOCKED",
    });
  });

  it("still classifies a genuinely caption-less video as CAPTIONS_DISABLED (ambiguous/fallback-eligible) when playabilityStatus is OK", async () => {
    const innerTubeJson = { playabilityStatus: { status: "OK" }, captions: {} };
    const webpageHtml = 'var ytInitialPlayerResponse = {"playabilityStatus":{"status":"OK"},"captions":{}};';

    global.fetch = jest
      .fn()
      .mockImplementation(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/youtubei/v1/player")) return jsonResponse(innerTubeJson);
        return htmlResponse(webpageHtml);
      }) as unknown as typeof fetch;

    await expect(fetchViaPackage("abc12345678", "en")).rejects.toMatchObject({
      code: "CAPTIONS_DISABLED",
    });
  });
});
