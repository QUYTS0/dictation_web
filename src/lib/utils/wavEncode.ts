// Converts a recorded webm/mp4 Blob into 16kHz mono 16-bit PCM WAV, entirely
// in the browser. Azure's Pronunciation Assessment REST endpoint only
// reliably accepts raw PCM WAV — its compressed-codec input path needs a
// GStreamer-enabled Speech SDK host, which a Vercel function doesn't have —
// so this conversion has to happen client-side before the clip is ever
// uploaded to /api/practice/evaluate (see "Shadowing and Pronunciation
// Practice Plan.md" §8/§9).

const TARGET_SAMPLE_RATE = 16_000;

function encodeWavPCM16(samples: Float32Array, sampleRate: number): Blob {
  const bytesPerSample = 2;
  const byteRate = sampleRate * bytesPerSample;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, bytesPerSample, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }

  return new Blob([buffer], { type: "audio/wav" });
}

/** Decodes any Blob the browser's own audio pipeline can play, downmixes to
 *  mono, and resamples to 16kHz — the format Azure Pronunciation Assessment
 *  expects. Throws if the browser can't decode the given Blob at all. */
export async function blobToWav16kMono(blob: Blob): Promise<Blob> {
  const arrayBuffer = await blob.arrayBuffer();
  const AudioContextCtor =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) throw new Error("Web Audio isn't supported in this browser.");

  const decodeContext = new AudioContextCtor();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeContext.decodeAudioData(arrayBuffer);
  } finally {
    void decodeContext.close().catch(() => {});
  }

  const frameCount = Math.ceil(decoded.duration * TARGET_SAMPLE_RATE);
  const offlineContext = new OfflineAudioContext(1, frameCount, TARGET_SAMPLE_RATE);
  const source = offlineContext.createBufferSource();
  source.buffer = decoded;
  // Connecting a multi-channel buffer to a 1-channel destination downmixes
  // automatically per the Web Audio spec's mixing rules.
  source.connect(offlineContext.destination);
  source.start();
  const rendered = await offlineContext.startRendering();

  return encodeWavPCM16(rendered.getChannelData(0), TARGET_SAMPLE_RATE);
}
