import { defineConfig } from "vitest/config";

// The sustained-load memory check (npm run test:load). It runs on its own, not
// with the rest of the suite: it needs the CPU to itself, and it starves the
// timing-sensitive tests (sanitize-redos) when they share it.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/__tests__/sustained-load.test.ts"],
  },
});
