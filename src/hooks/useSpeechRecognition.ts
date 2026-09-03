"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type SpeechRecognitionStatus = "idle" | "listening" | "done" | "unsupported" | "error";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SpeechRecognitionCtor = new () => any;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * Live speech-to-text for Shadowing's Word Match evaluation — see "Shadowing
 * and Pronunciation Practice Plan.md" §8.1. Started/stopped alongside a
 * recording (not called on an already-recorded Blob afterward): the Web
 * Speech API only transcribes a live microphone stream, so the transcript
 * has to be captured while the mic is open, ready for whenever an Evaluate
 * action reads it. Chrome/Edge/Android Chrome only — Safari/iOS and any
 * other browser without `SpeechRecognition` report `status: "unsupported"`
 * up front rather than a silently-broken listening state.
 *
 * Not wired to any UI yet — see plan §10 (the Evaluation tab, not yet
 * built). This hook is a standalone, inert building block until then.
 */
export function useSpeechRecognition() {
  const [status, setStatus] = useState<SpeechRecognitionStatus>(() =>
    getSpeechRecognitionCtor() ? "idle" : "unsupported"
  );
  const [transcript, setTranscript] = useState<string | null>(null);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recognitionRef = useRef<any>(null);
  const finalChunksRef = useRef<string[]>([]);
  const activeRef = useRef(false);

  const start = useCallback(() => {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      setStatus("unsupported");
      return;
    }

    finalChunksRef.current = [];
    setTranscript(null);
    activeRef.current = true;
    setStatus("listening");

    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = "en-US";

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recognition.onresult = (event: any) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) finalChunksRef.current.push(result[0].transcript.trim());
      }
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recognition.onerror = (event: any) => {
      // "no-speech"/"aborted" fire routinely (a brief pause, or our own
      // stop() below) — only a real permission failure is fatal here.
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        activeRef.current = false;
        setStatus("error");
      }
    };

    recognition.onend = () => {
      // Chrome stops recognition after a period of silence even with
      // continuous=true; transparently restart it while still recording —
      // Shadowing clips are short, but a mid-sentence pause shouldn't cut
      // the transcript short.
      if (activeRef.current) {
        try {
          recognition.start();
        } catch {
          // Already starting/started — ignore.
        }
      }
    };

    recognitionRef.current = recognition;
    recognition.start();
  }, []);

  const stop = useCallback(() => {
    activeRef.current = false;
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setTranscript(finalChunksRef.current.join(" ").trim() || null);
    setStatus((s) => (s === "listening" ? "done" : s));
  }, []);

  const reset = useCallback(() => {
    activeRef.current = false;
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    finalChunksRef.current = [];
    setTranscript(null);
    setStatus(getSpeechRecognitionCtor() ? "idle" : "unsupported");
  }, []);

  // Never leave a live recognizer running past unmount.
  useEffect(() => {
    return () => {
      activeRef.current = false;
      recognitionRef.current?.stop();
      recognitionRef.current = null;
    };
  }, []);

  return { status, transcript, start, stop, reset };
}
