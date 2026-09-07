import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Loads these server-only vocab-highlight-pipeline dependencies from
  // node_modules at runtime rather than having Next bundle/transform them —
  // wink-eng-lite-web-model in particular ships a sizeable pretrained model
  // as on-disk data files, not analyzable JS imports. Note: this avoids
  // bundler mangling, but does NOT by itself guarantee a small deployed
  // Vercel function — Vercel's build still traces filesystem dependencies
  // (@vercel/nft) to decide what ships; actual bundle-size impact must be
  // measured against a real `next build`/deployment, not assumed from this
  // setting's presence alone.
  serverExternalPackages: ["wink-nlp", "wink-eng-lite-web-model", "subtlex-word-frequencies"],
};

export default nextConfig;
