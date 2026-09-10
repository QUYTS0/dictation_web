import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

/**
 * Minimal, dedicated click-to-enlarge overlay for a saved vocabulary item's
 * image — not built on ReportDialogShell. That shell's own window-level
 * Escape listener has no concept of "topmost overlay" (it just calls its
 * own onClose unconditionally), so nesting a second instance inside it would
 * make a single Escape press close both this lightbox AND the vocabulary
 * detail dialog underneath it. This component owns its own Escape handling
 * instead — capture-phase plus stopImmediatePropagation — so Escape here
 * closes only itself, never the parent dialog.
 *
 * Only ever mounted from a client-side click (never during the initial
 * render), so — unlike ReportDialogShell — it doesn't need a "mounted"
 * gate before calling createPortal: `document` is always available by the
 * time a click handler can fire.
 */
export function VocabularyImageLightbox({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt: string;
  onClose: () => void;
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeButtonRef.current?.focus();

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onClose();
    };
    // Capture phase: runs before the parent dialog's own (bubble-phase)
    // Escape listener, and stopImmediatePropagation there keeps that parent
    // listener from ever seeing this keypress.
    window.addEventListener("keydown", handleKeyDown, true);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [onClose]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt || "Enlarged image"}
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/85 p-4"
      onClick={onClose}
    >
      <button
        ref={closeButtonRef}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        aria-label="Close enlarged image"
        className="absolute right-4 top-[max(1rem,env(safe-area-inset-top))] flex h-11 w-11 items-center justify-center rounded-full bg-black/50 text-white hover:bg-black/70"
      >
        <X size={20} />
      </button>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        onClick={(event) => event.stopPropagation()}
        className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain shadow-2xl"
      />
    </div>,
    document.body
  );
}
