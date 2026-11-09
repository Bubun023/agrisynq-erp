import { vi } from "vitest";
import { createTestClient } from "./session";

// The code under test imports these; replace only the parts that need a Next.js request scope.
vi.mock("@/lib/supabase/server", () => ({ createClient: () => createTestClient() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw new Error(`NEXT_REDIRECT:${url}`); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
}));
vi.mock("next/headers", () => ({ cookies: () => ({ getAll: () => [], get: () => undefined, set: () => undefined }) }));
