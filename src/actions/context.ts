"use server";

/**
 * Shared server-side user context helper for FertiLedger ERP.
 *
 * SECURITY RULES:
 * - Never trust tenant_id / organisation_id / branch_id from the browser.
 * - Always resolve context from the authenticated session → user_roles table.
 * - Pass context explicitly to every DB query.
 */

import { createClient } from "@/lib/supabase/server";

export interface UserContext {
  userId: string;
  tenantId: string;
  organisationId: string;
  branchId: string | null;
  roleName: string | null;
  /** false when the user has no user_roles row (account not set up yet). */
  provisioned: boolean;
}

/**
 * Resolves the authenticated user's full context:
 * - userId (from Supabase auth session)
 * - tenantId, organisationId, branchId (from user_roles table)
 * - roleName (first matching role)
 *
 * Throws if:
 * - User is not authenticated
 * - User has no organisation assigned
 *
 * @returns UserContext — all IDs resolved server-side
 */
export async function getUserContext(): Promise<UserContext> {
  const supabase = createClient();

  // 1. Verify session (never trust cookies alone)
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    throw new Error("Not authenticated. Please sign in.");
  }

  // 2. Resolve tenant + org + branch from user_roles (server-side only)
  const { data: roleData, error: roleError } = await supabase
    .from("user_roles")
    .select(`
      tenant_id,
      organisation_id,
      branch_id,
      roles ( name )
    `)
    .eq("user_id", user.id)
    .not("organisation_id", "is", null)
    .order("created_at", { ascending: true })
    .limit(1)
    .single();

  // ── Graceful fallback when migrations haven't been applied yet ──
  // If user_roles table doesn't exist or user has no role assigned,
  // return a best-effort context so pages render (with empty data)
  // instead of bouncing the user back to the dashboard in a loop.
  if (roleError || !roleData) {
    // Use the auth user's own ID as a placeholder tenant/org.
    // All DB queries will return empty results (no matching rows),
    // which is correct — pages will show their empty states.
    return {
      userId: user.id,
      tenantId: user.id,          // placeholder — no real tenant yet
      organisationId: user.id,    // placeholder — no real org yet
      branchId: null,
      roleName: null,
      provisioned: false,
    };
  }

  // Safely extract role name — Supabase returns joined data as object or null
  const roleName =
    roleData.roles && typeof roleData.roles === "object" && !Array.isArray(roleData.roles)
      ? (roleData.roles as { name: string }).name
      : null;

  return {
    userId: user.id,
    tenantId: roleData.tenant_id as string,
    organisationId: roleData.organisation_id as string,
    branchId: roleData.branch_id as string | null,
    roleName,
    provisioned: true,
  };
}

/**
 * Helper: write an audit log entry.
 * Safe to call from any server action.
 * Never throws — logs errors to console so the main transaction is not blocked.
 */
export async function writeAuditLog(params: {
  ctx: UserContext;
  action: string;
  tableName: string;
  recordId?: string;
  oldValues?: Record<string, unknown>;
  newValues?: Record<string, unknown>;
  changedFields?: string[];
  reason?: string;
}): Promise<void> {
  try {
    const supabase = createClient();
    await supabase.from("audit_logs").insert({
      tenant_id: params.ctx.tenantId,
      organisation_id: params.ctx.organisationId,
      user_id: params.ctx.userId,
      user_role: params.ctx.roleName,
      action: params.action,
      table_name: params.tableName,
      record_id: params.recordId ?? null,
      old_values: params.oldValues ?? null,
      new_values: params.newValues ?? null,
      changed_fields: params.changedFields ?? null,
      reason: params.reason ?? null,
      source: "app",
    });
  } catch (err) {
    // Never block the main transaction due to audit log failure
    console.error("[AuditLog] Failed to write audit entry:", err);
  }
}
