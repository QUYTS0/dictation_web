import { act, renderHook } from "@testing-library/react";
import { usePronunciationPlayback } from "@/hooks/usePronunciationPlayback";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function mockFetchJson(body: unknown, ok = true) {
  return Promise.resolve({ ok, json: async () => body } as Response);
}

describe("usePronunciationPlayback — known dictionary audio", () => {
  let playSpy: jest.SpyInstance;
  let pauseSpy: jest.SpyInstance;
  const originalFetch = global.fetch;

  beforeEach(() => {
    playSpy = jest.spyOn(window.HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    pauseSpy = jest.spyOn(window.HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  });
  afterEach(() => {
    playSpy.mockRestore();
    pauseSpy.mockRestore();
    global.fetch = originalFetch;
  });

  it("plays immediately on tap with no network call", async () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    const { result } = renderHook(() =>
      usePronunciationPlayback({ itemId: "item-1", knownAudioUrl: "https://dict.example.com/run.mp3", term: "run" })
    );

    await act(async () => {
      result.current.toggle();
      await Promise.resolve();
    });

    expect(playSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.current.status).toBe("playing");
  });
});

describe("usePronunciationPlayback — on-demand resolution", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("resolves via the pronounce route and surfaces 'ready' instead of auto-playing", async () => {
    global.fetch = jest.fn(() =>
      mockFetchJson({ audioUrl: "https://cdn.example.com/azure/abc.mp3", source: "synthesized" })
    ) as unknown as typeof fetch;

    const { result } = renderHook(() => usePronunciationPlayback({ itemId: "item-1", knownAudioUrl: null, term: "give up" }));

    await act(async () => {
      result.current.toggle();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/vocabulary/pronounce",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ itemId: "item-1" }) })
    );
    expect(result.current.status).toBe("ready");
  });

  it("discards a stale in-flight response when the pronunciation identity changes before the fetch resolves", async () => {
    const pending = deferred<Response>();
    global.fetch = jest.fn(() => pending.promise) as unknown as typeof fetch;

    const { result, rerender } = renderHook(
      ({ term }: { term: string }) => usePronunciationPlayback({ itemId: "item-1", knownAudioUrl: null, term }),
      { initialProps: { term: "jumped at" } }
    );

    act(() => {
      result.current.toggle();
    });
    expect(result.current.status).toBe("loading");

    // The item is edited to a different term WHILE the request is still in
    // flight — same itemId, new pronunciation identity.
    rerender({ term: "sprint" });
    expect(result.current.status).toBe("idle");

    await act(async () => {
      pending.resolve({
        ok: true,
        json: async () => ({ audioUrl: "https://cdn.example.com/jumped-at.mp3", source: "synthesized" }),
      } as Response);
      await Promise.resolve();
      await Promise.resolve();
    });

    // The stale response for "jumped at" must never be applied now that
    // the item shows "sprint" — status stays idle, not "ready".
    expect(result.current.status).toBe("idle");
  });
});

describe("usePronunciationPlayback — same itemId, edited pronunciation identity", () => {
  let playSpy: jest.SpyInstance;
  let pauseSpy: jest.SpyInstance;
  const originalFetch = global.fetch;

  beforeEach(() => {
    playSpy = jest.spyOn(window.HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    pauseSpy = jest.spyOn(window.HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  });
  afterEach(() => {
    playSpy.mockRestore();
    pauseSpy.mockRestore();
    global.fetch = originalFetch;
  });

  it("never plays the OLD term's known audio after an in-place edit changes term/canonicalForm (same itemId)", async () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    const { result, rerender } = renderHook(
      (props: { knownAudioUrl: string | null; term: string }) =>
        usePronunciationPlayback({ itemId: "item-1", ...props }),
      { initialProps: { knownAudioUrl: "https://dict.example.com/jumped.mp3" as string | null, term: "jumped" } }
    );

    // Edit the item's term (e.g. via PATCH) — the dialog stays open on the
    // SAME item id, but audio_url has been invalidated server-side (null).
    rerender({ knownAudioUrl: null, term: "sprint" });

    await act(async () => {
      result.current.toggle();
      await Promise.resolve();
    });

    // Must NOT have played the stale "jumped.mp3" — there was no known
    // audio for "sprint", so it must have gone to the network instead.
    expect(playSpy).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("resets an in-progress/ready state to idle when the identity changes", async () => {
    global.fetch = jest.fn(
      () => new Promise(() => {}) // never resolves
    ) as unknown as typeof fetch;

    const { result, rerender } = renderHook(
      (props: { term: string }) => usePronunciationPlayback({ itemId: "item-1", knownAudioUrl: null, ...props }),
      { initialProps: { term: "jumped at" } }
    );

    act(() => {
      result.current.toggle();
    });
    expect(result.current.status).toBe("loading");

    rerender({ term: "run" });
    expect(result.current.status).toBe("idle");
  });
});

describe("usePronunciationPlayback — cross-instance playback exclusivity", () => {
  let playSpy: jest.SpyInstance;
  let pauseSpy: jest.SpyInstance;

  beforeEach(() => {
    playSpy = jest.spyOn(window.HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    pauseSpy = jest.spyOn(window.HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  });
  afterEach(() => {
    playSpy.mockRestore();
    pauseSpy.mockRestore();
  });

  it("starting playback on one card's button pauses another card's already-playing button", async () => {
    const cardA = renderHook(() =>
      usePronunciationPlayback({ itemId: "item-a", knownAudioUrl: "https://dict.example.com/a.mp3", term: "a" })
    );
    const cardB = renderHook(() =>
      usePronunciationPlayback({ itemId: "item-b", knownAudioUrl: "https://dict.example.com/b.mp3", term: "b" })
    );

    await act(async () => {
      cardA.result.current.toggle();
      await Promise.resolve();
    });
    expect(cardA.result.current.status).toBe("playing");

    await act(async () => {
      cardB.result.current.toggle();
      await Promise.resolve();
    });

    expect(pauseSpy).toHaveBeenCalled();
    expect(cardA.result.current.status).toBe("idle");
    expect(cardB.result.current.status).toBe("playing");
  });
});

describe("usePronunciationPlayback — recovery from unusable dictionary audio", () => {
  const originalFetch = global.fetch;
  let playSpy: jest.SpyInstance;

  afterEach(() => {
    global.fetch = originalFetch;
    playSpy.mockRestore();
  });

  it("surfaces an explicit recovery action after dictionary playback fails, and never retries it automatically", async () => {
    playSpy = jest.spyOn(window.HTMLMediaElement.prototype, "play").mockRejectedValue(new Error("404"));
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    const { result } = renderHook(() =>
      usePronunciationPlayback({ itemId: "item-1", knownAudioUrl: "https://dict.example.com/dead.mp3", term: "run" })
    );

    await act(async () => {
      result.current.toggle();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.status).toBe("error");
    expect(result.current.canRecoverWithGenerated).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("requestGeneratedAlternative bypasses the dictionary shortcut via preferGenerated", async () => {
    playSpy = jest.spyOn(window.HTMLMediaElement.prototype, "play").mockRejectedValue(new Error("404"));
    global.fetch = jest.fn(() =>
      mockFetchJson({ audioUrl: "https://cdn.example.com/azure/generated.mp3", source: "synthesized" })
    ) as unknown as typeof fetch;

    const { result } = renderHook(() =>
      usePronunciationPlayback({ itemId: "item-1", knownAudioUrl: "https://dict.example.com/dead.mp3", term: "run" })
    );

    await act(async () => {
      result.current.toggle();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.canRecoverWithGenerated).toBe(true);

    await act(async () => {
      result.current.requestGeneratedAlternative();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/vocabulary/pronounce",
      expect.objectContaining({ body: JSON.stringify({ itemId: "item-1", preferGenerated: true }) })
    );
    expect(result.current.status).toBe("ready");
  });
});

describe("usePronunciationPlayback — self-healing a broken server-resolved asset", () => {
  const originalFetch = global.fetch;
  let playSpy: jest.SpyInstance;

  afterEach(() => {
    global.fetch = originalFetch;
    playSpy.mockRestore();
  });

  it("re-resolves from the server after the SAME server-resolved URL fails twice in a row", async () => {
    playSpy = jest.spyOn(window.HTMLMediaElement.prototype, "play").mockRejectedValue(new Error("404"));
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ audioUrl: "https://cdn.example.com/broken.mp3", source: "cached" }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ audioUrl: "https://cdn.example.com/fresh.mp3", source: "synthesized" }) } as Response);
    global.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() => usePronunciationPlayback({ itemId: "item-1", knownAudioUrl: null, term: "give up" }));

    // First tap: resolves to the broken URL, doesn't auto-play.
    await act(async () => {
      result.current.toggle();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.status).toBe("ready");

    // Second tap: plays the resolved (broken) URL — fails once (retried as-is).
    await act(async () => {
      result.current.toggle();
      await Promise.resolve();
    });
    expect(result.current.status).toBe("error");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Third tap: retries the SAME broken URL again (retry-same-source-first) — fails again.
    await act(async () => {
      result.current.toggle();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Fourth tap: two failures on the same URL now clears it, so this tap
    // re-resolves from the server instead of retrying forever.
    await act(async () => {
      result.current.toggle();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
