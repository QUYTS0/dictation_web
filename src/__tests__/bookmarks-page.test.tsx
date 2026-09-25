import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("@/context/auth", () => ({
  useAuth: () => ({ user: null, loading: false, openAuthModal: jest.fn() }),
}));

jest.mock("next/navigation", () => ({
  usePathname: () => "/bookmarks",
  useRouter: () => ({ replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

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

import { PAGE_WIDTH_CLASS } from "@/lib/layout/pageWidth";
import BookmarksPage from "@/app/bookmarks/page";

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <BookmarksPage />
    </QueryClientProvider>
  );
}

describe("Bookmarks page width", () => {
  it("uses the shared wide width primitive for its <main> content", async () => {
    renderPage();
    const main = await screen.findByRole("main");
    expect(main.className).toContain(PAGE_WIDTH_CLASS.wide);
  });
});
