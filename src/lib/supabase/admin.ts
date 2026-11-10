import { createClient } from "@supabase/supabase-js";

/**
 * Service-role client. It BYPASSES row-level security, so it may only be used in server actions for the few jobs
 * that cannot run as the signed-in user (e.g. accepting an invitation for someone who has no account yet).
 * Never import it from a client component, and always scope what it does by hand.
 */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("Server is not configured for invitations (SUPABASE_SECRET_KEY is missing)");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
