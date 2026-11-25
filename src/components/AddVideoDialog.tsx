"use client";

import { useRef } from "react";
import { X } from "lucide-react";
import { AddVideoForm } from "@/components/AddVideoForm";
import { ModalDialog } from "@/components/ModalDialog";

interface AddVideoDialogProps {
  url: string;
  onUrlChange: (url: string) => void;
  onClose: () => void;
}

/**
 * The header's "New video" dialog, reachable from every signed-in page. A
 * true modal (ModalDialog: backdrop, Tab trap, Escape, focus restored to
 * whatever opened it). The typed link is owned by the caller, so closing
 * and reopening keeps it.
 */
export function AddVideoDialog({ url, onUrlChange, onClose }: AddVideoDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <ModalDialog labelledBy="add-video-dialog-title" onClose={onClose} initialFocusRef={inputRef} backdropTestId="add-video-dialog-backdrop">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 id="add-video-dialog-title" className="text-lg font-bold text-ink">
            New video
          </h2>
          <p className="mt-0.5 text-sm text-muted">Paste a YouTube link to start practicing it.</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close new video"
          className="rounded-lg p-1.5 text-muted transition-colors hover:bg-surface hover:text-ink"
        >
          <X size={18} />
        </button>
      </div>
      <AddVideoForm url={url} onUrlChange={onUrlChange} inputRef={inputRef} />
    </ModalDialog>
  );
}
