import type { Config } from "jest";

const config: Config = {
  preset: "ts-jest",
  testEnvironment: "node",
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
  },
  testMatch: ["**/__tests__/**/*.test.ts"],
  // Standalone prototype apps checked in under oddly-named directories —
  // not part of this app; excluded to avoid haste-map name collisions.
  modulePathIgnorePatterns: [
    "<rootDir>/.prettierignore/",
    "<rootDir>/.vercelignore/",
    "<rootDir>/.eslintignore/",
  ],
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: { jsx: "react" } }],
  },
};

export default config;
