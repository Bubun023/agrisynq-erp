-- ============================================================
-- Migration 035: Admin Module - User Invites, Org Settings, Org Users view
-- Phase 12 - FertiLedger ERP
-- ============================================================
-- Depends on: 003 (user_profiles, roles, user_roles), 004 (get_tenant_id,
-- set_updated_at), 010 (period_locks - reused for period locking, no new table).
-- Roles are the system roles seeded in 005 (SUPER_ADMIN, BRANCH_ADMIN, ...).

-- ─── Helper: is the current user an admin of their tenant? ────
CREATE OR REPLACE FUNCTION public.is_tenant_admin()
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM   public.user_roles ur
    JOIN   public.roles r ON r.id = ur.role_id
    WHERE  ur.user_id = auth.uid()
      AND  r.name IN ('SUPER_ADMIN', 'BRANCH_ADMIN')
  );
$$;

-- Admins may update (activate/deactivate) any profile in their tenant.
-- (004 only allows a user to update their own profile.)
DROP POLICY IF EXISTS "profile_admin_update" ON user_profiles;
CREATE POLICY "profile_admin_update" ON user_profiles
  FOR UPDATE USING (tenant_id = public.get_tenant_id() AND public.is_tenant_admin());

-- ─── User Invitations ─────────────────────────────────────────
-- NOTE: this table only records invitations. Sending the email and
-- accepting an invite (creating auth user + user_roles row) is NOT
-- implemented yet.
DO $$ BEGIN
  CREATE TYPE invite_status AS ENUM ('PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS user_invitations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  organisation_id  uuid NOT NULL REFERENCES organisations(id),
  email            text NOT NULL,
  role_name        text NOT NULL DEFAULT 'VIEWER',
  invite_token     text NOT NULL UNIQUE DEFAULT gen_random_uuid()::text,
  status           invite_status NOT NULL DEFAULT 'PENDING',
  invited_by       uuid REFERENCES auth.users(id),
  accepted_by      uuid REFERENCES auth.users(id),
  expires_at       timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS set_user_invitations_updated_at ON user_invitations;
CREATE TRIGGER set_user_invitations_updated_at
  BEFORE UPDATE ON user_invitations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE user_invitations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "invitations_tenant_select" ON user_invitations
  FOR SELECT USING (tenant_id = public.get_tenant_id());
CREATE POLICY "invitations_admin_insert" ON user_invitations
  FOR INSERT WITH CHECK (tenant_id = public.get_tenant_id() AND public.is_tenant_admin());
CREATE POLICY "invitations_admin_update" ON user_invitations
  FOR UPDATE USING (tenant_id = public.get_tenant_id() AND public.is_tenant_admin());

CREATE INDEX IF NOT EXISTS idx_invitations_org   ON user_invitations(organisation_id);
CREATE INDEX IF NOT EXISTS idx_invitations_email ON user_invitations(email);
-- At most one pending invite per email per organisation
CREATE UNIQUE INDEX IF NOT EXISTS uq_invitations_pending
  ON user_invitations(organisation_id, lower(email)) WHERE status = 'PENDING';

-- ─── Org Settings (key-value store) ──────────────────────────
CREATE TABLE IF NOT EXISTS organisation_settings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  organisation_id  uuid NOT NULL REFERENCES organisations(id),
  setting_key      text NOT NULL,
  setting_value    text,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid REFERENCES auth.users(id),
  UNIQUE (organisation_id, setting_key)
);

DROP TRIGGER IF EXISTS set_org_settings_updated_at ON organisation_settings;
CREATE TRIGGER set_org_settings_updated_at
  BEFORE UPDATE ON organisation_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE organisation_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "org_settings_tenant_select" ON organisation_settings
  FOR SELECT USING (tenant_id = public.get_tenant_id());
CREATE POLICY "org_settings_admin_insert" ON organisation_settings
  FOR INSERT WITH CHECK (tenant_id = public.get_tenant_id() AND public.is_tenant_admin());
CREATE POLICY "org_settings_admin_update" ON organisation_settings
  FOR UPDATE USING (tenant_id = public.get_tenant_id() AND public.is_tenant_admin());

-- ─── View: vw_org_users ──────────────────────────────────────
-- One row per (user, role assignment). Runs as view owner so it can read
-- auth.users for the email; it is therefore filtered to the caller's tenant.
CREATE OR REPLACE VIEW vw_org_users AS
SELECT
  up.id              AS user_profile_id,
  up.id              AS user_id,
  ur.organisation_id,
  r.name             AS role_name,
  up.full_name,
  up.phone,
  up.is_active,
  up.created_at      AS joined_at,
  au.email::text     AS email
FROM user_profiles up
JOIN user_roles ur ON ur.user_id = up.id
JOIN roles r       ON r.id = ur.role_id
JOIN auth.users au ON au.id = up.id
WHERE up.tenant_id = public.get_tenant_id();

GRANT SELECT ON vw_org_users TO authenticated;
GRANT SELECT, INSERT, UPDATE ON user_invitations      TO authenticated;
GRANT SELECT, INSERT, UPDATE ON organisation_settings TO authenticated;
