import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";
import Providers from "@/components/Providers";

// Self-hosted at build time. The Vietnamese subset covers translations and
// learner-entered text (see .claude/dashboard-redesign-plan.md §4.1).
const sans = Plus_Jakarta_Sans({
  subsets: ["latin", "latin-ext", "vietnamese"],
  variable: "--font-plus-jakarta",
  display: "swap",
});
const mono = JetBrains_Mono({
  subsets: ["latin", "latin-ext", "vietnamese"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "DictaLearn — English Dictation Trainer",
  description:
    "Practice English listening & dictation with YouTube videos. Auto-pause, answer checking, AI explanations.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "DictaLearn",
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  themeColor: "#5b5ce2",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} h-full antialiased`} suppressHydrationWarning>
      <body className="min-h-full flex flex-col bg-page text-ink font-sans">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
