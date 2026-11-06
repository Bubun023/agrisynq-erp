'use server';

import { createClient } from '@/lib/supabase/server';
import { getUserContext, writeAuditLog } from '@/actions/context';
import { revalidatePath } from 'next/cache';

// System roles from migration 005 that may administer users/periods/settings
const ADMIN_ROLES = ['SUPER_ADMIN', 'BRANCH_ADMIN'];
function isAdmin(roleName: string | null) {
  return !!roleName && ADMIN_ROLES.includes(roleName);
}

// ─── Types ────────────────────────────────────────────────────

export type OrgUser = {
  user_profile_id: string;
  user_id: string;
  role_name: string;
  full_name: string | null;
  phone: string | null;
  is_active: boolean;
  joined_at: string;
  email: string;
};

export type UserInvitation = {
  id: string;
  email: string;
  role_name: string;
  status: 'PENDING' | 'ACCEPTED' | 'EXPIRED' | 'REVOKED';
  expires_at: string;
  created_at: string;
};

export type PeriodLock = {
  id: string;
  period_year: number;
  period_month: number;
  is_locked: boolean;
  locked_at: string;
  unlock_reason: string | null;
};

export type OrgSetting = {
  setting_key: string;
  setting_value: string | null;
};

// ─── Users ────────────────────────────────────────────────────

export async function getOrgUsers() {
  const supabase = createClient();
  const ctx = await getUserContext();

  const { data, error } = await supabase
    .from('vw_org_users')
    .select('*')
    .eq('organisation_id', ctx.organisationId)
    .order('full_name', { ascending: true });

  if (error) throw new Error(`Users error: ${error.message}`);
  return data as OrgUser[];
}

export async function toggleUserActive(userProfileId: string, isActive: boolean) {
  const supabase = createClient();
  const ctx = await getUserContext();

  if (!isAdmin(ctx.roleName)) {
    return { error: 'Only admins can activate/deactivate users.' };
  }

  if (!isActive && userProfileId === ctx.userId) {
    return { error: 'You cannot deactivate your own account.' };
  }

  const { error } = await supabase
    .from('user_profiles')
    .update({ is_active: isActive })
    .eq('id', userProfileId)
    .eq('tenant_id', ctx.tenantId);

  if (error) return { error: error.message };

  await writeAuditLog({
    ctx, action: isActive ? 'ACTIVATE_USER' : 'DEACTIVATE_USER',
    tableName: 'user_profiles', recordId: userProfileId,
    newValues: { is_active: isActive },
  });
  revalidatePath('/admin/users');
  return { success: true };
}

export async function changeUserRole(userProfileId: string, newRole: string) {
  const supabase = createClient();
  const ctx = await getUserContext();

  if (!isAdmin(ctx.roleName)) {
    return { error: 'Only admins can change roles.' };
  }

  const { data: role } = await supabase
    .from('roles')
    .select('id')
    .eq('tenant_id', ctx.tenantId)
    .eq('name', newRole)
    .maybeSingle();
  if (!role) return { error: `Unknown role: ${newRole}` };

  const { error } = await supabase
    .from('user_roles')
    .update({ role_id: role.id })
    .eq('user_id', userProfileId)
    .eq('organisation_id', ctx.organisationId);

  if (error) return { error: error.message };

  await writeAuditLog({
    ctx, action: 'CHANGE_USER_ROLE', tableName: 'user_profiles', recordId: userProfileId,
    newValues: { role_name: newRole },
  });
  revalidatePath('/admin/users');
  return { success: true };
}

// ─── Invitations ──────────────────────────────────────────────

export async function getInvitations() {
  const supabase = createClient();
  const ctx = await getUserContext();

  const { data, error } = await supabase
    .from('user_invitations')
    .select('id, email, role_name, status, expires_at, created_at')
    .eq('organisation_id', ctx.organisationId)
    .order('created_at', { ascending: false });

  if (error) throw new Error(`Invitations error: ${error.message}`);
  return data as UserInvitation[];
}

export async function createInvitation(email: string, roleName: string) {
  const supabase = createClient();
  const ctx = await getUserContext();

  if (!isAdmin(ctx.roleName)) {
    return { error: 'Only admins can invite users.' };
  }

  // Check if already an active member
  const { data: existing } = await supabase
    .from('vw_org_users')
    .select('user_profile_id')
    .eq('organisation_id', ctx.organisationId)
    .ilike('email', email)
    .maybeSingle();

  if (existing) return { error: `${email} is already a member of this organisation.` };

  const { data: role } = await supabase
    .from('roles').select('id').eq('tenant_id', ctx.tenantId).eq('name', roleName).maybeSingle();
  if (!role) return { error: `Unknown role: ${roleName}` };

  const { data, error } = await supabase
    .from('user_invitations')
    .insert({
      tenant_id: ctx.tenantId,
      organisation_id: ctx.organisationId,
      email,
      role_name: roleName,
      invited_by: ctx.userId,
    })
    .select()
    .single();

  if (error) return { error: error.message };

  await writeAuditLog({
    ctx, action: 'INVITE_USER', tableName: 'user_invitations', recordId: data.id,
    newValues: { email, role_name: roleName },
  });
  revalidatePath('/admin/users');
  return { data };
}

