-- 054: close a tenant-isolation hole at signup, and add the invitation-accept function.
--
-- THE HOLE: handle_new_user() (004) built a user_profile from raw_USER_meta_data->>'tenant_id'. user_metadata is chosen by
-- the person signing up, so anyone with the public anon key could call /auth/v1/signup with another company's tenant id
-- and get a profile in that tenant - which made get_tenant_id() return it, so every tenant-scoped SELECT policy let them READ
-- that company's data (writes were already stopped by the read-only guard). Reproduced against the local stack before fixing.
--
-- THE FIX (two layers):
--   1. the trigger now trusts only raw_APP_meta_data (settable solely with the service key / admin API, never at signup);
--   2. get_tenant_id() returns NULL unless the user actually holds a role, so a stray profile reads nothing.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (NEW.raw_app_meta_data ->> 'tenant_id') IS NOT NULL THEN
    INSERT INTO public.user_profiles (id, tenant_id, full_name)
    VALUES (
      NEW.id,
      (NEW.raw_app_meta_data ->> 'tenant_id')::UUID,
      COALESCE(NEW.raw_user_meta_data ->> 'full_name', split_part(NEW.email, '@', 1))
    )
    ON CONFLICT (id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_tenant_id()
RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.tenant_id
    FROM public.user_profiles p
   WHERE p.id = auth.uid()
     AND EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = p.id AND r.tenant_id = p.tenant_id)
$$;

-- (Profiles already created through the old hole are left in place - with no role they read nothing any more. Review
--  user_profiles rows that have no user_roles row and delete the ones you do not recognise.)

-- ─── accept_invitation ────────────────────────────────────────
-- Called only by the server (service key) after it has created / identified the auth user. One-time, expiring, and the
-- auth user's email must equal the invited email, so a leaked link cannot be used with a different address.
CREATE OR REPLACE FUNCTION public.accept_invitation(p_token text, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  inv      user_invitations%ROWTYPE;
  v_email  text;
  v_name   text;
  v_role   uuid;
  v_other  uuid;
BEGIN
  SELECT * INTO inv FROM user_invitations WHERE invite_token = p_token FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'This invitation link is not valid'; END IF;
  IF inv.status <> 'PENDING' THEN RAISE EXCEPTION 'This invitation has already been %', lower(inv.status::text); END IF;
  IF inv.expires_at < now() THEN
    RAISE EXCEPTION 'This invitation has expired - ask an administrator to send a new one';
  END IF;

  SELECT lower(email), COALESCE(raw_user_meta_data ->> 'full_name', split_part(email, '@', 1)) INTO v_email, v_name FROM auth.users WHERE id = p_user_id;
  IF v_email IS NULL THEN RAISE EXCEPTION 'User not found'; END IF;
  IF v_email <> lower(inv.email) THEN RAISE EXCEPTION 'This invitation was sent to a different email address'; END IF;

  SELECT tenant_id INTO v_other FROM user_profiles WHERE id = p_user_id;
  IF v_other IS NOT NULL AND v_other <> inv.tenant_id THEN
    RAISE EXCEPTION 'This account already belongs to another company';
  END IF;

  SELECT id INTO v_role FROM roles WHERE tenant_id = inv.tenant_id AND name = inv.role_name;
  IF v_role IS NULL THEN RAISE EXCEPTION 'The invited role no longer exists'; END IF;

  INSERT INTO user_profiles (id, tenant_id, full_name) VALUES (p_user_id, inv.tenant_id, v_name) ON CONFLICT (id) DO NOTHING;
  IF NOT EXISTS (SELECT 1 FROM user_roles WHERE user_id = p_user_id AND role_id = v_role AND organisation_id = inv.organisation_id) THEN
    INSERT INTO user_roles (tenant_id, user_id, role_id, organisation_id) VALUES (inv.tenant_id, p_user_id, v_role, inv.organisation_id);
  END IF;
  UPDATE user_invitations SET status = 'ACCEPTED', accepted_by = p_user_id WHERE id = inv.id;
  RETURN jsonb_build_object('tenant_id', inv.tenant_id, 'organisation_id', inv.organisation_id, 'role', inv.role_name);
END $$;

REVOKE ALL ON FUNCTION public.accept_invitation(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_invitation(text, uuid) TO service_role;

-- What the public invitation page may show for a token: nothing but the email, role, company name and whether it is usable.
CREATE OR REPLACE FUNCTION public.invitation_preview(p_token text)
RETURNS TABLE (email text, role_name text, company text, status text, expired boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT i.email, i.role_name, COALESCE(o.legal_name, t.name), i.status::text, i.expires_at < now()
    FROM user_invitations i
    JOIN tenants t ON t.id = i.tenant_id
    LEFT JOIN organisations o ON o.id = i.organisation_id
   WHERE i.invite_token = p_token
$$;
REVOKE ALL ON FUNCTION public.invitation_preview(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invitation_preview(text) TO service_role;
