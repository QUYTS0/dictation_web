"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { practiceFlushCoordinator } from "@/lib/practiceFlushCoordinator";

/**
 * Root-level observer (plan §11.6): rendered once in Providers, so a route
 * change never unmounts it. Every pathname change (links, Back/Forward) and
 * every tab hide asks the flush coordinator to send what practice pages
 * buffered; the coordinator invalidates the Dashboard only after that write
 * succeeded. A no-op when nothing is buffered or in flight.
 */
export function NavigationFlushObserver() {
  const pathname = usePathname();
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    void practiceFlushCoordinator.requestFlush("navigation");
  }, [pathname]);

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") void practiceFlushCoordinator.requestFlush("visibility");
    };
    const onPageHide = () => void practiceFlushCoordinator.requestFlush("visibility");
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, []);

  return null;
}
