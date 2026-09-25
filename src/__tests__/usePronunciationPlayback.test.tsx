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

  it("tapping again while already playing repeats the clip from the start instead of pausing it", async () => {
    const { result } = renderHook(() =>
      usePronunciationPlayback({ itemId: "item-1", knownAudioUrl: "https://dict.example.com/run.mp3", term: "run" })
    );

    await act(async () => {
      result.current.toggle();
      await Promise.resolve();
    });
    expect(result.current.status).toBe("playing");
    expect(playSpy).toHaveBeenCalledTimes(1);
    expect(pauseSpy).not.toHaveBeenCalled();

    await act(async () => {
      result.current.toggle();
      await Promise.resolve();
    });

    // A second tap while already playing must play() again (restart), not
    // pause — this control is "hear it again", never a pause button.
    expect(playSpy).toHaveBeenCalledTimes(2);
    expect(pauseSpy).not.toHaveBeenCalled();
    expect(result.current.status).toBe("playing");
  });
});

describe("usePronunciationPlayback — on-demand resolution", () => {
  const originalFetch = global.fetch;
  let playSpy: jest.SpyInstance;
  let pauseSpy: jest.SpyInstance;

  beforeEach(() => {
    playSpy = jest.spyOn(window.HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    pauseSpy = jest.spyOn(window.HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  });
  afterEach(() => {
    global.fetch = originalFetch;
    playSpy.mockRestore();
    pauseSpy.mockRestore();
  });

  it("resolves via the pronounce route and plays immediately in the same tap — no intermediate 'ready' step", async () => {
    global.fetch = jest.fn(() =>
      mockFetchJson({ audioUrl: "https://cdn.example.com/azure/abc.mp3", source: "synthesized" })
    ) as unknown as typeof fetch;

    const { result } = renderHook(() => usePronunciationPlayback({ itemId: "item-1", knownAudioUrl: null, term: "give up" }));

    await act(async () => {
      result.current.toggle();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/vocabulary/pronounce",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ itemId: "item-1" }) })
    );
    expect(playSpy).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("playing");
  });

  it("a later tap for the SAME resolved identity replays instantly with no further network call", async () => {
    global.fetch = jest.fn(() =>
      mockFetchJson({ audioUrl: "https://cdn.example.com/azure/abc.mp3", source: "synthesized" })
    ) as unknown as typeof fetch;

    const { result } = renderHook(() => usePronunciationPlayback({ itemId: "item-1", knownAudioUrl: null, term: "give up" }));

    await act(async () => {
      result.current.toggle();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      result.current.toggle();
      await Promise.resolve();
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(playSpy).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe("playing");
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

  it("requestGeneratedAlternative bypasses the dictionary shortcut via preferGenerated and plays the alternative immediately", async () => {
    playSpy = jest
      .spyOn(window.HTMLMediaElement.prototype, "play")
      .mockRejectedValueOnce(new Error("404")) // the dead dictionary URL
      .mockResolvedValue(undefined); // the generated alternative plays fine
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
      await Promise.resolve();
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/vocabulary/pronounce",
      expect.objectContaining({ body: JSON.stringify({ itemId: "item-1", preferGenerated: true }) })
    );
    // Plays immediately once resolved — no separate "ready, tap again" step.
    expect(result.current.status).toBe("playing");
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
    playSpy = jest
      .spyOn(window.HTMLMediaElement.prototype, "play")
      .mockRejectedValueOnce(new Error("404")) // tap 1: auto-play attempt on the freshly-resolved broken URL
      .mockRejectedValueOnce(new Error("404")) // tap 2: explicit replay of the same broken URL
      .mockRejectedValueOnce(new Error("404")) // tap 3: retry-same-source-first, still broken — now cleared
      .mockResolvedValue(undefined); // tap 4: fresh URL plays fine
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ audioUrl: "https://cdn.example.com/broken.mp3", source: "cached" }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ audioUrl: "https://cdn.example.com/fresh.mp3", source: "synthesized" }) } as Response);
    global.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() => usePronunciationPlayback({ itemId: "item-1", knownAudioUrl: null, term: "give up" }));

    // First tap: resolves AND immediately attempts to play the broken URL —
    // that attempt fails, but since it was the automatic post-resolve
    // attempt, it falls back to idle silently (no alarming error) rather
    // than getting stuck on a misleading "ready" affordance.
    await act(async () => {
      result.current.toggle();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.status).toBe("idle");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second tap: a real, direct click now — plays the resolved (still
    // broken) URL — fails once (retried as-is, no new fetch).
    await act(async () => {
      result.current.toggle();
      await Promise.resolve();
    });
    expect(result.current.status).toBe("error");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Third tap: retries the SAME broken URL again (retry-same-source-first) — fails again, clearing it.
    await act(async () => {
      result.current.toggle();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Fourth tap: resolvedUrlRef was cleared — re-resolves from the server
    // and plays the fresh URL immediately, in this same tap.
    await act(async () => {
      result.current.toggle();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe("playing");
  });
});
