import { PAGE_PADDING_CLASS, PAGE_WIDTH_CLASS, type PageWidthMode } from "@/lib/layout/pageWidth";

const MODES: PageWidthMode[] = ["narrow", "standard", "wide"];

describe("pageWidth primitive", () => {
  it("defines a width and a padding class for every mode", () => {
    for (const mode of MODES) {
      expect(typeof PAGE_WIDTH_CLASS[mode]).toBe("string");
      expect(PAGE_WIDTH_CLASS[mode].length).toBeGreaterThan(0);
      expect(typeof PAGE_PADDING_CLASS[mode]).toBe("string");
      expect(PAGE_PADDING_CLASS[mode].length).toBeGreaterThan(0);
    }
  });

  it("narrow's padding is flat (no responsive escalation) — its reading column doesn't need extra inset at wide viewports", () => {
    expect(PAGE_PADDING_CLASS.narrow).toBe("px-4");
    expect(PAGE_PADDING_CLASS.narrow).not.toMatch(/sm:|md:|lg:|xl:/);
  });

  it("wide mode escalates its padding across breakpoints, unlike narrow", () => {
    expect(PAGE_PADDING_CLASS.wide).toMatch(/xl:px-/);
  });

  it("wide mode is a safety-capped near-fluid width (w-full elsewhere, arbitrary max-w cap here), not a plain fixed max-w-*", () => {
    expect(PAGE_WIDTH_CLASS.wide).toMatch(/^max-w-\[.+\]$/);
  });

  it("narrow and standard use plain Tailwind scale values", () => {
    expect(PAGE_WIDTH_CLASS.narrow).toBe("max-w-4xl");
    expect(PAGE_WIDTH_CLASS.standard).toBe("max-w-6xl");
  });
});
