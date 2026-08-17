import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Standalone prototype apps checked in under oddly-named directories
    // (not part of this Next.js app's build or lint scope).
    ".prettierignore/**",
    ".vercelignore/**",
    ".eslintignore/**",
  ]),
]);

export default eslintConfig;
