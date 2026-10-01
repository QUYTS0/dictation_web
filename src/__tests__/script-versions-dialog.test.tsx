/**
 * Script Versions dialog (Phase 9, component test with fetch mocked — not a
 * real browser). The classification itself is the database's (migration
 * 041, real PostgreSQL in integration/phase9-script-versions); this pins
 * down how the dialog presents it: badges, the viewer's own round, plain
 * retention reasons that never claim "deletable now", the size estimate as
 * an estimate, a read-only preview — and no delete action for anyone.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TranscriptVersion, TranscriptVersionsResponse } from "@/lib/types/learning";
import { ScriptVersionsDialog, retentionText } from "@/app/dictation/[videoId]/components/ScriptVersionsDialog";

const version = (n: number, over: Partial<TranscriptVersion> = {}): TranscriptVersion => ({
  transcriptId: `t${n}`,
  version: n,
  source: "cache",
  status: "ready",
  createdAt: "2026-08-01T00:00:00Z",
  supersededAt: null,
  isCurrent: false,
  sentenceCount: 12,
  yourRound: null,
  size: { textBytes: 900, segmentsBytes: 2000, translationsBytes: 0, highlightsBytes: 100, filesBytes: 0, totalBytes: 3000, estimatedAt: "2026-10-01T00:00:00Z" },
  retention: { reasons: [], protected: false, eligibleAt: null, inGracePeriod: false, cleanupCandidate: false },
  eligibleForRemovalBytes: 0,
  ...over,
});

const LISTING = (deletionEnabled = false): TranscriptVersionsResponse => ({
  videoId: "vid1",
  language: "en",
  deletionEnabled,
  retentionGraceDays: 30,
  revisions: [
    version(3, { isCurrent: true, retention: { reasons: ["current"], protected: true, eligibleAt: null, inGracePeriod: false, cleanupCandidate: false } }),
    version(2, {
      supersededAt: "2026-09-20T00:00:00Z",
      yourRound: { roundId: "r1", status: "completed", roundNumber: 1 },
      retention: { reasons: ["practice_round", "attempts"], protected: true, eligibleAt: null, inGracePeriod: false, cleanupCandidate: false },
    }),
    version(1, {
      supersededAt: "2026-06-01T00:00:00Z",
      retention: { reasons: [], protected: false, eligibleAt: "2026-07-01T00:00:00Z", inGracePeriod: false, cleanupCandidate: true },
      eligibleForRemovalBytes: 3000,
    }),
  ],
});

let listing: TranscriptVersionsResponse;
const fetchMock = jest.fn(async (url: string) => {
  if (url.endsWith("/versions")) return { ok: true, status: 200, json: async () => listing } as Response;
  const m = url.match(/versions\/(t\d)\/preview$/);
  if (m)
    return {
      ok: true,
      status: 200,
      json: async () => ({ transcriptId: m[1], videoId: "vid1", version: 1, status: "ready", isCurrent: false, segments: [{ segmentIndex: 0, start: 0, end: 2, text: "Old first sentence." }] }),
    } as Response;
  return { ok: false, status: 404, json: async () => ({}) } as Response;
});

function renderDialog(onClose = jest.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ScriptVersionsDialog open onClose={onClose} userId="user-1" videoId="vid1" onScreenTranscriptId="t2" />
    </QueryClientProvider>
  );
  return onClose;
}

beforeEach(() => {
  listing = LISTING();
  fetchMock.mockClear();
  global.fetch = fetchMock as unknown as typeof fetch;
});

describe("ScriptVersionsDialog", () => {
  it("lists every version with its badges, the viewer's own round and why each is kept", async () => {
    renderDialog();
    const v3 = await screen.findByTestId("script-version-3");
    expect(within(v3).getByText("Current")).toBeInTheDocument();
    expect(within(v3).getByTestId("script-version-retention")).toHaveTextContent("Kept — this is the current script.");

    const v2 = screen.getByTestId("script-version-2");
    expect(within(v2).getByText("Showing now")).toBeInTheDocument();
    expect(within(v2).getByText(/Used by your round 1 \(completed\)/)).toBeInTheDocument();
    expect(within(v2).getByTestId("script-version-retention")).toHaveTextContent(
      "Kept — a practice round uses it; saved answers or recordings use it."
    );

    const v1 = screen.getByTestId("script-version-1");
    expect(within(v1).getByTestId("script-version-retention")).toHaveTextContent(/Eligible for cleanup since .* — cleanup is not enabled\./);
    expect(within(v1).getByText(/Estimated storage: 2.9 KB/)).toBeInTheDocument();
    expect(within(v1).getByText(/not disk usage, and not what removing it would free/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/transcripts/vid1/versions");
  });

  it("offers no delete action to anyone — even if a response ever claimed deletion were enabled", async () => {
    for (const enabled of [false, true]) {
      listing = LISTING(enabled);
      const { unmount } = (() => {
        const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        return render(
          <QueryClientProvider client={qc}>
            <ScriptVersionsDialog open onClose={jest.fn()} userId="admin-1" videoId="vid1" onScreenTranscriptId={null} />
          </QueryClientProvider>
        );
      })();
      await screen.findByTestId("script-version-1");
      const dialog = screen.getByRole("dialog", { name: "Script versions" });
      expect(within(dialog).queryByRole("button", { name: /delete|remove|clean ?up/i })).toBeNull();
      unmount();
    }
  });

  it("Preview is a read-only fetch of that version's sentences; it can be hidden again", async () => {
    renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: "Preview version 1" }));
    expect(await screen.findByText("Old first sentence.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/transcripts/vid1/versions/t1/preview");
    for (const [, init] of fetchMock.mock.calls as unknown as Array<[string, RequestInit | undefined]>) expect(init?.method ?? "GET").toBe("GET");
    fireEvent.click(screen.getByRole("button", { name: "Hide preview" }));
    await waitFor(() => expect(screen.queryByText("Old first sentence.")).toBeNull());
  });

  it("closes with the close button and with Escape", async () => {
    const onClose = renderDialog();
    await screen.findByTestId("script-version-3");
    fireEvent.click(screen.getByRole("button", { name: "Close script versions" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("a failed load says so and can be retried", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) } as Response);
    renderDialog();
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load script versions.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByTestId("script-version-3")).toBeInTheDocument();
  });
});

describe("retentionText", () => {
  it("grace period shows the date it ends; never says deletable", () => {
    const text = retentionText({ reasons: [], protected: false, eligibleAt: "2026-11-01T00:00:00Z", inGracePeriod: true, cleanupCandidate: false });
    expect(text).toMatch(/^Kept until .* \(recently replaced\)\.$/);
    expect(retentionText({ reasons: ["saved_words"], protected: true, eligibleAt: null, inGracePeriod: false, cleanupCandidate: false })).toBe(
      "Kept — saved words or bookmarks exist for this video."
    );
  });
});
