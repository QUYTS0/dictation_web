import { selectEnglishTrack } from "@/lib/youtubeCaptions/trackSelection";
import type { CaptionTrackMeta } from "@/lib/youtubeCaptions/types";

function track(overrides: Partial<CaptionTrackMeta>): CaptionTrackMeta {
  return { baseUrl: "https://youtube.com/api/timedtext?...", languageCode: "en", ...overrides };
}

describe("selectEnglishTrack", () => {
  it("prefers manual exact en over English ASR", () => {
    const manual = track({ languageCode: "en", kind: undefined });
    const asr = track({ languageCode: "en", kind: "asr" });
    const result = selectEnglishTrack([asr, manual]);
    expect(result?.track).toBe(manual);
  });

  it("prefers exact en over regional en-US", () => {
    const exact = track({ languageCode: "en" });
    const regional = track({ languageCode: "en-US" });
    const result = selectEnglishTrack([regional, exact]);
    expect(result?.track).toBe(exact);
  });

  it("accepts regional English when exact en is absent", () => {
    const regionalUS = track({ languageCode: "en-US" });
    const other = track({ languageCode: "fr" });
    const result = selectEnglishTrack([other, regionalUS]);
    expect(result?.track).toBe(regionalUS);
  });

  it("accepts English ASR as the last-resort English choice", () => {
    const asr = track({ languageCode: "en", kind: "asr" });
    const result = selectEnglishTrack([asr]);
    expect(result?.track).toBe(asr);
    expect(result?.reason).toContain("asr");
  });

  it("rejects non-English tracks entirely, even with an English-sounding display name", () => {
    const french = track({ languageCode: "fr", name: "English (translated)" });
    const result = selectEnglishTrack([french]);
    expect(result).toBeNull();
  });

  it("never selects a track with no baseUrl", () => {
    const noUrl = track({ languageCode: "en", baseUrl: "" });
    const result = selectEnglishTrack([noUrl]);
    expect(result).toBeNull();
  });

  it("is deterministic across multiple English tracks of the same tier", () => {
    const first = track({ languageCode: "en", kind: "asr" });
    const second = track({ languageCode: "en", kind: "asr" });
    const a = selectEnglishTrack([first, second]);
    const b = selectEnglishTrack([first, second]);
    expect(a?.track).toBe(first);
    expect(b?.track).toBe(first);
  });

  it("returns null for an empty track list", () => {
    expect(selectEnglishTrack([])).toBeNull();
  });

  it("accepts several common regional English variants", () => {
    for (const lang of ["en-US", "en-GB", "en-CA", "en-AU"]) {
      const result = selectEnglishTrack([track({ languageCode: lang })]);
      expect(result?.track.languageCode).toBe(lang);
    }
  });

  it("picks up English via vssId when languageCode is missing", () => {
    const result = selectEnglishTrack([track({ languageCode: "", vssId: "a.en" })]);
    expect(result?.track.vssId).toBe("a.en");
  });
});
