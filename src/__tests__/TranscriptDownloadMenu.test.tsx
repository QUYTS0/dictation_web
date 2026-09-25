/**
 * Behavior tests for the transcript download format menu. `downloadBlob`
 * and the dynamically-imported PDF generator are mocked so these assert
 * observable menu behavior (which formats are offered, busy/error states,
 * duplicate-export prevention, keyboard/focus handling) without touching
 * real Blob/URL/anchor-click browser plumbing or pdf-lib.
 *
 * Note: this component takes no player/session props at all — it only
 * reads the segments/title/videoId/version already passed to it, so there
 * is nothing in its implementation that could seek, play, pause, restart,
 * or reset the lesson (unlike a hook-level test, there is no player/session
 * store to assert against here because none is wired in — a structural,
 * not just behavioral, guarantee).
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TranscriptDownloadMenu } from "@/app/dictation/[videoId]/components/TranscriptDownloadMenu";
import type { ExportableSegment } from "@/lib/utils/transcriptExport";

jest.mock("@/lib/utils/download", () => ({ downloadBlob: jest.fn() }));
jest.mock("@/lib/utils/transcriptPdf", () => ({ generateTranscriptPdf: jest.fn() }));

import { downloadBlob } from "@/lib/utils/download";
import { generateTranscriptPdf } from "@/lib/utils/transcriptPdf";

const downloadBlobMock = downloadBlob as jest.Mock;
const generatePdfMock = generateTranscriptPdf as jest.Mock;

function seg(i: number, start: number, end: number, text: string): ExportableSegment {
  return { segmentIndex: i, start, end, text };
}

const goodSegments: ExportableSegment[] = [seg(0, 0, 2, "Hello there."), seg(1, 2, 4, "How are you?")];

beforeEach(() => {
  jest.clearAllMocks();
  generatePdfMock.mockResolvedValue(new Uint8Array([1, 2, 3]));
});

describe("TranscriptDownloadMenu", () => {
  it("1. offers TXT, SRT, and PDF as format options", async () => {
    const user = userEvent.setup();
    render(<TranscriptDownloadMenu segments={goodSegments} videoId="vid1" title="My Video" version={2} />);

    await user.click(screen.getByRole("button", { name: /download transcript/i }));

    expect(screen.getByRole("menu", { name: /download transcript as/i })).toBeInTheDocument();
    const items = screen.getAllByRole("menuitem");
    expect(items).toHaveLength(3);
    expect(screen.getByRole("menuitem", { name: /text/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /subtitles/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /document/i })).toBeInTheDocument();
  });

  it("2. selecting Text downloads a .txt file with the correct MIME type and filename", async () => {
    const user = userEvent.setup();
    render(<TranscriptDownloadMenu segments={goodSegments} videoId="vid1" title="My Video" version={2} />);
    await user.click(screen.getByRole("button", { name: /download transcript/i }));
    await user.click(screen.getByRole("menuitem", { name: /text/i }));

    await waitFor(() => expect(downloadBlobMock).toHaveBeenCalledTimes(1));
    const [content, mime, filename] = downloadBlobMock.mock.calls[0];
    expect(content).toBe("Hello there.\nHow are you?");
    expect(mime).toContain("text/plain");
    expect(filename).toBe("My Video-v2.txt");
  });

  it("3/4. selecting Subtitles downloads a correctly formatted .srt file", async () => {
    const user = userEvent.setup();
    render(<TranscriptDownloadMenu segments={goodSegments} videoId="vid1" title="My Video" version={null} />);
    await user.click(screen.getByRole("button", { name: /download transcript/i }));
    await user.click(screen.getByRole("menuitem", { name: /subtitles/i }));

    await waitFor(() => expect(downloadBlobMock).toHaveBeenCalledTimes(1));
    const [content, mime, filename] = downloadBlobMock.mock.calls[0];
    expect(content).toBe("1\n00:00:00,000 --> 00:00:02,000\nHello there.\n\n2\n00:00:02,000 --> 00:00:04,000\nHow are you?\n");
    expect(mime).toContain("subrip");
    expect(filename).toBe("My Video.srt");
  });

  it("shows a clear, SRT-specific error (and never downloads) when timing is unusable — TXT/PDF remain unaffected", async () => {
    const badSegments: ExportableSegment[] = [seg(0, 0, 0, "No duration.")];
    const user = userEvent.setup();
    render(<TranscriptDownloadMenu segments={badSegments} videoId="vid1" title="My Video" version={1} />);
    await user.click(screen.getByRole("button", { name: /download transcript/i }));
    await user.click(screen.getByRole("menuitem", { name: /subtitles/i }));

    expect(await screen.findByText(/invalid sentence timing/i)).toBeInTheDocument();
    expect(downloadBlobMock).not.toHaveBeenCalled();
    // The menu stays open with TXT/PDF still selectable — a click retries.
    expect(screen.getByRole("menuitem", { name: /text/i })).not.toBeDisabled();
    expect(screen.getByRole("menuitem", { name: /document/i })).not.toBeDisabled();
  });

  it("10. a PDF export shows a busy state, prevents a duplicate click while running, and clears on success", async () => {
    let resolvePdf!: (v: Uint8Array) => void;
    generatePdfMock.mockReturnValue(
      new Promise((resolve) => {
        resolvePdf = resolve;
      })
    );
    const user = userEvent.setup();
    render(<TranscriptDownloadMenu segments={goodSegments} videoId="vid1" title="My Video" version={1} />);
    await user.click(screen.getByRole("button", { name: /download transcript/i }));

    const pdfItem = screen.getByRole("menuitem", { name: /document/i });
    await user.click(pdfItem);
    // Busy: the item is now disabled (all items disabled while any export
    // is preparing) — a second activation attempt must not start another.
    await waitFor(() => expect(pdfItem).toBeDisabled());
    await user.click(pdfItem);
    expect(generatePdfMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolvePdf(new Uint8Array([1, 2, 3]));
      await Promise.resolve();
    });
    await waitFor(() => expect(downloadBlobMock).toHaveBeenCalledTimes(1));
    expect(downloadBlobMock.mock.calls[0][1]).toBe("application/pdf");
  });

  it("10. a failed PDF export clears the busy state and shows a retryable error", async () => {
    generatePdfMock.mockRejectedValue(new Error("Could not load PDF fonts."));
    const user = userEvent.setup();
    render(<TranscriptDownloadMenu segments={goodSegments} videoId="vid1" title="My Video" version={1} />);
    await user.click(screen.getByRole("button", { name: /download transcript/i }));
    await user.click(screen.getByRole("menuitem", { name: /document/i }));

    expect(await screen.findByText(/could not load pdf fonts/i)).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /document/i })).not.toBeDisabled();
    expect(downloadBlobMock).not.toHaveBeenCalled();
  });

  it("disables the trigger entirely when there is no usable transcript", () => {
    render(<TranscriptDownloadMenu segments={[]} videoId="vid1" title="My Video" version={1} />);
    expect(screen.getByRole("button", { name: /download transcript/i })).toBeDisabled();
  });

  it("Escape closes the menu and restores focus to the trigger button", async () => {
    const user = userEvent.setup();
    render(<TranscriptDownloadMenu segments={goodSegments} videoId="vid1" title="My Video" version={1} />);
    const trigger = screen.getByRole("button", { name: /download transcript/i });
    await user.click(trigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("6/7. exports exactly the full segment list passed in — never re-fetches, so a session pinned to A can never silently pick up a newer current revision B", async () => {
    // A large, arbitrarily-ordered segment set standing in for "every
    // segment of the pinned revision, including any a virtualized script
    // view wouldn't currently render" — the component has no windowing of
    // its own, so whatever is passed in is exactly what gets exported.
    const fullRevisionA: ExportableSegment[] = Array.from({ length: 50 }, (_, i) => seg(i, i, i + 1, `A sentence ${i}`));
    const fetchSpy = jest.fn(() => {
      throw new Error("must not fetch — export must use only the segments already provided");
    });
    const originalFetch = global.fetch;
    global.fetch = fetchSpy as unknown as typeof fetch;
    const user = userEvent.setup();
    render(<TranscriptDownloadMenu segments={fullRevisionA} videoId="vid1" title="Video" version={1} />);
    await user.click(screen.getByRole("button", { name: /download transcript/i }));
    await user.click(screen.getByRole("menuitem", { name: /text/i }));

    await waitFor(() => expect(downloadBlobMock).toHaveBeenCalledTimes(1));
    const [content] = downloadBlobMock.mock.calls[0];
    expect((content as string).split("\n")).toHaveLength(50);
    expect(content).toContain("A sentence 0");
    expect(content).toContain("A sentence 49");
    expect(fetchSpy).not.toHaveBeenCalled();
    global.fetch = originalFetch;
  });

  it("ArrowDown moves focus to the next menu item", async () => {
    const user = userEvent.setup();
    render(<TranscriptDownloadMenu segments={goodSegments} videoId="vid1" title="My Video" version={1} />);
    await user.click(screen.getByRole("button", { name: /download transcript/i }));
    const items = screen.getAllByRole("menuitem");
    expect(items[0]).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(items[1]).toHaveFocus();
  });
});
