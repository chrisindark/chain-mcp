import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

import noBlockingIo from "./eslint-rules/no-blocking-io.js";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "pnpm-lock.yaml"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: { globals: globals.node },
    rules: { "@typescript-eslint/consistent-type-imports": "error" },
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: { globals: globals.node },
  },
  {
    // Runtime request paths must not block the event loop with synchronous
    // filesystem or process calls. Tooling scripts and tests are exempt.
    files: [
      "packages/*/src/**/*.{ts,js,mjs,cjs}",
      "apps/*/src/**/*.{ts,js,mjs,cjs}",
    ],
    plugins: { chainmcp: { rules: { "no-blocking-io": noBlockingIo } } },
    rules: { "chainmcp/no-blocking-io": "error" },
  },
);
