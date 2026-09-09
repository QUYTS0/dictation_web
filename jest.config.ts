import type { Config } from "jest";

// Standalone prototype apps checked in under oddly-named directories — not
// part of this app; excluded to avoid haste-map name collisions.
const modulePathIgnorePatterns = [
  "<rootDir>/.prettierignore/",
  "<rootDir>/.vercelignore/",
  "<rootDir>/.eslintignore/",
];
const moduleNameMapper = {
  "^@/(.*)$": "<rootDir>/src/$1",
};

const config: Config = {
  projects: [
    {
      displayName: "node",
      preset: "ts-jest",
      testEnvironment: "node",
      moduleNameMapper,
      testMatch: ["**/__tests__/**/*.test.ts"],
      modulePathIgnorePatterns,
      transform: {
        "^.+\\.tsx?$": ["ts-jest", { tsconfig: { jsx: "react" } }],
      },
    },
    {
      // Component/interaction tests for .tsx files (e.g. the Vocabulary
      // tab). Kept as a separate project rather than changing the "node"
      // project above: those files render JSX and need real DOM APIs
      // (document, window), which testEnvironment: "node" doesn't provide.
      displayName: "dom",
      preset: "ts-jest",
      testEnvironment: "jest-environment-jsdom",
      moduleNameMapper,
      testMatch: ["**/__tests__/**/*.test.tsx"],
      modulePathIgnorePatterns,
      setupFilesAfterEnv: ["<rootDir>/jest.setup.ts"],
      transform: {
        "^.+\\.tsx?$": ["ts-jest", { tsconfig: { jsx: "react-jsx" } }],
      },
    },
  ],
};

export default config;
