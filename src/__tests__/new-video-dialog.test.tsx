/**
 * The app's ONE New video dialog (src/components/NewVideoDialog.tsx): the
 * header's New video button and the Dashboard hero's "Start a new video" (and
 * its Today row) open the same dialog, which keeps a half-typed link whichever
 * opened it. Outside the provider a caller still gets a working dialog.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn(), replace: jest.fn() }) }));
jest.mock("@/context/auth", () => ({ useAuth: () => ({ user: { id: "user-1" }, loading: false, openAuthModal: jest.fn() }) }));

import { NewVideoDialogProvider, useNewVideoDialog } from "@/components/NewVideoDialog";

function Opener({ label }: { label: string }) {
  const newVideo = useNewVideoDialog();
  return (
    <>
      <button type="button" onClick={newVideo.open}>
        {label}
      </button>
      {newVideo.dialog}
    </>
  );
}

// The form inside the dialog uses the query client (as under Providers).
const withClient = (ui: ReactNode) => <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>;
const field = () => within(screen.getByRole("dialog", { name: "New video" })).getByRole("textbox", { name: "YouTube URL" });

describe("NewVideoDialog", () => {
  it("under the provider: every opener opens the same single dialog, and the typed link is kept across them", async () => {
    const user = userEvent.setup();
    render(
      withClient(
        <NewVideoDialogProvider>
          <Opener label="New video (header)" />
          <Opener label="Start a new video (hero)" />
        </NewVideoDialogProvider>
      )
    );
    const header = screen.getByRole("button", { name: "New video (header)" });
    const hero = screen.getByRole("button", { name: "Start a new video (hero)" });

    await user.click(hero);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(document.activeElement).toBe(field());
    await user.type(field(), "https://youtu.be/abc");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(hero); // focus goes back to what opened it

    await user.click(header);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(field()).toHaveValue("https://youtu.be/abc");
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(header);
  });

  it("without the provider (a component on its own): the opener still gets a working dialog of its own", async () => {
    const user = userEvent.setup();
    render(withClient(<Opener label="Start a new video" />));
    await user.click(screen.getByRole("button", { name: "Start a new video" }));
    expect(screen.getByRole("dialog", { name: "New video" })).toBeInTheDocument();
    expect(document.activeElement).toBe(field());
  });
});
