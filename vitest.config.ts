import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Needs the CPU to itself: run with `npm run test:load` (vitest.load.config.ts).
    exclude: ["**/node_modules/**", "**/dist/**", "src/__tests__/sustained-load.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: ["node_modules", "dist", "**/*.test.ts"],
    },
    mockReset: true,
    restoreMocks: true,
  },
});
