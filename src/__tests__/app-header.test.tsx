import { render, screen } from "@testing-library/react";
import { PAGE_WIDTH_CLASS } from "@/lib/layout/pageWidth";

jest.mock("next/link", () => {
  return function MockLink({
    href,
    children,
    ...rest
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; children: React.ReactNode }) {
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  };
});

jest.mock("@/components/UserButton", () => {
  return function MockUserButton() {
    return <div data-testid="user-button" />;
  };
});

import AppHeader from "@/components/AppHeader";

function widthContainer() {
  // The header's inner content row is the first child of the <header>
  // landmark — the element carrying the shared width primitive.
  return screen.getByRole("banner").firstElementChild as HTMLElement;
}

describe("AppHeader width stability", () => {
  it("uses the shared wide width primitive regardless of the active tab", () => {
    for (const active of ["dashboard", "library", "vocabulary", "bookmarks", "history"] as const) {
      const { unmount } = render(<AppHeader active={active} />);
      expect(widthContainer().className).toContain(PAGE_WIDTH_CLASS.wide);
      unmount();
    }
  });

  it("navigation: Dashboard | My Learning | Vocabulary | Bookmarks | History; only the active one is marked current", () => {
    const { unmount } = render(<AppHeader active="library" />);
    const nav = screen.getByRole("navigation");
    const links = Array.from(nav.querySelectorAll("a"));
    expect(links.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Dashboard", "/dashboard"],
      ["My Learning", "/library"],
      ["Vocabulary", "/vocabulary"],
      ["Bookmarks", "/bookmarks"],
      ["History", "/history"],
    ]);
    expect(links.filter((a) => a.getAttribute("aria-current") === "page").map((a) => a.textContent)).toEqual(["My Learning"]);
    unmount();
    render(<AppHeader active="dashboard" />);
    expect(screen.getByRole("link", { name: "Dashboard" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "My Learning" })).not.toHaveAttribute("aria-current");
  });

  it("never falls back to a narrower literal (e.g. the old max-w-6xl) for any tab", () => {
    render(<AppHeader active="history" />);
    expect(widthContainer().className).not.toContain("max-w-6xl");
    expect(widthContainer().className).not.toContain("max-w-4xl");
  });
});
