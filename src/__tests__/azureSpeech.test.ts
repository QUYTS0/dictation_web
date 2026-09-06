import { assessPronunciation, AzureSpeechError } from "@/lib/azureSpeech";

function mockFetchResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function mockFetchOnce(status: number, body: unknown) {
  global.fetch = jest.fn().mockResolvedValue(mockFetchResponse(status, body)) as unknown as typeof fetch;
}

describe("assessPronunciation", () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.AZURE_SPEECH_KEY;
  const originalRegion = process.env.AZURE_SPEECH_REGION;
  const baseArgs = { wavBuffer: Buffer.from([]), referenceText: "hello world" };

  beforeEach(() => {
    process.env.AZURE_SPEECH_KEY = "test-key";
    process.env.AZURE_SPEECH_REGION = "test-region";
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.AZURE_SPEECH_KEY = originalKey;
    process.env.AZURE_SPEECH_REGION = originalRegion;
    jest.restoreAllMocks();
  });

  it("parses a flat REST response (scores directly on NBest[0], not nested)", async () => {
    mockFetchOnce(200, {
      RecognitionStatus: "Success",
      DisplayText: "There are over 4 times as many livestock as people.",
      NBest: [
        {
          Display: "There are over 4 times as many livestock as people.",
          AccuracyScore: 85,
          FluencyScore: 90,
          ProsodyScore: 73.3,
          CompletenessScore: 100,
          PronScore: 84,
          Words: [
            { Word: "there", AccuracyScore: 90, ErrorType: "None" },
            { Word: "livestock", AccuracyScore: 40, ErrorType: "Mispronunciation" },
          ],
        },
      ],
    });

    const result = await assessPronunciation(baseArgs);

    expect(result.accuracy).toBe(85);
    expect(result.fluency).toBe(90);
    expect(result.prosody).toBe(73.3);
    expect(result.completeness).toBe(100);
    expect(result.pronScore).toBe(84);
    expect(result.recognizedText).toBe("There are over 4 times as many livestock as people.");
    expect(result.words[0]).toMatchObject({ word: "there", accuracyScore: 90, errorType: "None" });
    expect(result.words[1]).toMatchObject({ word: "livestock", accuracyScore: 40, errorType: "Mispronunciation" });
  });

  it("parses a nested response (scores under NBest[0].PronunciationAssessment)", async () => {
    mockFetchOnce(200, {
      RecognitionStatus: "Success",
      DisplayText: "hello world",
      NBest: [
        {
          Display: "hello world",
          PronunciationAssessment: {
            AccuracyScore: 88,
            FluencyScore: 95,
            CompletenessScore: 100,
            ProsodyScore: 70,
            PronScore: 90,
          },
          Words: [{ Word: "hello", PronunciationAssessment: { AccuracyScore: 92, ErrorType: "None" } }],
        },
      ],
    });

    const result = await assessPronunciation(baseArgs);

    expect(result.accuracy).toBe(88);
    expect(result.fluency).toBe(95);
    expect(result.completeness).toBe(100);
    expect(result.prosody).toBe(70);
    expect(result.pronScore).toBe(90);
    expect(result.words[0]).toMatchObject({ word: "hello", accuracyScore: 92, errorType: "None" });
  });

  it("prefers the nested shape over a flat one when both are present", async () => {
    mockFetchOnce(200, {
      RecognitionStatus: "Success",
      DisplayText: "hi",
      NBest: [
        {
          Display: "hi",
          AccuracyScore: 10, // flat — should be ignored in favor of nested
          PronunciationAssessment: { AccuracyScore: 99 },
        },
      ],
    });

    const result = await assessPronunciation(baseArgs);
    expect(result.accuracy).toBe(99);
  });

  it("treats a score of 0 as a valid value, not a missing one", async () => {
    mockFetchOnce(200, {
      RecognitionStatus: "Success",
      DisplayText: "hi",
      NBest: [{ Display: "hi", AccuracyScore: 0, FluencyScore: 0, CompletenessScore: 0, ProsodyScore: 0, PronScore: 0 }],
    });

    const result = await assessPronunciation(baseArgs);
    expect(result.accuracy).toBe(0);
    expect(result.fluency).toBe(0);
    expect(result.completeness).toBe(0);
    expect(result.prosody).toBe(0);
    expect(result.pronScore).toBe(0);
  });

  it("normalizes word-level flat AccuracyScore/ErrorType", async () => {
    mockFetchOnce(200, {
      RecognitionStatus: "Success",
      DisplayText: "hi there",
      NBest: [
        {
          Display: "hi there",
          AccuracyScore: 80,
          Words: [{ Word: "hi", AccuracyScore: 55, ErrorType: "Mispronunciation" }],
        },
      ],
    });

    const result = await assessPronunciation(baseArgs);
    expect(result.words[0]).toMatchObject({ word: "hi", accuracyScore: 55, errorType: "Mispronunciation" });
  });

  it("normalizes word-level nested PronunciationAssessment.AccuracyScore/ErrorType", async () => {
    mockFetchOnce(200, {
      RecognitionStatus: "Success",
      DisplayText: "hi there",
      NBest: [
        {
          Display: "hi there",
          PronunciationAssessment: { AccuracyScore: 80 },
          Words: [{ Word: "hi", PronunciationAssessment: { AccuracyScore: 55, ErrorType: "Mispronunciation" } }],
        },
      ],
    });

    const result = await assessPronunciation(baseArgs);
    expect(result.words[0]).toMatchObject({ word: "hi", accuracyScore: 55, errorType: "Mispronunciation" });
  });

  it("normalizes word-level flat syllables/phonemes", async () => {
    mockFetchOnce(200, {
      RecognitionStatus: "Success",
      DisplayText: "hi",
      NBest: [
        {
          Display: "hi",
          AccuracyScore: 80,
          Words: [
            {
              Word: "hi",
              AccuracyScore: 55,
              ErrorType: "None",
              Syllables: [{ Syllable: "hi", AccuracyScore: 55 }],
              Phonemes: [{ Phoneme: "HH", AccuracyScore: 60 }],
            },
          ],
        },
      ],
    });

    const result = await assessPronunciation(baseArgs);
    expect(result.words[0].syllables).toEqual([{ syllable: "hi", accuracyScore: 55 }]);
    expect(result.words[0].phonemes).toEqual([{ phoneme: "HH", accuracyScore: 60 }]);
  });

  it("throws PRONUNCIATION_ASSESSMENT_MISSING when Success but neither shape carries a score", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    mockFetchOnce(200, {
      RecognitionStatus: "Success",
      DisplayText: "hello",
      NBest: [{ Display: "hello" }],
    });

    await expect(assessPronunciation(baseArgs)).rejects.toMatchObject({
      code: "PRONUNCIATION_ASSESSMENT_MISSING",
    });
  });

  it("throws a friendly, actionable error for NoMatch instead of an empty success result", async () => {
    mockFetchOnce(200, { RecognitionStatus: "NoMatch" });

    await expect(assessPronunciation(baseArgs)).rejects.toBeInstanceOf(AzureSpeechError);
    mockFetchOnce(200, { RecognitionStatus: "NoMatch" });
    await expect(assessPronunciation(baseArgs)).rejects.toThrow(/No speech was recognized/);
  });

  it("requests IPA phonemes and 5 N-best candidates in the Pronunciation-Assessment header", async () => {
    mockFetchOnce(200, {
      RecognitionStatus: "Success",
      DisplayText: "hi",
      NBest: [{ Display: "hi", AccuracyScore: 80 }],
    });

    await assessPronunciation(baseArgs);

    const call = (global.fetch as jest.Mock).mock.calls[0];
    const headers = call[1].headers as Record<string, string>;
    const config = JSON.parse(Buffer.from(headers["Pronunciation-Assessment"], "base64").toString("utf8"));
    expect(config.PhonemeAlphabet).toBe("IPA");
    expect(config.NBestPhonemeCount).toBe(5);
  });

  it("normalizes syllable Grapheme/Offset/Duration (flat, as Azure actually returns them)", async () => {
    mockFetchOnce(200, {
      RecognitionStatus: "Success",
      DisplayText: "there",
      NBest: [
        {
          Display: "there",
          AccuracyScore: 90,
          Words: [
            {
              Word: "there",
              AccuracyScore: 97,
              ErrorType: "None",
              Syllables: [{ Syllable: "ðɛɹ", Grapheme: "there", Offset: 900000, Duration: 3100000, AccuracyScore: 92 }],
            },
          ],
        },
      ],
    });

    const result = await assessPronunciation(baseArgs);
    expect(result.words[0].syllables).toEqual([
      { syllable: "ðɛɹ", accuracyScore: 92, grapheme: "there", offset: 900000, duration: 3100000 },
    ]);
  });

  it("normalizes phoneme Offset/Duration/NBestPhonemes (flat, as Azure actually returns them)", async () => {
    mockFetchOnce(200, {
      RecognitionStatus: "Success",
      DisplayText: "there",
      NBest: [
        {
          Display: "there",
          AccuracyScore: 90,
          Words: [
            {
              Word: "there",
              AccuracyScore: 97,
              ErrorType: "None",
              Phonemes: [
                {
                  Phoneme: "ð",
                  Offset: 900000,
                  Duration: 1500000,
                  AccuracyScore: 83,
                  NBestPhonemes: [
                    { Phoneme: "ð", Score: 100 },
                    { Phoneme: "θ", Score: 11 },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    const result = await assessPronunciation(baseArgs);
    expect(result.words[0].phonemes).toEqual([
      {
        phoneme: "ð",
        accuracyScore: 83,
        offset: 900000,
        duration: 1500000,
        nBestPhonemes: [
          { phoneme: "ð", score: 100 },
          { phoneme: "θ", score: 11 },
        ],
      },
    ]);
  });

  it("extracts word prosody feedback only when ErrorTypes actually flags an issue (not just present)", async () => {
    mockFetchOnce(200, {
      RecognitionStatus: "Success",
      DisplayText: "there are",
      NBest: [
        {
          Display: "there are",
          AccuracyScore: 90,
          Words: [
            {
              Word: "there",
              AccuracyScore: 97,
              ErrorType: "None",
              // Real Azure shape: ErrorTypes is always present (e.g. ["None"]),
              // and the confidence sub-objects can appear even when nothing
              // was actually flagged — presence alone must not be treated as
              // an issue.
              Feedback: {
                Prosody: {
                  Break: { ErrorTypes: ["None"], UnexpectedBreak: { Confidence: 3.7e-8 }, MissingBreak: { Confidence: 1 } },
                  Intonation: { ErrorTypes: ["None"] },
                },
              },
            },
            {
              Word: "are",
              AccuracyScore: 95,
              ErrorType: "None",
              Feedback: {
                Prosody: {
                  Break: { ErrorTypes: ["MissingBreak"], MissingBreak: { Confidence: 0.9 } },
                  Intonation: { ErrorTypes: ["Monotone"], Monotone: { Confidence: 0.5 } },
                },
              },
            },
          ],
        },
      ],
    });

    const result = await assessPronunciation(baseArgs);
    expect(result.words[0].prosodyFeedback).toBeUndefined();
    expect(result.words[1].prosodyFeedback).toEqual({
      breakErrorType: "MissingBreak",
      breakConfidence: 0.9,
      intonationErrorType: "Monotone",
      monotoneConfidence: 0.5,
    });
  });

  it("captures the top NBest candidate as the sanitized raw result, without leaking other candidates", async () => {
    mockFetchOnce(200, {
      RecognitionStatus: "Success",
      DisplayText: "hi",
      NBest: [
        { Display: "hi", AccuracyScore: 80 },
        { Display: "hi there", AccuracyScore: 10 },
      ],
    });

    const result = await assessPronunciation(baseArgs);
    expect(result.rawResult).toMatchObject({
      recognitionStatus: "Success",
      displayText: "hi",
      nBest: { Display: "hi", AccuracyScore: 80 },
    });
    expect(JSON.stringify(result.rawResult)).not.toContain("hi there");
  });
});
