"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type InvitePreview = { found: boolean; email?: string; role?: string; company?: string; usable?: boolean; reason?: string };

const TOKEN = /^[0-9a-f-]{36}$/i;
const ROLE_LABEL: Record<string, string> = {
  SUPER_ADMIN: "Super Admin", BRANCH_ADMIN: "Branch Admin", ACCOUNTANT: "Accountant", SALES_MANAGER: "Sales Manager",
  STOCK_MANAGER: "Stock Manager", FMS_COMPLIANCE: "FMS Compliance Officer", VIEWER: "Viewer",
};

/** Public: what an invitation link says (email, role, company) and whether it can still be used. Reveals nothing else. */
export async function getInvitePreview(token: string): Promise<InvitePreview> {
  try {
    if (!TOKEN.test(token ?? "")) return { found: false, reason: "This invitation link is not valid." };
    const { data, error } = await createAdminClient().rpc("invitation_preview", { p_token: token });
    if (error) return { found: false, reason: "This invitation could not be checked right now." };
    const r = (data as { email: string; role_name: string; company: string; status: string; expired: boolean }[] | null)?.[0];
    if (!r) return { found: false, reason: "This invitation link is not valid." };
    const base = { found: true, email: r.email, role: ROLE_LABEL[r.role_name] ?? r.role_name, company: r.company };
    if (r.status !== "PENDING") return { ...base, usable: false, reason: `This invitation has already been ${r.status.toLowerCase()}.` };
    if (r.expired) return { ...base, usable: false, reason: "This invitation has expired. Ask an administrator to send a new one." };
    return { ...base, usable: true };
  } catch (e) {
    return { found: false, reason: e instanceof Error ? e.message : "This invitation could not be checked right now." };
  }
}

/** New person: creates their login (email fixed by the invitation), gives them the invited role, and marks it accepted. */
export async function acceptInvitationNewUser(token: string, fullName: string, password: string): Promise<{ success?: boolean; error?: string; email?: string }> {
  try {
    const preview = await getInvitePreview(token);
    if (!preview.found || !preview.usable || !preview.email) return { error: preview.reason ?? "This invitation cannot be used." };
    const name = (fullName ?? "").trim();
    if (name.length < 2) return { error: "Please enter your full name." };
    if ((password ?? "").length < 8) return { error: "Choose a password of at least 8 characters." };

    const admin = createAdminClient();
    // tenant is deliberately NOT put in app_metadata here: the profile and role are created together, atomically, by accept_invitation
    const created = await admin.auth.admin.createUser({ email: preview.email, password, email_confirm: true, user_metadata: { full_name: name } });
    if (created.error || !created.data.user) {
      const msg = created.error?.message ?? "";
      if (/already|registered|exists/i.test(msg)) return { error: "An account with this email already exists. Sign in with it first, then open this link again." };
      return { error: "Could not create your account. " + msg };
    }
    const userId = created.data.user.id;
    const { error } = await admin.rpc("accept_invitation", { p_token: token, p_user_id: userId });
    if (error) {
      await admin.auth.admin.deleteUser(userId);        // do not leave a half-made login behind
      return { error: error.message };
    }
    return { success: true, email: preview.email };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not accept the invitation." };
  }
}

/** Someone who already has a login and is signed in as the invited email. */
export async function acceptInvitationSignedIn(token: string): Promise<{ success?: boolean; error?: string }> {
  try {
    const { data } = await createClient().auth.getUser();
    if (!data.user) return { error: "Please sign in first." };
    const { error } = await createAdminClient().rpc("accept_invitation", { p_token: token, p_user_id: data.user.id });
    if (error) return { error: error.message };
    return { success: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not accept the invitation." };
  }
}
