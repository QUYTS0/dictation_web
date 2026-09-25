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
    for (const active of ["dashboard", "vocabulary", "bookmarks", "history"] as const) {
      const { unmount } = render(<AppHeader active={active} />);
      expect(widthContainer().className).toContain(PAGE_WIDTH_CLASS.wide);
      unmount();
    }
  });

  it("never falls back to a narrower literal (e.g. the old max-w-6xl) for any tab", () => {
    render(<AppHeader active="history" />);
    expect(widthContainer().className).not.toContain("max-w-6xl");
    expect(widthContainer().className).not.toContain("max-w-4xl");
  });
});
