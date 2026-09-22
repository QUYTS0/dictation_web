import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmDialog } from "@/components/ConfirmDialog";

function noop() {}

describe("ConfirmDialog", () => {
  it("renders title and body, and focuses Cancel by default (safer default for a destructive action)", () => {
    render(
      <ConfirmDialog title="Delete this?" body="Cannot be undone." confirmLabel="Delete" onConfirm={noop} onCancel={noop} />
    );
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByText("Delete this?")).toBeInTheDocument();
    expect(screen.getByText("Cannot be undone.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("calls onConfirm and onCancel from their respective buttons", async () => {
    const onConfirm = jest.fn();
    const onCancel = jest.fn();
    const user = userEvent.setup();
    render(
      <ConfirmDialog title="Delete this?" body="Cannot be undone." confirmLabel="Delete" onConfirm={onConfirm} onCancel={onCancel} />
    );

    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel on Escape and on backdrop click", async () => {
    const onCancel = jest.fn();
    const user = userEvent.setup();
    render(
      <ConfirmDialog title="Delete this?" body="Cannot be undone." confirmLabel="Delete" onConfirm={noop} onCancel={onCancel} />
    );

    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);

    await user.click(screen.getByTestId("confirm-dialog-backdrop"));
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it("does not call onCancel when clicking inside the panel itself", async () => {
    const onCancel = jest.fn();
    const user = userEvent.setup();
    render(
      <ConfirmDialog title="Delete this?" body="Cannot be undone." confirmLabel="Delete" onConfirm={noop} onCancel={onCancel} />
    );
    await user.click(screen.getByText("Cannot be undone."));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("traps Tab focus between Cancel and the confirm button", async () => {
    const user = userEvent.setup();
    render(
      <ConfirmDialog title="Delete this?" body="Cannot be undone." confirmLabel="Delete" onConfirm={noop} onCancel={noop} />
    );
    const cancelButton = screen.getByRole("button", { name: "Cancel" });
    const confirmButton = screen.getByRole("button", { name: "Delete" });

    expect(cancelButton).toHaveFocus();
    await user.tab();
    expect(confirmButton).toHaveFocus();
    await user.tab();
    expect(cancelButton).toHaveFocus();
    await user.tab({ shift: true });
    expect(confirmButton).toHaveFocus();
  });

  it("restores focus to the previously focused element on unmount", () => {
    render(
      <div>
        <button type="button">Open</button>
      </div>
    );
    const opener = screen.getByRole("button", { name: "Open" });
    opener.focus();
    expect(opener).toHaveFocus();

    const { unmount } = render(
      <ConfirmDialog title="Delete this?" body="Cannot be undone." confirmLabel="Delete" onConfirm={noop} onCancel={noop} />
    );
    expect(opener).not.toHaveFocus();

    unmount();
    expect(opener).toHaveFocus();
  });

  it("disables both buttons and shows a busy label while isConfirming", () => {
    render(
      <ConfirmDialog
        title="Delete this?"
        body="Cannot be undone."
        confirmLabel="Delete"
        isConfirming
        onConfirm={noop}
        onCancel={noop}
      />
    );
    expect(screen.getByRole("button", { name: "Deleting…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });
});
