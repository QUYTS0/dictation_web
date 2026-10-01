import fs from "fs";
import path from "path";
import { libraryPracticeHref } from "@/components/library/LibraryCard";
import type { LibraryItem } from "@/lib/types/learning";

function item(overrides: Partial<LibraryItem>): LibraryItem {
  return {
    videoId: "abc12345678",
    title: "Test video",
    addedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    lastMode: null,
    state: "in_progress",
    hasCompletedRound: false,
    hasLegacyCompletion: false,
    completedRoundCount: 0,
    round: null,
    listening: { transcriptId: null, coverageRatio: null, listenedThrough: false, lastPositionSec: null, hasHistory: false, historyOnOtherRevision: false },
    ...overrides,
  };
}

describe("libraryPracticeHref (Library / Continue Learning → practice page)", () => {
  it("opens the practice route without ?mode= so the saved last mode decides (cross-device resume)", () => {
    expect(libraryPracticeHref(item({ lastMode: "shadowing" }))).toBe("/dictation/abc12345678");
    expect(libraryPracticeHref(item({ state: "completed" }))).toBe("/dictation/abc12345678");
  });

  it("a Listening-only video with no saved mode opens in Listening explicitly", () => {
    expect(libraryPracticeHref(item({ state: "listening" }))).toBe("/dictation/abc12345678?mode=listening");
    expect(libraryPracticeHref(item({ state: "listening_prior_revision" }))).toBe("/dictation/abc12345678?mode=listening");
    expect(libraryPracticeHref(item({ state: "listening", lastMode: "dictation" }))).toBe("/dictation/abc12345678");
  });

  it("never produces an absolute/external URL", () => {
    for (const state of ["not_started", "in_progress", "completed", "listening", "listening_prior_revision"] as const) {
      const href = libraryPracticeHref(item({ state }));
      expect(href.startsWith("/")).toBe(true);
      expect(href).not.toMatch(/^https?:\/\//);
    }
  });
});

// Static guard: every source file that opens/resumes a practice video (start,
// resume, continue, recent videos, listening/shadowing entry points) must
// navigate with a relative internal path via next/link or the router — never
// window.open()/target="_blank" (which breaks out of an installed iOS PWA
// into Safari) or a hard-coded origin.
describe("internal navigation stays inside the app shell (no new-tab / hard-coded-origin regressions)", () => {
  const root = path.join(__dirname, "..");
  const filesToAudit = [
    "app/dashboard/page.tsx",
    "app/history/page.tsx",
    "app/bookmarks/page.tsx",
    "app/vocabulary/page.tsx",
    "app/results/[sessionId]/page.tsx",
    "app/page.tsx",
    "app/listening/[videoId]/page.tsx",
    "app/dictation/[videoId]/useInputModePreference.ts",
    "components/library/LibraryCard.tsx",
    "components/report/RoundReportPanel.tsx",
    "app/dictation/[videoId]/components/PracticeReportView.tsx",
    "components/AppHeader.tsx",
  ];

  it.each(filesToAudit)("%s has no window.open() call", (relPath) => {
    const content = fs.readFileSync(path.join(root, relPath), "utf8");
    expect(content).not.toMatch(/window\.open\(/);
  });

  it.each(filesToAudit)("%s has no target=\"_blank\" on an internal route", (relPath) => {
    const content = fs.readFileSync(path.join(root, relPath), "utf8");
    const blankTargets = [...content.matchAll(/target=["']_blank["']/g)];
    for (const match of blankTargets) {
      // Any target="_blank" found must belong to an <a> pointing at an
      // external (http/https) href, not an internal /dictation, /results,
      // /dashboard, etc. route.
      const windowStart = Math.max(0, match.index! - 200);
      const surrounding = content.slice(windowStart, match.index!);
      expect(surrounding).toMatch(/href=\{?["'`]https?:\/\//);
    }
  });

  it.each(filesToAudit)("%s does not build internal links from env-based origins", (relPath) => {
    const content = fs.readFileSync(path.join(root, relPath), "utf8");
    expect(content).not.toMatch(/NEXT_PUBLIC_APP_URL|NEXT_PUBLIC_SITE_URL/);
    expect(content).not.toMatch(/vercel\.app/);
  });

  it("dictation practice route accepts the ?mode=shadowing / ?mode=listening query params relatively", () => {
    const content = fs.readFileSync(
      path.join(root, "app/dictation/[videoId]/useInputModePreference.ts"),
      "utf8"
    );
    expect(content).toMatch(/`\/dictation\/\$\{videoId\}/);
    expect(content).not.toMatch(/https?:\/\//);
  });
});
