import manifest from "@/app/manifest";

describe("web app manifest", () => {
  const m = manifest();

  it("launches into the dashboard", () => {
    expect(m.start_url).toBe("/dashboard");
  });

  it("scopes to the whole app so every internal route stays in the PWA window", () => {
    expect(m.scope).toBe("/");
  });

  it("runs in standalone display mode (no browser chrome)", () => {
    expect(m.display).toBe("standalone");
  });

  it("has a stable app id", () => {
    expect(m.id).toBe("/");
  });

  it("keeps start_url inside scope", () => {
    expect(m.start_url?.startsWith(m.scope as string)).toBe(true);
  });

  it("declares at least one icon", () => {
    expect(m.icons?.length).toBeGreaterThan(0);
  });
});
