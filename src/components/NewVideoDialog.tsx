"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { AddVideoDialog } from "@/components/AddVideoDialog";

interface NewVideoDialogApi {
  open: () => void;
}

const NewVideoDialogContext = createContext<NewVideoDialogApi | null>(null);

/**
 * The ONE "New video" dialog of the signed-in app. The header's New video
 * button, the Dashboard hero's "Start a new video" and the Today list's
 * "N min to today's goal" (with nothing unfinished) all open this same
 * dialog, and a half-typed link is kept across openings, whichever opened it.
 * Mounted once in Providers.
 */
export function NewVideoDialogProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [url, setUrl] = useState("");
  const api = useMemo<NewVideoDialogApi>(() => ({ open: () => setIsOpen(true) }), []);
  return (
    <NewVideoDialogContext.Provider value={api}>
      {children}
      {isOpen && <AddVideoDialog url={url} onUrlChange={setUrl} onClose={() => setIsOpen(false)} />}
    </NewVideoDialogContext.Provider>
  );
}

/**
 * Opens the shared New video dialog (focus returns to whatever opened it).
 * `dialog` is what to render: nothing under the provider (it renders the one
 * dialog itself); outside one (a component rendered on its own, e.g. in a
 * test) the caller gets a dialog of its own, so the button still works.
 */
export function useNewVideoDialog(): { open: () => void; dialog: ReactNode } {
  const shared = useContext(NewVideoDialogContext);
  const [isOpen, setIsOpen] = useState(false);
  const [url, setUrl] = useState("");
  if (shared) return { open: shared.open, dialog: null };
  return {
    open: () => setIsOpen(true),
    dialog: isOpen ? <AddVideoDialog url={url} onUrlChange={setUrl} onClose={() => setIsOpen(false)} /> : null,
  };
}
