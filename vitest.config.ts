import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    // 'node' for server-side / pure TS tests (no DOM required for Phase 1)
    // Switch to 'jsdom' per-test or globally when adding React component tests.
    environment: "node",
    // Global test setup (set up once)
    globalSetup: [],
    // Include patterns
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "tests/**/*.test.ts"],
    // Exclude build output
    // *.int.test.ts need the local Supabase stack: run them with `npm run test:int` (vitest.int.config.ts)
    exclude: ["node_modules", ".next", "**/*.int.test.ts"],
    // Coverage configuration
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: ["src/**/*.test.*", "src/app/**", "src/components/**"],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
