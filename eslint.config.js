import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules", "coverage", ".next", ".vercel", "dist"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    // Tests handle untyped JSON responses from the API.
    files: ["test/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  {
    // The core is deterministic domain logic: no IO, no providers, no world-specific code.
    files: ["src/core/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/infra/*", "@/court/*", "@/connectors/*", "@/model/*", "@/testing/*", "../*"],
              message: "src/core must stay independent of adapters and application code.",
            },
            {
              group: ["pg", "@anthropic-ai/*", "openai", "node:fs", "node:net", "node:http"],
              message: "src/core must not perform IO or depend on providers.",
            },
          ],
        },
      ],
    },
  },
);
