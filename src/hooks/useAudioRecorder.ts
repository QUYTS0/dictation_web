"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type AudioRecorderStatus = "idle" | "requesting-permission" | "recording" | "stopped" | "error";
export type AudioRecorderErrorReason = "permission-denied" | "no-microphone" | "unsupported" | "unknown";

export interface RecordedClip {
  blob: Blob;
  /** Object URL for local playback — caller does not need to revoke it; the
   *  hook revokes it itself on the next recording/discard/unmount. */
  url: string;
  mimeType: string;
  durationSec: number;
}

// Preferred first: WebM/Opus is what Chrome/Edge/Android Chrome/Firefox
// record. Safari (pre-18.4, and 18.4+ unless WebM is explicitly requested)
// only supports MP4/AAC, so that's the fallback rather than the primary pick.
const CANDIDATE_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/ogg;codecs=opus",
];

function pickSupportedMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return CANDIDATE_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
}

function classifyGetUserMediaError(err: unknown): AudioRecorderErrorReason {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "permission-denied";
  if (name === "NotFoundError" || name === "DevicesNotFoundError") return "no-microphone";
  return "unknown";
}

interface UseAudioRecorderOptions {
  /** Safety cap — auto-stops a recording that runs this long. Default 20s. */
  maxDurationSec?: number;
}

/**
 * Local-first mic recorder: records into an in-memory Blob only, never
 * touches the network. Nothing here persists past a `discard()`/unmount/new
 * `start()` — uploading a saved take is a separate, later concern (see
 * "Shadowing and Pronunciation Practice Plan.md" §8/§10).
 */
export function useAudioRecorder({ maxDurationSec = 20 }: UseAudioRecorderOptions = {}) {
  const [status, setStatus] = useState<AudioRecorderStatus>("idle");
  const [error, setError] = useState<AudioRecorderErrorReason | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  // Running 0..1 mic level, sampled every animation frame while recording —
  // independent of MediaRecorder itself, so it works regardless of mimeType.
  const [level, setLevel] = useState(0);
  const [clip, setClip] = useState<RecordedClip | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const timerIntervalRef = useRef<number | null>(null);
  const maxDurationTimeoutRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const levelRafRef = useRef<number | null>(null);
  const clipUrlRef = useRef<string | null>(null);

  const clearTimers = useCallback(() => {
    if (timerIntervalRef.current !== null) {
      window.clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
    if (maxDurationTimeoutRef.current !== null) {
      window.clearTimeout(maxDurationTimeoutRef.current);
      maxDurationTimeoutRef.current = null;
    }
    if (levelRafRef.current !== null) {
      cancelAnimationFrame(levelRafRef.current);
      levelRafRef.current = null;
    }
  }, []);

  const teardownStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    analyserRef.current = null;
    void audioContextRef.current?.close().catch(() => {});
    audioContextRef.current = null;
  }, []);

  const stop = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
  }, []);

  const discard = useCallback(() => {
    clearTimers();
    teardownStream();
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
    recorderRef.current = null;
    chunksRef.current = [];
    if (clipUrlRef.current) {
      URL.revokeObjectURL(clipUrlRef.current);
      clipUrlRef.current = null;
    }
    setClip(null);
    setElapsedSec(0);
    setLevel(0);
    setStatus("idle");
    setError(null);
  }, [clearTimers, teardownStream]);

  const start = useCallback(async () => {
    if (status === "requesting-permission" || status === "recording") return;

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("unsupported");
      setStatus("error");
      return;
    }

    if (clipUrlRef.current) {
      URL.revokeObjectURL(clipUrlRef.current);
      clipUrlRef.current = null;
    }
    setClip(null);
    setError(null);
    setStatus("requesting-permission");

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      setError(classifyGetUserMediaError(err));
      setStatus("error");
      return;
    }

    const mimeType = pickSupportedMimeType();
    if (!mimeType) {
      stream.getTracks().forEach((track) => track.stop());
      setError("unsupported");
      setStatus("error");
      return;
    }

    streamRef.current = stream;

    // Level meter via a plain AnalyserNode read on every animation frame —
    // deliberately not derived from the MediaRecorder/Blob, which can't be
    // inspected mid-recording.
    const AudioContextCtor =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (AudioContextCtor) {
      const audioContext = new AudioContextCtor();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      audioContextRef.current = audioContext;
      analyserRef.current = analyser;

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        const currentAnalyser = analyserRef.current;
        if (!currentAnalyser) return;
        currentAnalyser.getByteTimeDomainData(dataArray);
        let sumSquares = 0;
        for (let i = 0; i < dataArray.length; i++) {
          const normalized = (dataArray[i] - 128) / 128;
          sumSquares += normalized * normalized;
        }
        const rms = Math.sqrt(sumSquares / dataArray.length);
        // Raw voice RMS rarely approaches 1 — scale up so the meter actually
        // moves for normal speaking volume instead of sitting near-empty.
        setLevel(Math.min(1, rms * 4));
        levelRafRef.current = requestAnimationFrame(tick);
      };
      levelRafRef.current = requestAnimationFrame(tick);
    }

    const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 32_000 });
    chunksRef.current = [];

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };

    recorder.onstop = () => {
      clearTimers();
      // Wall-clock duration rather than trusting the Blob's own metadata —
      // Chrome's WebM/Opus recordings are a well-known case of an
      // unreliable/absent duration in the container itself.
      const durationSec = (Date.now() - startedAtRef.current) / 1000;
      const blob = new Blob(chunksRef.current, { type: mimeType });
      chunksRef.current = [];
      teardownStream();

      if (blob.size === 0) {
        setStatus("error");
        setError("unknown");
        return;
      }

      const url = URL.createObjectURL(blob);
      clipUrlRef.current = url;
      setClip({ blob, url, mimeType, durationSec });
      setStatus("stopped");
      setLevel(0);
    };

    recorderRef.current = recorder;
    startedAtRef.current = Date.now();
    recorder.start();
    setStatus("recording");
    setElapsedSec(0);

    timerIntervalRef.current = window.setInterval(() => {
      setElapsedSec((Date.now() - startedAtRef.current) / 1000);
    }, 100);

    maxDurationTimeoutRef.current = window.setTimeout(stop, maxDurationSec * 1000);
  }, [status, maxDurationSec, stop, clearTimers, teardownStream]);

  // Never leave a live mic stream/AudioContext running past unmount.
  useEffect(() => {
    return () => {
      clearTimers();
      teardownStream();
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        recorderRef.current.stop();
      }
      recorderRef.current = null;
      if (clipUrlRef.current) URL.revokeObjectURL(clipUrlRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { status, error, elapsedSec, level, clip, start, stop, discard };
}
