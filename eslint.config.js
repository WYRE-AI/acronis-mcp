import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // fixtures/ holds plain CommonJS preloads that run inside child processes.
  { ignores: ["dist/", "node_modules/", "coverage/", "src/__tests__/fixtures/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  }
);
