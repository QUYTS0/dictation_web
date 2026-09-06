import { NextRequest } from "next/server";

jest.mock("@/lib/translate", () => ({
  translateText: jest.fn(),
  TranslationError: jest.requireActual("@/lib/azureTranslator").TranslationError,
}));
jest.mock("@/lib/dictionary", () => ({ lookupWordDetails: jest.fn() }));
jest.mock("@/lib/image", () => ({ lookupWordImage: jest.fn() }));

import { POST } from "@/app/api/vocabulary/preview/route";
import { translateText } from "@/lib/translate";
import { TranslationError } from "@/lib/azureTranslator";
import { lookupWordDetails } from "@/lib/dictionary";
import { lookupWordImage } from "@/lib/image";

const mockTranslateText = translateText as jest.Mock;
const mockLookupWordDetails = lookupWordDetails as jest.Mock;
const mockLookupWordImage = lookupWordImage as jest.Mock;

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/vocabulary/preview", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLookupWordDetails.mockResolvedValue(null);
  mockLookupWordImage.mockResolvedValue(null);
});

describe("POST /api/vocabulary/preview", () => {
  it("returns 400 when text is missing", async () => {
    const res = await POST(makeRequest({ isWord: true }));
    expect(res.status).toBe(400);
  });

  it("returns the Azure translation on success", async () => {
    mockTranslateText.mockResolvedValue({ text: "chạy", source: "azure" });

    const res = await POST(makeRequest({ text: "run", isWord: true }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.translation).toEqual({ text: "chạy", source: "azure" });
    expect(body.translationFailed).toBe(false);
    expect(body.translationError).toBeNull();
  });

  it("surfaces a typed translationError and does not silently return an empty translation", async () => {
    mockTranslateText.mockRejectedValue(
      new TranslationError("TRANSLATION_RATE_LIMITED", "Translation is temporarily unavailable. Please try again later.", 429, 30)
    );

    const res = await POST(makeRequest({ text: "run", isWord: true }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.translation).toBeNull();
    expect(body.translationFailed).toBe(true);
    expect(body.translationError).toEqual({
      code: "TRANSLATION_RATE_LIMITED",
      message: "Translation is temporarily unavailable. Please try again later.",
    });
  });

  it("maps a non-TranslationError failure to a stable TRANSLATION_SERVICE_ERROR code", async () => {
    mockTranslateText.mockRejectedValue(new Error("boom"));

    const res = await POST(makeRequest({ text: "run", isWord: true }));
    const body = await res.json();

    expect(body.translationError.code).toBe("TRANSLATION_SERVICE_ERROR");
  });

  it("only looks up dictionary details and an image for a single word", async () => {
    mockTranslateText.mockResolvedValue({ text: "tốt", source: "azure" });

    await POST(makeRequest({ text: "good morning", isWord: false }));

    expect(mockLookupWordDetails).not.toHaveBeenCalled();
    expect(mockLookupWordImage).not.toHaveBeenCalled();
  });

  it("looks up dictionary details and an image for a single word", async () => {
    mockTranslateText.mockResolvedValue({ text: "chạy", source: "azure" });

    await POST(makeRequest({ text: "run", isWord: true }));

    expect(mockLookupWordDetails).toHaveBeenCalledWith("run");
    expect(mockLookupWordImage).toHaveBeenCalledWith("run");
  });

  it("still returns dictionary/image data even when translation fails", async () => {
    mockTranslateText.mockRejectedValue(new TranslationError("TRANSLATION_SERVICE_ERROR", "down"));
    mockLookupWordDetails.mockResolvedValue({ phonetic: "/rʌn/", partOfSpeech: "verb", definition: "to move fast", example: null, audioUrl: null, source: "free_dictionary" });

    const res = await POST(makeRequest({ text: "run", isWord: true }));
    const body = await res.json();

    expect(body.translationFailed).toBe(true);
    expect(body.wordDetails).toMatchObject({ definition: "to move fast" });
  });
});