export async function revokeInvitation(inviteId: string) {
  const supabase = createClient();
  const ctx = await getUserContext();

  if (!isAdmin(ctx.roleName)) return { error: 'Only admins can revoke invitations.' };

  const { error } = await supabase
    .from('user_invitations')
    .update({ status: 'REVOKED' })
    .eq('id', inviteId)
    .eq('organisation_id', ctx.organisationId);

  if (error) return { error: error.message };
  revalidatePath('/admin/users');
  return { success: true };
}

// ─── Period Locks ─────────────────────────────────────────────
// Monthly FINANCIAL locks stored in the shared `period_locks` table (migration 010).

type PeriodLockRow = {
  id: string; period_from: string; is_locked: boolean;
  locked_at: string | null; unlock_reason: string | null;
};

function toPeriodLock(r: PeriodLockRow): PeriodLock {
  const [y, m] = r.period_from.split('-').map(Number);
  return {
    id: r.id, period_year: y, period_month: m, is_locked: r.is_locked,
    locked_at: r.locked_at ?? '', unlock_reason: r.unlock_reason,
  };
}

const LOCK_COLS = 'id, period_from, is_locked, locked_at, unlock_reason';

export async function getPeriodLocks() {
  const supabase = createClient();
  const ctx = await getUserContext();

  const { data, error } = await supabase
    .from('period_locks')
    .select(LOCK_COLS)
    .eq('tenant_id', ctx.tenantId)
    .eq('organisation_id', ctx.organisationId)
    .eq('lock_type', 'FINANCIAL')
    .order('period_from', { ascending: false });

  if (error) throw new Error(`Period locks error: ${error.message}`);
  return (data as PeriodLockRow[]).map(toPeriodLock);
}

export async function lockPeriod(year: number, month: number) {
  const supabase = createClient();
  const ctx = await getUserContext();

  if (!isAdmin(ctx.roleName)) return { error: 'Only admins can lock periods.' };
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return { error: 'Invalid period.' };
  }

  const pad = (n: number) => String(n).padStart(2, '0');
  const periodFrom = `${year}-${pad(month)}-01`;
  const periodTo = `${year}-${pad(month)}-${pad(new Date(year, month, 0).getDate())}`;
  const now = new Date().toISOString();

  const { data: existing } = await supabase
    .from('period_locks')
    .select('id')
    .eq('tenant_id', ctx.tenantId)
    .eq('organisation_id', ctx.organisationId)
    .eq('lock_type', 'FINANCIAL')
    .eq('period_from', periodFrom)
    .is('branch_id', null)
    .maybeSingle();

  const query = existing
    ? supabase.from('period_locks')
        .update({ is_locked: true, locked_by: ctx.userId, locked_at: now, unlock_reason: null })
        .eq('id', existing.id)
    : supabase.from('period_locks')
        .insert({
          tenant_id: ctx.tenantId, organisation_id: ctx.organisationId,
          lock_type: 'FINANCIAL', period_from: periodFrom, period_to: periodTo,
          is_locked: true, locked_by: ctx.userId, locked_at: now,
        });

  const { data, error } = await query.select(LOCK_COLS).single();
  if (error) return { error: error.message };

  await writeAuditLog({
    ctx, action: 'LOCK_PERIOD', tableName: 'period_locks', recordId: data.id,
    newValues: { period_from: periodFrom, period_to: periodTo },
  });
  revalidatePath('/admin/periods');
  return { data: toPeriodLock(data as PeriodLockRow) };
}

export async function unlockPeriod(lockId: string, reason: string) {
  const supabase = createClient();
  const ctx = await getUserContext();

  if (!isAdmin(ctx.roleName)) return { error: 'Only admins can unlock periods.' };
  if (!reason.trim()) return { error: 'An unlock reason is required.' };

  const { error } = await supabase
    .from('period_locks')
    .update({
      is_locked: false, unlock_reason: reason,
      unlocked_by: ctx.userId, unlocked_at: new Date().toISOString(),
    })
    .eq('id', lockId)
    .eq('tenant_id', ctx.tenantId)
    .eq('organisation_id', ctx.organisationId);

  if (error) return { error: error.message };

  await writeAuditLog({
    ctx, action: 'UNLOCK_PERIOD', tableName: 'period_locks', recordId: lockId,
    newValues: { unlock_reason: reason },
  });
  revalidatePath('/admin/periods');
  return { success: true };
}

// ─── Org Settings ─────────────────────────────────────────────

export async function getOrgSettings() {
  const supabase = createClient();
  const ctx = await getUserContext();

  const { data, error } = await supabase
    .from('organisation_settings')
    .select('setting_key, setting_value')
    .eq('organisation_id', ctx.organisationId);

  if (error) throw new Error(error.message);

  // Return as a flat map
  const map: Record<string, string> = {};
  (data ?? []).forEach(r => { if (r.setting_key) map[r.setting_key] = r.setting_value ?? ''; });
  return map;
}

export async function saveOrgSettings(settings: Record<string, string>) {
  const supabase = createClient();
  const ctx = await getUserContext();

  if (!isAdmin(ctx.roleName)) return { error: 'Only admins can change settings.' };

  const rows = Object.entries(settings).map(([key, value]) => ({
    tenant_id:       ctx.tenantId,
    organisation_id: ctx.organisationId,
    setting_key:     key,
    setting_value:   value,
    updated_by:      ctx.userId,
  }));

  const { error } = await supabase
    .from('organisation_settings')
    .upsert(rows, { onConflict: 'organisation_id,setting_key' });

  if (error) return { error: error.message };
  revalidatePath('/admin/settings');
  return { success: true };
}
