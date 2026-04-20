import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests live alongside source as *.test.ts, plus a dedicated test/ dir
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // Node environment — no DOM
    environment: "node",
    // Keep individual tests fast; fail loudly if any hang
    testTimeout: 10_000,
    hookTimeout: 5_000,
    // ESM-only project — vitest handles this natively
    globals: false,
    // Don't try to run electron or build artifacts
    exclude: ["node_modules/**", "dist/**", "electron/**"],
  },
});
