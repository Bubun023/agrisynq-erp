import { vi } from "vitest";
import { createTestClient, API_URL, SERVICE_KEY } from "./session";

// actions that use the service-role client (invitations) read these from the environment
process.env.NEXT_PUBLIC_SUPABASE_URL ??= API_URL;
process.env.SUPABASE_SECRET_KEY ??= SERVICE_KEY;

// The code under test imports these; replace only the parts that need a Next.js request scope.
vi.mock("@/lib/supabase/server", () => ({ createClient: () => createTestClient() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw new Error(`NEXT_REDIRECT:${url}`); },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
}));
vi.mock("next/headers", () => ({ cookies: () => ({ getAll: () => [], get: () => undefined, set: () => undefined }) }));
