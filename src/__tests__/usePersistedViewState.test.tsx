import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

let mockSearchParams = new URLSearchParams();
const mockReplace = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace }),
  useSearchParams: () => mockSearchParams,
}));

import { usePersistedViewState } from "@/hooks/usePersistedViewState";

type Filters = { q: string; type: string };
const DEFAULTS: Filters = { q: "", type: "all" };

function Harness({ userId, namespace = "test-viewstate" }: { userId: string | undefined; namespace?: string }) {
  const [state, update, hydrated] = usePersistedViewState(namespace, userId, DEFAULTS);
  return (
    <div>
      <span data-testid="hydrated">{String(hydrated)}</span>
      <span data-testid="q">{state.q}</span>
      <span data-testid="type">{state.type}</span>
      <button onClick={() => update({ q: "hello" })}>set-q</button>
      <button onClick={() => update({ type: "word" })}>set-type</button>
    </div>
  );
}

describe("usePersistedViewState", () => {
  beforeEach(() => {
    mockSearchParams = new URLSearchParams();
    mockReplace.mockClear();
    window.sessionStorage.clear();
  });

  it("resolves to hydrated=true once mount-time resolution has run", async () => {
    // Note: React Testing Library's render() flushes effects synchronously
    // inside act(), unlike a real browser (which paints the pre-hydration
    // state for a frame first — see the Vocabulary/Bookmarks/History pages'
    // use of this flag to gate scroll restoration against exactly that
    // frame). This test only asserts the eventually-resolved value, not the
    // interim timing, which isn't reliably observable through RTL.
    render(<Harness userId="user-1" />);
    await waitFor(() => expect(screen.getByTestId("hydrated").textContent).toBe("true"));
  });

  it("becomes hydrated even without a signed-in user, without restoring anything", async () => {
    render(<Harness userId={undefined} />);
    await waitFor(() => expect(screen.getByTestId("hydrated").textContent).toBe("true"));
    expect(screen.getByTestId("q").textContent).toBe("");
  });

  it("prefers an explicit URL param over a stored value (and ignores the rest of the stored set)", async () => {
    window.sessionStorage.setItem("test-viewstate:user-1", JSON.stringify({ q: "stored", type: "word" }));
    mockSearchParams = new URLSearchParams("q=fromurl");

    render(<Harness userId="user-1" />);
    // Resolved synchronously on first render — URL reads don't need an effect.
    expect(screen.getByTestId("q").textContent).toBe("fromurl");
    expect(screen.getByTestId("type").textContent).toBe("all");

    await waitFor(() => expect(screen.getByTestId("hydrated").textContent).toBe("true"));
    // Still URL-derived after hydration settles — a partial URL never blends
    // in the unrelated stored "type".
    expect(screen.getByTestId("q").textContent).toBe("fromurl");
    expect(screen.getByTestId("type").textContent).toBe("all");
  });

  it("restores from sessionStorage when the URL carries none of these params, and mirrors it into the URL", async () => {
    window.sessionStorage.setItem("test-viewstate:user-1", JSON.stringify({ q: "stored", type: "word" }));

    render(<Harness userId="user-1" />);

    await waitFor(() => expect(screen.getByTestId("q").textContent).toBe("stored"));
    expect(screen.getByTestId("type").textContent).toBe("word");
    expect(mockReplace).toHaveBeenCalledWith(expect.stringContaining("q=stored"), { scroll: false });
    expect(mockReplace).toHaveBeenCalledWith(expect.stringContaining("type=word"), { scroll: false });
  });

  it("update() writes to sessionStorage and the URL, omitting values that equal their default", async () => {
    render(<Harness userId="user-1" />);
    await waitFor(() => expect(screen.getByTestId("hydrated").textContent).toBe("true"));
    mockReplace.mockClear();

    await userEvent.click(screen.getByText("set-q"));

    expect(screen.getByTestId("q").textContent).toBe("hello");
    expect(JSON.parse(window.sessionStorage.getItem("test-viewstate:user-1") ?? "{}")).toEqual({
      q: "hello",
      type: "all",
    });
    const [href] = mockReplace.mock.calls[mockReplace.mock.calls.length - 1];
    expect(href).toContain("q=hello");
    expect(href).not.toContain("type="); // "all" is the default — omitted, not written as "type=all"
  });

  it("scopes storage per user — one account's stored state never appears for another", async () => {
    window.sessionStorage.setItem("test-viewstate:user-1", JSON.stringify({ q: "user-1-search", type: "word" }));

    render(<Harness userId="user-2" />);
    await waitFor(() => expect(screen.getByTestId("hydrated").textContent).toBe("true"));

    expect(screen.getByTestId("q").textContent).toBe("");
    expect(screen.getByTestId("type").textContent).toBe("all");
  });
});
