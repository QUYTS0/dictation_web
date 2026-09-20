import { act, render } from "@testing-library/react";
import { useScrollRestoration } from "@/hooks/useScrollRestoration";

function Harness({
  pathname,
  userId,
  ready,
}: {
  pathname: string;
  userId: string | undefined;
  ready: boolean;
}) {
  useScrollRestoration(pathname, userId, ready);
  return null;
}

function setDocumentHeight(scrollHeight: number, innerHeight: number) {
  Object.defineProperty(document.documentElement, "scrollHeight", { value: scrollHeight, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: innerHeight, configurable: true });
}

describe("useScrollRestoration", () => {
  let scrollToSpy: jest.SpyInstance;

  beforeEach(() => {
    window.sessionStorage.clear();
    scrollToSpy = jest.spyOn(window, "scrollTo").mockImplementation(() => {});
    setDocumentHeight(2000, 800);
  });

  afterEach(() => {
    scrollToSpy.mockRestore();
  });

  it("does not restore while ready is false, even with a stored position", () => {
    window.sessionStorage.setItem("scroll:/vocabulary:user-1", "500");
    render(<Harness pathname="/vocabulary" userId="user-1" ready={false} />);
    expect(scrollToSpy).not.toHaveBeenCalled();
  });

  it("restores the stored position once ready becomes true", () => {
    window.sessionStorage.setItem("scroll:/vocabulary:user-1", "500");
    const { rerender } = render(<Harness pathname="/vocabulary" userId="user-1" ready={false} />);
    expect(scrollToSpy).not.toHaveBeenCalled();

    rerender(<Harness pathname="/vocabulary" userId="user-1" ready={true} />);
    expect(scrollToSpy).toHaveBeenCalledWith({ top: 500, behavior: "auto" });
  });

  it("clamps the restored position against the current document height", () => {
    // maxScroll = scrollHeight(2000) - innerHeight(800) = 1200
    window.sessionStorage.setItem("scroll:/vocabulary:user-1", "5000");
    render(<Harness pathname="/vocabulary" userId="user-1" ready={true} />);
    expect(scrollToSpy).toHaveBeenCalledWith({ top: 1200, behavior: "auto" });
  });

  it("does nothing when there is no stored position", () => {
    render(<Harness pathname="/vocabulary" userId="user-1" ready={true} />);
    expect(scrollToSpy).not.toHaveBeenCalled();
  });

  it("restores at most once per navigation, even if ready toggles again", () => {
    window.sessionStorage.setItem("scroll:/vocabulary:user-1", "500");
    const { rerender } = render(<Harness pathname="/vocabulary" userId="user-1" ready={true} />);
    expect(scrollToSpy).toHaveBeenCalledTimes(1);

    rerender(<Harness pathname="/vocabulary" userId="user-1" ready={false} />);
    rerender(<Harness pathname="/vocabulary" userId="user-1" ready={true} />);
    expect(scrollToSpy).toHaveBeenCalledTimes(1);
  });

  it("scopes restoration per pathname — navigating to a different page restores independently", () => {
    window.sessionStorage.setItem("scroll:/vocabulary:user-1", "500");
    window.sessionStorage.setItem("scroll:/bookmarks:user-1", "300");
    const { rerender } = render(<Harness pathname="/vocabulary" userId="user-1" ready={true} />);
    expect(scrollToSpy).toHaveBeenLastCalledWith({ top: 500, behavior: "auto" });

    rerender(<Harness pathname="/bookmarks" userId="user-1" ready={true} />);
    expect(scrollToSpy).toHaveBeenLastCalledWith({ top: 300, behavior: "auto" });
  });

  it("scopes restoration per user — a different signed-in user restores independently", () => {
    window.sessionStorage.setItem("scroll:/vocabulary:user-1", "500");
    window.sessionStorage.setItem("scroll:/vocabulary:user-2", "50");
    const { rerender } = render(<Harness pathname="/vocabulary" userId="user-1" ready={true} />);
    expect(scrollToSpy).toHaveBeenLastCalledWith({ top: 500, behavior: "auto" });

    rerender(<Harness pathname="/vocabulary" userId="user-2" ready={true} />);
    expect(scrollToSpy).toHaveBeenLastCalledWith({ top: 50, behavior: "auto" });
  });

  it("records scroll position (throttled) to sessionStorage, scoped by pathname and user", () => {
    jest.useFakeTimers();
    render(<Harness pathname="/vocabulary" userId="user-1" ready={true} />);

    Object.defineProperty(window, "scrollY", { value: 777, configurable: true });
    act(() => {
      window.dispatchEvent(new Event("scroll"));
      jest.advanceTimersByTime(200);
    });

    expect(window.sessionStorage.getItem("scroll:/vocabulary:user-1")).toBe("777");
    jest.useRealTimers();
  });
});
