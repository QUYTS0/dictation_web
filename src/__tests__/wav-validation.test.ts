// Server-side WAV validation for /api/practice/evaluate (src/lib/practice/wavValidation.ts).
import { buildPcmWav, MAX_AUDIO_BYTES, validatePcmWav } from "@/lib/practice/wavValidation";

const SEC = 16_000; // samples per second

function mutate(bytes: Uint8Array, f: (v: DataView) => void): Uint8Array {
  const copy = bytes.slice();
  f(new DataView(copy.buffer));
  return copy;
}

describe("validatePcmWav", () => {
  it("8. accepts exactly what the browser encoder writes and derives the duration from the samples", () => {
    const r = validatePcmWav(buildPcmWav(2 * SEC));
    expect(r).toEqual({ ok: true, durationSec: 2, dataBytes: 64_000, dataOffset: 44 });
  });

  it("9. walks chunks: extra chunks (odd sizes padded) before the data chunk are skipped, not assumed away", () => {
    const r = validatePcmWav(
      buildPcmWav(SEC, [
        { id: "LIST", body: new Uint8Array(33) },
        { id: "fact", body: new Uint8Array(4) },
      ])
    );
    expect(r).toMatchObject({ ok: true, durationSec: 1, dataBytes: 32_000 });
    if (r.ok) expect(r.dataOffset).toBeGreaterThan(44);
  });

  it("accepts the maximum (21 s) and refuses anything longer or too short", () => {
    expect(validatePcmWav(buildPcmWav(21 * SEC)).ok).toBe(true);
    expect(validatePcmWav(buildPcmWav(21 * SEC + 16))).toEqual({ ok: false, reason: "too_long" });
    expect(validatePcmWav(buildPcmWav(100))).toEqual({ ok: false, reason: "too_short" });
    expect(validatePcmWav(buildPcmWav(0))).toEqual({ ok: false, reason: "too_short" });
  });

  it("10. rejects malformed, truncated and inconsistent files", () => {
    const good = buildPcmWav(SEC);
    const cases: Array<[string, Uint8Array, string]> = [
      ["empty", new Uint8Array(0), "too_small"],
      ["not RIFF", mutate(good, (v) => v.setUint8(0, 0x58)), "not_riff_wave"],
      ["not WAVE", mutate(good, (v) => v.setUint8(8, 0x58)), "not_riff_wave"],
      ["truncated file (RIFF size larger than the upload)", good.slice(0, good.byteLength - 100), "size_mismatch"],
      ["trailing junk beyond the RIFF size", new Uint8Array([...good, 1, 2, 3]), "size_mismatch"],
      ["data chunk claims more than exists", mutate(good, (v) => v.setUint32(40, 64_000, true)), "truncated_chunk"],
      ["stereo", mutate(good, (v) => v.setUint16(22, 2, true)), "unsupported_format"],
      ["44.1 kHz", mutate(good, (v) => v.setUint32(24, 44_100, true)), "unsupported_format"],
      ["8-bit", mutate(good, (v) => v.setUint16(34, 8, true)), "unsupported_format"],
      ["compressed (format 3/float)", mutate(good, (v) => v.setUint16(20, 3, true)), "unsupported_format"],
      ["byte rate disagrees", mutate(good, (v) => v.setUint32(28, 64_000, true)), "inconsistent_format"],
      ["block align disagrees", mutate(good, (v) => v.setUint16(32, 4, true)), "inconsistent_format"],
    ];
    for (const [label, bytes, reason] of cases) {
      expect({ label, r: validatePcmWav(bytes) }).toEqual({ label, r: { ok: false, reason } });
    }
  });

  it("rejects a missing/duplicate fmt or data chunk and half-sample data", () => {
    const noData = buildPcmWav(SEC).slice(0, 36);
    new DataView(noData.buffer).setUint32(4, 28, true);
    expect(validatePcmWav(noData)).toEqual({ ok: false, reason: "missing_data" });

    const renamedFmt = mutate(buildPcmWav(SEC), (v) => v.setUint8(12, 0x78)); // "xmt "
    expect(validatePcmWav(renamedFmt)).toEqual({ ok: false, reason: "missing_fmt" });

    const odd = buildPcmWav(SEC);
    const oddData = mutate(odd, (v) => v.setUint32(40, 31_999, true));
    expect(validatePcmWav(oddData).ok).toBe(false);

    const dupFmt = buildPcmWav(SEC, [{ id: "fmt ", body: odd.slice(20, 36) }]);
    expect(validatePcmWav(dupFmt)).toEqual({ ok: false, reason: "duplicate_chunk" });
  });

  it("bounds work: oversized uploads and chunk floods are refused", () => {
    expect(validatePcmWav(new Uint8Array(MAX_AUDIO_BYTES + 1))).toEqual({ ok: false, reason: "too_large" });
    const flood = buildPcmWav(SEC, Array.from({ length: 70 }, () => ({ id: "JUNK", body: new Uint8Array(0) })));
    expect(validatePcmWav(flood)).toEqual({ ok: false, reason: "too_many_chunks" });
  });
});
