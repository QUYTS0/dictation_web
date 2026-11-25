"use client";

import { useId, useState, type Ref } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowRight, Video } from "lucide-react";
import { useAuth } from "@/context/auth";
import { invalidateLearningViews } from "@/lib/queries/learningInvalidation";
import { isValidYouTubeUrl } from "@/lib/utils/url";

/**
 * Resolve a pasted YouTube link and open its practice page. The practice
 * page chooses the mode (saved last mode, else Dictation), so no mode is
 * sent here.
 */
export function useAddVideo() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const userId = user?.id;
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const submit = async (rawUrl: string) => {
    setError(null);
    const trimmed = rawUrl.trim();
    if (!trimmed) return setError("Please paste a YouTube URL.");
    if (!isValidYouTubeUrl(trimmed)) return setError("That doesn't look like a valid YouTube URL.");
    setAdding(true);
    try {
      const res = await fetch("/api/video/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: trimmed }),
      });
      const data = await res.json();
      if (!res.ok || data.status !== "ok") {
        setError(data.message ?? "Failed to add the video. Please try again.");
        return;
      }
      if (userId) invalidateLearningViews(queryClient, userId);
      router.push(`/dictation/${data.videoId}`);
    } catch {
      setError("Network error. Please check your connection and try again.");
    } finally {
      setAdding(false);
    }
  };

  return { submit, adding, error, clearError: () => setError(null) };
}

interface AddVideoFormProps {
  /** The typed link lives with the caller, so collapsing a disclosure or
   *  closing a dialog keeps it. */
  url: string;
  onUrlChange: (url: string) => void;
  /** `light` for white surfaces (dialog), `dark` for the navy hero. */
  variant?: "light" | "dark";
  /** `stacked` keeps the button under the field (narrow panels). */
  layout?: "row" | "stacked";
  inputId?: string;
  inputRef?: Ref<HTMLInputElement>;
  autoFocus?: boolean;
}

/**
 * The one "add a video" form: a single URL field, no mode choice. Used by
 * the header's New Video dialog (every page) and the Dashboard.
 */
export function AddVideoForm({ url, onUrlChange, variant = "light", layout = "row", inputId, inputRef, autoFocus }: AddVideoFormProps) {
  const { submit, adding, error, clearError } = useAddVideo();
  const generatedId = useId();
  const id = inputId ?? `add-video-url-${generatedId}`;
  const errorId = `${id}-error`;
  const dark = variant === "dark";

  return (
    <div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit(url);
        }}
        className={clsx("flex flex-col gap-3", layout === "row" && "sm:flex-row")}
      >
        <div className="relative flex flex-1 items-center">
          <Video className={clsx("absolute left-4", dark ? "text-slate-400" : "text-muted")} size={20} aria-hidden="true" />
          <input
            id={id}
            ref={inputRef}
            type="text"
            value={url}
            onChange={(e) => {
              onUrlChange(e.target.value);
              clearError();
            }}
            autoFocus={autoFocus}
            placeholder="Paste a YouTube URL"
            aria-label="YouTube URL"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            className={clsx(
              "w-full rounded-xl border py-3 pr-4 pl-12 text-base outline-none focus:ring-2",
              dark
                ? "border-white/15 bg-white/10 text-white placeholder:text-slate-400 focus:ring-primary-500/50"
                : "border-line bg-white text-ink placeholder:text-muted focus:ring-primary-500/30"
            )}
          />
        </div>
        <button
          type="submit"
          disabled={adding}
          className="flex items-center justify-center gap-2 whitespace-nowrap rounded-xl bg-primary-600 px-6 py-3 font-semibold text-white shadow-sm transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {adding ? "Adding…" : "Add video"} {!adding && <ArrowRight size={18} aria-hidden="true" />}
        </button>
      </form>
      {error && (
        // text-red-600 rather than the softer `danger` token: body-size error
        // text needs ≥ 4.5:1 contrast on white.
        <p id={errorId} className={clsx("mt-3 text-sm", dark ? "text-red-300" : "text-red-600")}>
          ⚠ {error}
        </p>
      )}
    </div>
  );
}
