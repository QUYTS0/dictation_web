import fs from "fs";
import path from "path";
import { resumableSessionHref } from "@/lib/utils/sessions";
import type { ResumableSession } from "@/lib/types";

function baseSession(overrides: Partial<ResumableSession>): ResumableSession {
  return {
    sessionId: "sess-1",
    mode: "dictation",
    videoId: "abc12345678",
    videoTitle: "Test video",
    updatedAt: new Date().toISOString(),
    status: "active",
    ...overrides,
  };
}

describe("resumableSessionHref (dashboard/history resume + listening→shadowing entry)", () => {
  it("resumes an in-progress dictation session on the practice route", () => {
    expect(resumableSessionHref(baseSession({ mode: "dictation", status: "active" }))).toBe(
      "/dictation/abc12345678"
    );
  });

  it("sends a completed dictation session to its results page", () => {
    expect(
      resumableSessionHref(baseSession({ mode: "dictation", status: "completed", sessionId: "sess-42" }))
    ).toBe("/results/sess-42");
  });

  it("resumes a listening session on the practice route with ?mode=listening", () => {
    expect(resumableSessionHref(baseSession({ mode: "listening", status: "active" }))).toBe(
      "/dictation/abc12345678?mode=listening"
    );
  });

  it("keeps a completed listening session on the practice route (no results page for listening)", () => {
    expect(resumableSessionHref(baseSession({ mode: "listening", status: "completed" }))).toBe(
      "/dictation/abc12345678?mode=listening"
    );
  });

  it("never produces an absolute/external URL", () => {
    for (const mode of ["dictation", "listening"] as const) {
      for (const status of ["active", "completed", "abandoned"] as const) {
        const href = resumableSessionHref(baseSession({ mode, status }));
        expect(href.startsWith("/")).toBe(true);
        expect(href).not.toMatch(/^https?:\/\//);
      }
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
    "lib/utils/sessions.ts",
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
