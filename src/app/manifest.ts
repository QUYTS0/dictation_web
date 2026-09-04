import type { MetadataRoute } from "next";

// scope="/" must cover every internal route (dashboard, dictation, vocabulary,
// bookmarks, history, results, ...) so that navigating between them stays
// inside the installed PWA window instead of iOS/Android falling back to the
// browser chrome. start_url must sit inside that scope.
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "DictaLearn — English Dictation Trainer",
    short_name: "DictaLearn",
    description:
      "Practice English listening & dictation with YouTube videos. Auto-pause, answer checking, AI explanations.",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    background_color: "#f8fafc",
    theme_color: "#4f46e5",
    icons: [
      {
        src: "/favicon.ico",
        sizes: "any",
        type: "image/x-icon",
      },
    ],
  };
}
