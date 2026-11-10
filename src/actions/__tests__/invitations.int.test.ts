/** Invitations end to end through the real actions + real GoTrue: create -> preview -> accept -> log in; and the signup hole stays shut. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signInAs, actAs, API_URL, ANON_KEY, SERVICE_KEY, PASSWORD } from "@/test/int/session";
import { admin, tag, tenantId } from "@/test/int/helpers";
import { createInvitation, revokeInvitation, getInvitations } from "@/actions/admin";
import { getInvitePreview, acceptInvitationNewUser } from "@/actions/invitations";

const email = `invitee.${tag}@fertiledger.test`.toLowerCase();
const createdUsers: string[] = [];
let tid: string;

const tokenFor = async (e: string) =>
  (await admin.from("user_invitations").select("invite_token").eq("tenant_id", tid).ilike("email", e).order("created_at", { ascending: false }).limit(1).single()).data!.invite_token as string;

async function login(e: string, password: string) {
  const r = await fetch(`${API_URL}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: ANON_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ email: e, password }) });
  return r.ok ? ((await r.json()) as { access_token: string; user: { id: string } }) : null;
}

beforeAll(async () => {
  for (const u of ["admin", "sales"] as const) await signInAs(u);
  actAs("admin");
  tid = await tenantId();
});
afterAll(async () => {
  for (const id of createdUsers) await fetch(`${API_URL}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } });
});

describe("invitation flow", () => {
  it("only admins can invite", async () => {
    actAs("sales");
    expect((await createInvitation(email, "VIEWER")).error ?? "").toMatch(/Only admins/);
    actAs("admin");
  });

  it("previews a link, rejects junk, and shows nothing sensitive", async () => {
    const r = await createInvitation(email, "STOCK_MANAGER");
    expect(r.error).toBeUndefined();
    const token = await tokenFor(email);
    expect(await getInvitePreview(token)).toMatchObject({ found: true, usable: true, email, role: "Stock Manager" });
    expect((await getInvitePreview("not-a-token")).found).toBe(false);
    expect((await getInvitePreview("00000000-0000-0000-0000-000000000000")).found).toBe(false);
    expect((await getInvitations()).find((i) => i.email === email)?.invite_token).toBe(token);
  });

  it("accepting creates a working login with exactly the invited role", async () => {
    const token = await tokenFor(email);
    expect((await acceptInvitationNewUser(token, "X", "longenough1")).error ?? "").toMatch(/full name/);
    expect((await acceptInvitationNewUser(token, "Ivy Invitee", "short")).error ?? "").toMatch(/8 characters/);
    const ok = await acceptInvitationNewUser(token, "Ivy Invitee", "Sup3r-secret!");
    expect(ok).toMatchObject({ success: true, email });

    const session = await login(email, "Sup3r-secret!");
    expect(session).not.toBeNull();
    createdUsers.push(session!.user.id);
    const roles = await admin.from("user_roles").select("roles(name), tenant_id").eq("user_id", session!.user.id);
    expect(roles.data!.map((r) => (r.roles as unknown as { name: string }).name)).toEqual(["STOCK_MANAGER"]);
    expect(roles.data![0].tenant_id).toBe(tid);
    expect((await admin.from("user_profiles").select("full_name").eq("id", session!.user.id).single()).data!.full_name).toBe("Ivy Invitee");
    expect((await admin.from("user_invitations").select("status").eq("invite_token", token).single()).data!.status).toBe("ACCEPTED");

    // the new user sees the company's data
    const parties = await fetch(`${API_URL}/rest/v1/parties?select=name&limit=1`, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${session!.access_token}` } });
    expect((await parties.json()).length).toBe(1);
  });

  it("a used link cannot be used again, and a revoked one cannot be used at all", async () => {
    const used = await tokenFor(email);
    expect(await getInvitePreview(used)).toMatchObject({ found: true, usable: false });
    expect((await acceptInvitationNewUser(used, "Again Person", "Sup3r-secret!")).error ?? "").toMatch(/already been accepted/);

    const e2 = `revoked.${tag}@fertiledger.test`.toLowerCase();
    const r = await createInvitation(e2, "VIEWER");
    expect(r.error).toBeUndefined();
    const id = (await admin.from("user_invitations").select("id").ilike("email", e2).single()).data!.id;
    expect((await revokeInvitation(id)).error).toBeUndefined();
    expect((await acceptInvitationNewUser(await tokenFor(e2), "Rev Person", "Sup3r-secret!")).error ?? "").toMatch(/revoked/);
    const created = await login(e2, "Sup3r-secret!");
    expect(created).toBeNull();                       // no login was created for a revoked link
  });

  it("an expired link is refused", async () => {
    const e3 = `late.${tag}@fertiledger.test`.toLowerCase();
    await createInvitation(e3, "VIEWER");
    await admin.from("user_invitations").update({ expires_at: new Date(Date.now() - 86400000).toISOString() }).ilike("email", e3);
    const token = await tokenFor(e3);
    expect(await getInvitePreview(token)).toMatchObject({ usable: false });
    expect((await acceptInvitationNewUser(token, "Late Person", "Sup3r-secret!")).error ?? "").toMatch(/expired/);
    expect(await login(e3, "Sup3r-secret!")).toBeNull();
  });
});

describe("signup hardening", () => {
  it("a stranger cannot join this company by naming its tenant id at signup", async () => {
    const stranger = `stranger.${tag}@evil.test`;
    const r = await fetch(`${API_URL}/auth/v1/signup`, { method: "POST", headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email: stranger, password: PASSWORD, data: { tenant_id: tid, full_name: "Stranger" } }) });
    const body = await r.json();
    const uid = body.user?.id ?? body.id;
    if (uid) createdUsers.push(uid);
    expect((await admin.from("user_profiles").select("id").eq("id", uid ?? "00000000-0000-0000-0000-000000000000"))?.data).toHaveLength(0);
    if (body.access_token) {
      const parties = await fetch(`${API_URL}/rest/v1/parties?select=name&limit=5`, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${body.access_token}` } });
      expect(await parties.json()).toEqual([]);
    }
  });
});
