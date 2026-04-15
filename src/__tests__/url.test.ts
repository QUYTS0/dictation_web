import {
  extractYouTubeVideoId,
  isValidYouTubeUrl,
} from "@/lib/utils/url";

describe("extractYouTubeVideoId", () => {
  it("extracts ID from standard watch URL", () => {
    expect(extractYouTubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(
      "dQw4w9WgXcQ"
    );
  });

  it("extracts ID from short URL", () => {
    expect(extractYouTubeVideoId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("extracts ID from embed URL", () => {
    expect(extractYouTubeVideoId("https://www.youtube.com/embed/dQw4w9WgXcQ")).toBe(
      "dQw4w9WgXcQ"
    );
  });

  it("extracts ID from shorts URL", () => {
    expect(extractYouTubeVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe(
      "dQw4w9WgXcQ"
    );
  });

  it("extracts ID with extra query params", () => {
    expect(
      extractYouTubeVideoId(
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&list=PLxxx"
      )
    ).toBe("dQw4w9WgXcQ");
  });

  it("accepts a bare 11-char video ID", () => {
    expect(extractYouTubeVideoId("dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("returns null for non-YouTube URLs", () => {
    expect(extractYouTubeVideoId("https://vimeo.com/123456")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractYouTubeVideoId("")).toBeNull();
  });

  it("returns null for short ID (not 11 chars)", () => {
    expect(extractYouTubeVideoId("short")).toBeNull();
  });
});

describe("isValidYouTubeUrl", () => {
  it("returns true for valid watch URL", () => {
    expect(isValidYouTubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(true);
  });

  it("returns false for invalid URL", () => {
    expect(isValidYouTubeUrl("not-a-url")).toBe(false);
  });
});
