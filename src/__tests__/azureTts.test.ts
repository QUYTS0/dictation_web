import { AzureTtsError, isAzureTtsConfigured, synthesizeSpeech } from "@/lib/azureTts";

function mockFetchOnce(status: number, options: { audio?: Buffer; contentType?: string; text?: string } = {}) {
  const ok = status >= 200 && status < 300;
  global.fetch = jest.fn().mockResolvedValue({
    ok,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? options.contentType ?? "audio/mpeg" : null) },
    arrayBuffer: async () => {
      const buf = options.audio ?? Buffer.alloc(1000, 1);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    },
    text: async () => options.text ?? "",
  }) as unknown as typeof fetch;
}

describe("isAzureTtsConfigured", () => {
  const originalKey = process.env.AZURE_SPEECH_KEY;
  const originalRegion = process.env.AZURE_SPEECH_REGION;
  afterEach(() => {
    process.env.AZURE_SPEECH_KEY = originalKey;
    process.env.AZURE_SPEECH_REGION = originalRegion;
  });

  it("is false when either env var is missing", () => {
    delete process.env.AZURE_SPEECH_KEY;
    process.env.AZURE_SPEECH_REGION = "eastus";
    expect(isAzureTtsConfigured()).toBe(false);
  });

  it("is true when both are set", () => {
    process.env.AZURE_SPEECH_KEY = "key";
    process.env.AZURE_SPEECH_REGION = "eastus";
    expect(isAzureTtsConfigured()).toBe(true);
  });
});

describe("synthesizeSpeech", () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.AZURE_SPEECH_KEY;
  const originalRegion = process.env.AZURE_SPEECH_REGION;

  beforeEach(() => {
    process.env.AZURE_SPEECH_KEY = "test-key";
    process.env.AZURE_SPEECH_REGION = "eastus";
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.AZURE_SPEECH_KEY = originalKey;
    process.env.AZURE_SPEECH_REGION = originalRegion;
    jest.restoreAllMocks();
  });

  it("throws TTS_NOT_CONFIGURED when env vars are missing", async () => {
    delete process.env.AZURE_SPEECH_KEY;
    await expect(synthesizeSpeech({ text: "hello" })).rejects.toMatchObject({ code: "TTS_NOT_CONFIGURED" });
  });

  it("posts SSML with the default voice/locale/output format to the region's TTS endpoint", async () => {
    mockFetchOnce(200);
    await synthesizeSpeech({ text: "hello" });

    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe("https://eastus.tts.speech.microsoft.com/cognitiveservices/v1");
    expect(init.headers["Content-Type"]).toBe("application/ssml+xml");
    expect(init.headers["X-Microsoft-OutputFormat"]).toBe("audio-24khz-48kbitrate-mono-mp3");
    expect(init.headers["Ocp-Apim-Subscription-Key"]).toBe("test-key");
    expect(init.body).toContain("<voice name='en-US-JennyNeural'>hello</voice>");
  });

  it("escapes SSML special characters in the input text", async () => {
    mockFetchOnce(200);
    await synthesizeSpeech({ text: `Tom & Jerry <said> "hi" it's ok` });

    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(init.body).toContain("Tom &amp; Jerry &lt;said&gt; &quot;hi&quot; it&apos;s ok");
  });

  it("returns the raw audio bytes on success", async () => {
    const audio = Buffer.alloc(2000, 7);
    mockFetchOnce(200, { audio });
    const result = await synthesizeSpeech({ text: "hello" });
    expect(result.audio.byteLength).toBe(2000);
  });

  it("throws TTS_UPSTREAM_ERROR on a non-200 response", async () => {
    mockFetchOnce(500, { text: "server error" });
    await expect(synthesizeSpeech({ text: "hello" })).rejects.toMatchObject({ code: "TTS_UPSTREAM_ERROR" });
  });

  it("throws TTS_UPSTREAM_ERROR when the response content-type isn't audio", async () => {
    mockFetchOnce(200, { contentType: "application/json" });
    await expect(synthesizeSpeech({ text: "hello" })).rejects.toMatchObject({ code: "TTS_UPSTREAM_ERROR" });
  });

  it("throws TTS_UPSTREAM_ERROR when the audio body is implausibly short", async () => {
    mockFetchOnce(200, { audio: Buffer.alloc(10, 1) });
    await expect(synthesizeSpeech({ text: "hello" })).rejects.toMatchObject({ code: "TTS_UPSTREAM_ERROR" });
  });

  it("throws TTS_UPSTREAM_ERROR on a network-level failure", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;
    await expect(synthesizeSpeech({ text: "hello" })).rejects.toBeInstanceOf(AzureTtsError);
    await expect(synthesizeSpeech({ text: "hello" })).rejects.toMatchObject({ code: "TTS_UPSTREAM_ERROR" });
  });
});
