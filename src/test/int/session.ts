/**
 * Integration-test helper: sign in as a seeded user and hand out Supabase clients that carry that user's session,
 * so server actions behave exactly as they do for a logged-in browser user (same JWT, same RLS).
 */
import fs from "node:fs";
import path from "node:path";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

function loadEnv(): Record<string, string> {
  const file = path.resolve(process.cwd(), ".env.development.local");
  if (!fs.existsSync(file)) throw new Error("Missing .env.development.local - run: bash supabase/local/stack.sh up");
  return Object.fromEntries(
    fs.readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l && !l.startsWith("#"))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
}

const env = loadEnv();
export const API_URL = env.NEXT_PUBLIC_SUPABASE_URL;
export const ANON_KEY = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
export const SERVICE_KEY = env.SUPABASE_SECRET_KEY;
export const PASSWORD = "Passw0rd#Local";

export const USERS = {
  admin: "admin@fertiledger.test",           // SUPER_ADMIN
  branch: "branch@fertiledger.test",         // BRANCH_ADMIN
  accountant: "accountant@fertiledger.test", // ACCOUNTANT
  sales: "sales@fertiledger.test",           // SALES_MANAGER
  stock: "stock@fertiledger.test",           // STOCK_MANAGER
  fms: "fms@fertiledger.test",               // FMS_COMPLIANCE
  viewer: "viewer@fertiledger.test",         // VIEWER
} as const;
export type TestUser = keyof typeof USERS;

type Session = { access_token: string; refresh_token: string; expires_at: number; user: { id: string } };
const sessions = new Map<TestUser, Session>();
let current: TestUser = "admin";

async function login(user: TestUser): Promise<Session> {
  const hit = sessions.get(user);
  if (hit && hit.expires_at * 1000 > Date.now() + 60_000) return hit;
  const res = await fetch(`${API_URL}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: USERS[user], password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login as ${user} failed (${res.status}): ${await res.text()}`);
  const s = (await res.json()) as Session;
  sessions.set(user, s);
  return s;
}

/** Call once (in beforeAll) per user you plan to act as, so the synchronous createClient() below has a token ready. */
export async function signInAs(user: TestUser) { await login(user); current = user; }
export function actAs(user: TestUser) {
  if (!sessions.has(user)) throw new Error(`call await signInAs("${user}") first`);
  current = user;
}

/** What `@/lib/supabase/server#createClient` is replaced with: same API, token-based session instead of cookies. */
export function createTestClient() {
  const s = sessions.get(current);
  if (!s) throw new Error(`no session for ${current} - call await signInAs("${current}") first`);
  const storageKey = "sb-test-auth-token";
  const store = new Map<string, string>([[storageKey, JSON.stringify(s)]]);
  return createSupabaseClient(API_URL, ANON_KEY, {
    auth: {
      persistSession: true, autoRefreshToken: false, detectSessionInUrl: false, storageKey,
      storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v), removeItem: (k) => void store.delete(k) },
    },
  });
}

/** Service-role client for test setup/verification that must bypass RLS (never used by the code under test). */
export function adminClient() {
  return createSupabaseClient(API_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}
