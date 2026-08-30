"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePlayerStore } from "@/store/playerStore";
import type { YouTubePlayerHandle } from "@/components/YouTubePlayer";

interface UseAutoTranscribeSpeechOptions {
  ytPlayerRef: React.RefObject<YouTubePlayerHandle | null>;
}

export type AutoTranscribeStatus = "idle" | "listening" | "done" | "error";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SpeechRecognitionCtor = new () => any;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * EXPERIMENTAL fallback for videos with no YouTube captions. There is no way
 * to feed the YouTube iframe's own audio output into the Web Speech API
 * directly, so this plays the video out loud while the browser's speech
 * recognizer listens through whatever the microphone picks up. Accuracy
 * depends entirely on speaker volume and mic/ambient noise conditions — it's
 * a rough prototype, not a substitute for real captions.
 */
export function useAutoTranscribeSpeech({ ytPlayerRef }: UseAutoTranscribeSpeechOptions) {
  const [status, setStatus] = useState<AutoTranscribeStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [liveText, setLiveText] = useState("");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recognitionRef = useRef<any>(null);
  const finalChunksRef = useRef<string[]>([]);
  const activeRef = useRef(false);

  const playerStatus = usePlayerStore((s) => s.status);
  const isSupported = getSpeechRecognitionCtor() !== null;

  const stop = useCallback(() => {
    activeRef.current = false;
    recognitionRef.current?.stop();
    ytPlayerRef.current?.pauseVideo();
    setStatus((s) => (s === "listening" ? "idle" : s));
  }, [ytPlayerRef]);

  const finish = useCallback(() => {
    if (!activeRef.current) return;
    activeRef.current = false;
    recognitionRef.current?.stop();
    ytPlayerRef.current?.pauseVideo();
    const text = finalChunksRef.current.join(" ").trim();
    if (text) {
      setLiveText(text);
      setStatus("done");
    } else {
      setError("No speech was recognized. Check that your speakers are audible and the mic is allowed, then try again.");
      setStatus("error");
    }
  }, [ytPlayerRef]);

  // The video reaching "ended" is the signal that recognition should wrap up.
  useEffect(() => {
    if (playerStatus === "ended" && activeRef.current) {
      finish();
    }
  }, [playerStatus, finish]);

  const start = useCallback(() => {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      setError("Your browser doesn't support speech recognition (try Chrome).");
      setStatus("error");
      return;
    }

    setError(null);
    setLiveText("");
    finalChunksRef.current = [];
    activeRef.current = true;
    setStatus("listening");

    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recognition.onresult = (event: any) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          finalChunksRef.current.push(result[0].transcript.trim());
        } else {
          interim += result[0].transcript;
        }
      }
      const finalText = finalChunksRef.current.join(" ");
      setLiveText(interim ? `${finalText} ${interim}`.trim() : finalText);
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recognition.onerror = (event: any) => {
      // "no-speech" fires routinely during natural pauses in the video — not
      // fatal, recognition auto-restarts via onend below. Only bail out on
      // permission failures.
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        activeRef.current = false;
        recognitionRef.current = null;
        setError("Microphone access was denied. Allow mic access to use auto-transcribe.");
        setStatus("error");
        ytPlayerRef.current?.pauseVideo();
      }
    };

    recognition.onend = () => {
      // Chrome stops recognition after a period of silence even with
      // continuous=true; transparently restart it while we're still listening.
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
    ytPlayerRef.current?.seekTo(0, true);
  }, [ytPlayerRef]);

  useEffect(() => stop, [stop]);

  return { isSupported, status, error, liveText, start, stop };
}
