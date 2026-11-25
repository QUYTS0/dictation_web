/**
 * Phase 1 of the dashboard redesign (.claude/dashboard-redesign-plan.md):
 * the shared app shell — header "New video" dialog + streak pill, the one
 * AddVideoForm, the footer, toasts, and ConfettiBurst's reduced-motion rule.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { User } from "@supabase/supabase-js";

let authUser: User | null = { id: "user-1", email: "learner@example.test" } as User;
jest.mock("@/context/auth", () => ({
  useAuth: () => ({ user: authUser, loading: false, openAuthModal: jest.fn() }),
}));
const push = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: jest.fn() }),
}));
jest.mock("next/link", () => {
  return function MockLink({ href, children, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; children: React.ReactNode }) {
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  };
});
jest.mock("@/components/UserButton", () => function MockUserButton() {
  return <div data-testid="user-button" />;
});

import AppHeader from "@/components/AppHeader";
import AppFooter from "@/components/AppFooter";
import { ToastProvider, useToast } from "@/components/ToastProvider";
import { ConfettiBurst } from "@/components/ConfettiBurst";

let streakDays = 12;
let xpResponse: { status: number; body: unknown } = { status: 200, body: {} };
let resolveResponse: { status: number; body: unknown } = { status: 200, body: { status: "ok", videoId: "dQw4w9WgXcQ" } };
const calls: string[] = [];

beforeEach(() => {
  authUser = { id: "user-1", email: "learner@example.test" } as User;
  streakDays = 12;
  xpResponse = {
    status: 200,
    body: { totalXp: 4850, level: 10, levelStartXp: 4500, nextLevelXp: 5500, todayXp: 0, days: [], lastLeagueWeek: { weekStart: "2026-11-16", xp: 0, activeSec: 0, wordsReviewed: 0 } },
  };
  resolveResponse = { status: 200, body: { status: "ok", videoId: "dQw4w9WgXcQ" } };
  calls.length = 0;
  push.mockReset();
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    const json = (status: number, body: unknown) =>
      ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;
    if (url.startsWith("/api/streak")) {
      return json(200, { streakDays, streakTimeZone: "UTC", streakToday: "2026-11-25", streakIncludesUtcFallback: false });
    }
    if (url.startsWith("/api/xp")) return json(xpResponse.status, xpResponse.body);
    if (url.startsWith("/api/video/resolve")) return json(resolveResponse.status, resolveResponse.body);
    return json(404, {});
  }) as jest.Mock;
});

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const renderWithClient = (ui: React.ReactElement) => render(<QueryClientProvider client={newClient()}>{ui}</QueryClientProvider>);

describe("AppHeader (signed in)", () => {
  it("shows New video and the streak pill; the pill explains the streak and Escape closes it", async () => {
    renderWithClient(<AppHeader active="dashboard" />);
    const pill = await screen.findByTestId("header-streak");
    expect(pill).toHaveTextContent("12 days");
    expect(screen.getByRole("button", { name: "New video" })).toBeInTheDocument();

    fireEvent.click(pill);
    expect(pill).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("12-day streak")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(pill).toHaveAttribute("aria-expanded", "false");
  });

  it("a zero streak still shows, with a start-a-streak hint", async () => {
    streakDays = 0;
    renderWithClient(<AppHeader active="dashboard" />);
    const pill = await screen.findByTestId("header-streak");
    expect(pill).toHaveTextContent("0 days");
    fireEvent.click(pill);
    expect(screen.getByText("Practice in any mode today to start a streak.")).toBeInTheDocument();
  });

  it("guests get neither New video nor a streak or XP pill, and no streak or XP request", () => {
    authUser = null;
    renderWithClient(<AppHeader active="dashboard" />);
    expect(screen.queryByRole("button", { name: "New video" })).toBeNull();
    expect(screen.queryByTestId("header-streak")).toBeNull();
    expect(screen.queryByTestId("header-xp")).toBeNull();
    expect(calls.some((c) => c.includes("/api/streak") || c.includes("/api/xp"))).toBe(false);
  });

  it("Phase 5: the XP pill reads '4,850 XP · Lvl 10', from lg up only", async () => {
    renderWithClient(<AppHeader active="dashboard" />);
    const pill = await screen.findByTestId("header-xp");
    expect(pill).toHaveAccessibleName("4,850 XP, level 10");
    expect(pill).toHaveTextContent("4,850 XP · Lvl 10");
    expect(pill).toHaveClass("hidden", "lg:flex");
  });

  it("Phase 5: XP unavailable (048 not applied) → no XP pill, the rest of the header unchanged", async () => {
    xpResponse = { status: 503, body: { code: "learning_data_unavailable" } };
    renderWithClient(<AppHeader active="dashboard" />);
    await screen.findByTestId("header-streak");
    await waitFor(() => expect(calls.some((c) => c.includes("/api/xp"))).toBe(true));
    await act(async () => {});
    expect(screen.queryByTestId("header-xp")).toBeNull();
  });
});

describe("New video dialog", () => {
  it("opens focused on the link field; Escape closes it, returns focus, and keeps the typed link", async () => {
    const user = userEvent.setup();
    renderWithClient(<AppHeader active="dashboard" />);
    const trigger = screen.getByRole("button", { name: "New video" });
    await user.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "New video" });
    const input = within(dialog).getByRole("textbox", { name: "YouTube URL" });
    expect(document.activeElement).toBe(input);
    await user.type(input, "https://youtu.be/abc");

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);

    await user.click(trigger);
    expect(screen.getByRole("textbox", { name: "YouTube URL" })).toHaveValue("https://youtu.be/abc");
  });

  it("submitting a valid link resolves it and opens the practice page without a mode", async () => {
    const user = userEvent.setup();
    renderWithClient(<AppHeader active="dashboard" />);
    await user.click(screen.getByRole("button", { name: "New video" }));
    await user.type(screen.getByRole("textbox", { name: "YouTube URL" }), "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    await user.click(screen.getByRole("button", { name: "Add video" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/dictation/dQw4w9WgXcQ"));
    expect(calls).toContain("POST /api/video/resolve");
  });

  it("closes on a backdrop click but not on a click inside the panel", async () => {
    const user = userEvent.setup();
    renderWithClient(<AppHeader active="dashboard" />);
    await user.click(screen.getByRole("button", { name: "New video" }));
    await user.click(screen.getByRole("dialog"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.click(screen.getByTestId("add-video-dialog-backdrop"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("AddVideoForm validation (shared by the dialog and the Dashboard)", () => {
  const openForm = async () => {
    const user = userEvent.setup();
    renderWithClient(<AppHeader active="dashboard" />);
    await user.click(screen.getByRole("button", { name: "New video" }));
    return user;
  };

  it("an empty link asks for one, without calling the server", async () => {
    const user = await openForm();
    await user.click(screen.getByRole("button", { name: "Add video" }));
    expect(screen.getByText(/Please paste a YouTube URL\./)).toBeInTheDocument();
    expect(calls.some((c) => c.includes("/api/video/resolve"))).toBe(false);
  });

  it("a non-YouTube link is rejected and marked invalid; typing again clears the error", async () => {
    const user = await openForm();
    const input = screen.getByRole("textbox", { name: "YouTube URL" });
    await user.type(input, "https://example.com/video");
    await user.click(screen.getByRole("button", { name: "Add video" }));
    expect(screen.getByText(/doesn't look like a valid YouTube URL/)).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-invalid", "true");
    await user.type(input, "x");
    expect(screen.queryByText(/doesn't look like a valid YouTube URL/)).toBeNull();
  });

  it("shows the server's own message when the video can't be added", async () => {
    resolveResponse = { status: 422, body: { status: "error", message: "This video has no captions." } };
    const user = await openForm();
    await user.type(screen.getByRole("textbox", { name: "YouTube URL" }), "https://youtu.be/dQw4w9WgXcQ");
    await user.click(screen.getByRole("button", { name: "Add video" }));
    expect(await screen.findByText(/This video has no captions\./)).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });
});

describe("AppFooter", () => {
  it("shows the product line and, when signed in, the same streak as the header", async () => {
    renderWithClient(<AppFooter />);
    expect(screen.getByRole("contentinfo")).toHaveTextContent("English listening, dictation & shadowing studio");
    expect(await screen.findByTestId("footer-streak")).toHaveTextContent("Streak: 12 days");
  });

  it("guests see no streak", () => {
    authUser = null;
    renderWithClient(<AppFooter />);
    expect(screen.queryByTestId("footer-streak")).toBeNull();
  });
});

describe("ToastProvider", () => {
  function Trigger({ message }: { message: string }) {
    const toast = useToast();
    return <button onClick={() => toast({ message, sub: "detail" })}>show {message}</button>;
  }

  it("shows a toast in a polite live region, auto-dismisses it, and keeps at most three", () => {
    jest.useFakeTimers();
    try {
      render(
        <ToastProvider>
          {["a", "b", "c", "d"].map((m) => (
            <Trigger key={m} message={m} />
          ))}
        </ToastProvider>
      );
      expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
      for (const m of ["a", "b", "c", "d"]) fireEvent.click(screen.getByText(`show ${m}`));
      expect(screen.getAllByTestId("toast").map((t) => t.textContent?.charAt(0))).toEqual(["b", "c", "d"]);
      act(() => {
        jest.advanceTimersByTime(3300);
      });
      expect(screen.queryAllByTestId("toast")).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it("a toast can be dismissed by hand", () => {
    render(
      <ToastProvider>
        <Trigger message="hello" />
      </ToastProvider>
    );
    fireEvent.click(screen.getByText("show hello"));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    expect(screen.queryByTestId("toast")).toBeNull();
  });

  it("useToast outside the provider is a harmless no-op", () => {
    render(<Trigger message="lonely" />);
    expect(() => fireEvent.click(screen.getByText("show lonely"))).not.toThrow();
  });
});

describe("ConfettiBurst", () => {
  const setReducedMotion = (reduce: boolean) => {
    window.matchMedia = jest.fn().mockImplementation((query: string) => ({
      matches: reduce && query.includes("reduce"),
      media: query,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    })) as unknown as typeof window.matchMedia;
  };

  it("renders pieces normally", () => {
    setReducedMotion(false);
    const { container } = render(<ConfettiBurst />);
    expect(container.querySelectorAll("span").length).toBeGreaterThan(0);
  });

  it("renders nothing for viewers who ask for reduced motion", () => {
    setReducedMotion(true);
    const { container } = render(<ConfettiBurst />);
    expect(container.querySelectorAll("span")).toHaveLength(0);
  });
});
