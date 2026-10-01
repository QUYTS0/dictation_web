"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Layout of the practice page's round-results view (plan Phase 6 §9):
 *   - entering it hides the side panel (and the page hides the large
 *     player), remembering how the panel was;
 *   - "Open script" shows the panel again without leaving the report;
 *   - leaving it restores the panel exactly as it was before the report —
 *     the report never overwrites the user's own panel choice.
 */
export function useReportViewLayout({ showPanel, setShowPanel }: { showPanel: boolean; setShowPanel: (show: boolean) => void }) {
  const [reportOpen, setReportOpen] = useState(false);
  const reportOpenRef = useRef(false);
  const showPanelRef = useRef(showPanel);
  const savedPanelRef = useRef<boolean | null>(null);
  useEffect(() => {
    showPanelRef.current = showPanel;
  }, [showPanel]);

  const openReport = useCallback(() => {
    if (reportOpenRef.current) return;
    reportOpenRef.current = true;
    savedPanelRef.current = showPanelRef.current;
    setShowPanel(false);
    setReportOpen(true);
  }, [setShowPanel]);

  const closeReport = useCallback(() => {
    if (!reportOpenRef.current) return;
    reportOpenRef.current = false;
    setReportOpen(false);
    if (savedPanelRef.current !== null) setShowPanel(savedPanelRef.current);
    savedPanelRef.current = null;
  }, [setShowPanel]);

  const openScript = useCallback(() => setShowPanel(true), [setShowPanel]);

  return { reportOpen, openReport, closeReport, openScript };
}
