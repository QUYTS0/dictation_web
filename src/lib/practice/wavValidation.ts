/**
 * Server-side validation of the audio uploaded for Pronunciation evaluation.
 *
 * The only transport the app produces is what src/lib/utils/wavEncode.ts
 * writes in the browser (every browser/iPhone recording is decoded and
 * re-encoded there): RIFF/WAVE, PCM (format 1), mono, 16 kHz, 16-bit —
 * exactly what Azure's short-audio Pronunciation Assessment accepts. Anything
 * else is rejected here, before quota or Azure are touched.
 *
 * The duration used for quota/usage is derived from the validated sample
 * data (data chunk bytes ÷ byte rate) — never from a client-supplied field.
 * It says how much audio there is, not that it contains speech.
 */

export const WAV_SAMPLE_RATE = 16_000;
export const WAV_CHANNELS = 1;
export const WAV_BITS_PER_SAMPLE = 16;
const BLOCK_ALIGN = (WAV_CHANNELS * WAV_BITS_PER_SAMPLE) / 8;
const BYTE_RATE = WAV_SAMPLE_RATE * BLOCK_ALIGN;

/** Same limit as fn_shadowing_max_audio_sec() in migration 038: the recorder
 *  caps takes at 20 s, plus 1 s of decoder slack. */
export const MAX_AUDIO_SEC = 21;
/** Shortest audio worth sending (a tenth of a second of samples). */
export const MIN_AUDIO_SEC = 0.1;
/** 21 s of 16 kHz mono 16-bit PCM is 672,000 bytes; headers and small extra
 *  chunks fit easily in the remaining headroom. */
export const MAX_AUDIO_BYTES = 1024 * 1024;
/** Bounds the chunk walk regardless of declared sizes. */
const MAX_CHUNKS = 64;

export type WavRejection =
  | "too_large"
  | "too_small"
  | "not_riff_wave"
  | "size_mismatch"
  | "truncated_chunk"
  | "missing_fmt"
  | "missing_data"
  | "duplicate_chunk"
  | "unsupported_format"
  | "inconsistent_format"
  | "misaligned_data"
  | "too_short"
  | "too_long"
  | "too_many_chunks";

export type WavValidation =
  | { ok: true; durationSec: number; dataBytes: number; dataOffset: number }
  | { ok: false; reason: WavRejection };

function fourcc(view: DataView, offset: number): string {
  return String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
}

export function validatePcmWav(bytes: Uint8Array): WavValidation {
  if (bytes.byteLength > MAX_AUDIO_BYTES) return { ok: false, reason: "too_large" };
  if (bytes.byteLength < 12) return { ok: false, reason: "too_small" };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (fourcc(view, 0) !== "RIFF" || fourcc(view, 8) !== "WAVE") return { ok: false, reason: "not_riff_wave" };

  // The RIFF size must describe this exact file (one trailing pad byte allowed).
  const riffEnd = view.getUint32(4, true) + 8;
  if (riffEnd > bytes.byteLength || bytes.byteLength - riffEnd > 1) return { ok: false, reason: "size_mismatch" };

  let fmtSeen = false;
  let data: { offset: number; size: number } | null = null;
  let offset = 12;
  let chunks = 0;
  while (offset + 8 <= riffEnd) {
    if (++chunks > MAX_CHUNKS) return { ok: false, reason: "too_many_chunks" };
    const id = fourcc(view, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (body + size > riffEnd) return { ok: false, reason: "truncated_chunk" };

    if (id === "fmt ") {
      if (fmtSeen) return { ok: false, reason: "duplicate_chunk" };
      fmtSeen = true;
      if (size < 16) return { ok: false, reason: "truncated_chunk" };
      const format = view.getUint16(body, true);
      const channels = view.getUint16(body + 2, true);
      const sampleRate = view.getUint32(body + 4, true);
      const byteRate = view.getUint32(body + 8, true);
      const blockAlign = view.getUint16(body + 12, true);
      const bits = view.getUint16(body + 14, true);
      if (format !== 1 || channels !== WAV_CHANNELS || sampleRate !== WAV_SAMPLE_RATE || bits !== WAV_BITS_PER_SAMPLE) {
        return { ok: false, reason: "unsupported_format" };
      }
      // Derived fields must agree with the declared ones.
      if (blockAlign !== BLOCK_ALIGN || byteRate !== BYTE_RATE) return { ok: false, reason: "inconsistent_format" };
    } else if (id === "data") {
      if (data) return { ok: false, reason: "duplicate_chunk" };
      data = { offset: body, size };
    }
    // Other chunks (LIST, fact, …) are skipped; chunks are word-aligned.
    offset = body + size + (size % 2);
  }
  if (offset < riffEnd && riffEnd - offset > 1) return { ok: false, reason: "truncated_chunk" };

  if (!fmtSeen) return { ok: false, reason: "missing_fmt" };
  if (!data) return { ok: false, reason: "missing_data" };
  if (data.size % BLOCK_ALIGN !== 0) return { ok: false, reason: "misaligned_data" };

  const durationSec = data.size / BYTE_RATE;
  if (durationSec < MIN_AUDIO_SEC) return { ok: false, reason: "too_short" };
  if (durationSec > MAX_AUDIO_SEC) return { ok: false, reason: "too_long" };
  return { ok: true, durationSec, dataBytes: data.size, dataOffset: data.offset };
}

/** Test/fixture helper: a WAV exactly as wavEncode.ts writes it, optionally
 *  with extra chunks before the data chunk. */
export function buildPcmWav(sampleCount: number, extraChunks: Array<{ id: string; body: Uint8Array }> = []): Uint8Array {
  const extras = extraChunks.map((c) => ({ ...c, padded: c.body.byteLength + (c.body.byteLength % 2) }));
  const extraBytes = extras.reduce((n, c) => n + 8 + c.padded, 0);
  const dataSize = sampleCount * BLOCK_ALIGN;
  const total = 12 + 24 + extraBytes + 8 + dataSize;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  const write = (o: number, s: string) => {
    for (let i = 0; i < 4; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  write(0, "RIFF");
  view.setUint32(4, total - 8, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, WAV_CHANNELS, true);
  view.setUint32(24, WAV_SAMPLE_RATE, true);
  view.setUint32(28, BYTE_RATE, true);
  view.setUint16(32, BLOCK_ALIGN, true);
  view.setUint16(34, WAV_BITS_PER_SAMPLE, true);
  let o = 36;
  for (const c of extras) {
    write(o, c.id);
    view.setUint32(o + 4, c.body.byteLength, true);
    out.set(c.body, o + 8);
    o += 8 + c.padded;
  }
  write(o, "data");
  view.setUint32(o + 4, dataSize, true);
  return out;
}
