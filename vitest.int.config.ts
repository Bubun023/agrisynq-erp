import { defineConfig } from "vitest/config";
import path from "path";

/**
 * Integration tests: run the REAL server actions against the LOCAL dev stack (supabase/local) as real logged-in users.
 *   bash supabase/local/stack.sh up && bash supabase/local/stack.sh seed
 *   npm run test:int
 * Only the cookie-based Supabase client (next/headers) and Next's cache/redirect helpers are replaced - see src/test/int/setup.ts.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.int.test.ts"],
    exclude: ["node_modules", ".next"],
    setupFiles: ["src/test/int/setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,        // one shared database: run files one after another
    sequence: { concurrent: false },
  },
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
});
