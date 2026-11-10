-- ============================================================
-- Signup hardening + invitations end-to-end test (requires migrations 001-054)
-- ============================================================
\set ON_ERROR_STOP on
\set T  '''00000000-0000-0000-0000-00000000f201'''
\set T2 '''00000000-0000-0000-0000-00000000f202'''
\set O  '''00000000-0000-0000-0000-00000000f203'''
\set UA '''00000000-0000-0000-0000-00000000f204'''
\set UX '''00000000-0000-0000-0000-00000000f205'''
\set UN '''00000000-0000-0000-0000-00000000f206'''
\set UW '''00000000-0000-0000-0000-00000000f207'''
\set UI '''00000000-0000-0000-0000-00000000f208'''

CREATE OR REPLACE FUNCTION public.t_eq(label text, got numeric, want numeric) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN
  IF got IS DISTINCT FROM want THEN RAISE EXCEPTION 'FAIL [%]: got %, want %', label, got, want; END IF;
  RAISE NOTICE 'ok   %  = %', label, got;
END $$;
CREATE OR REPLACE FUNCTION public.t_fails(label text, stmt text, expect text) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN
  BEGIN EXECUTE stmt;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM ILIKE '%' || expect || '%' THEN RAISE NOTICE 'ok   % (rejected: %)', label, SQLERRM; RETURN; END IF;
    RAISE EXCEPTION 'FAIL [%]: wrong error: %', label, SQLERRM;
  END;
  RAISE EXCEPTION 'FAIL [%]: expected an error containing "%", but it succeeded', label, expect;
END $$;
GRANT EXECUTE ON FUNCTION public.t_eq(text,numeric,numeric), public.t_fails(text,text,text) TO authenticated;

INSERT INTO tenants(id, slug, name) VALUES (:T, 'inv-1', 'Invite One'), (:T2, 'inv-2', 'Invite Two');
SELECT onboard_tenant(:T, 'Invite One'); SELECT onboard_tenant(:T2, 'Invite Two');
INSERT INTO organisations(id, tenant_id, legal_name) VALUES (:O, :T, 'Invite Agro');
INSERT INTO parties(tenant_id, organisation_id, name, party_type) VALUES (:T, :O, 'Secret Customer', 'CUSTOMER');

-- 1. the signup hole -------------------------------------------------------------------------------
-- a stranger who puts OUR tenant id in their own (user) metadata at signup must not get a profile
INSERT INTO auth.users(id, email, raw_user_meta_data) VALUES (:UX, 'intruder@evil.test', jsonb_build_object('tenant_id', '00000000-0000-0000-0000-00000000f201', 'full_name', 'X'));
SELECT t_eq('user_metadata cannot choose a tenant: no profile created', (SELECT COUNT(*) FROM user_profiles WHERE id = :UX), 0);
-- server-side (admin API) provisioning uses app_metadata and still works
INSERT INTO auth.users(id, email, raw_user_meta_data, raw_app_meta_data) VALUES (:UA, 'admin@inv.test', '{"full_name":"Inv Admin"}', jsonb_build_object('tenant_id', '00000000-0000-0000-0000-00000000f201'));
SELECT t_eq('app_metadata provisions a profile', (SELECT COUNT(*) FROM user_profiles WHERE id = :UA AND tenant_id = :T), 1);

-- even a profile that somehow exists reads nothing until the user holds a role
INSERT INTO user_profiles(id, tenant_id, full_name) VALUES (:UX, :T, 'Roleless');
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :UX, false);
SELECT t_eq('a profile with no role sees no tenant data', (SELECT COUNT(*) FROM parties), 0);
SELECT t_eq('...and get_tenant_id() is NULL for it', (SELECT (public.get_tenant_id() IS NULL)::int), 1);
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', false);   -- setup below is done as the service, not as a signed-in user
INSERT INTO user_roles(tenant_id, user_id, role_id, organisation_id) SELECT :T, :UA, id, :O FROM roles WHERE tenant_id = :T AND name = 'SUPER_ADMIN';
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :UA, false);
SELECT t_eq('a user with a role sees their own tenant data', (SELECT COUNT(*) FROM parties), 1);
RESET ROLE;

-- 2. invitations -------------------------------------------------------------------------------------
INSERT INTO user_invitations(tenant_id, organisation_id, email, role_name, invite_token, invited_by) VALUES
  (:T, :O, 'new.person@inv.test', 'ACCOUNTANT', 'tok-good', :UA),
  (:T, :O, 'someone.else@inv.test', 'VIEWER', 'tok-other', :UA),
  (:T, :O, 'late@inv.test', 'VIEWER', 'tok-late', :UA);
UPDATE user_invitations SET expires_at = now() - interval '1 day' WHERE invite_token = 'tok-late';
INSERT INTO auth.users(id, email, raw_user_meta_data) VALUES (:UN, 'New.Person@inv.test', '{"full_name":"New Person"}');   -- created by the server with no tenant
INSERT INTO auth.users(id, email) VALUES (:UW, 'late@inv.test');

SELECT t_eq('the preview shows email, role and company only', (SELECT COUNT(*) FROM invitation_preview('tok-good') WHERE email = 'new.person@inv.test' AND role_name = 'ACCOUNTANT' AND company = 'Invite Agro' AND status = 'PENDING' AND NOT expired), 1);
SELECT t_eq('an unknown token previews nothing', (SELECT COUNT(*) FROM invitation_preview('nope')), 0);
SELECT t_fails('a different email cannot use the link', format($$SELECT accept_invitation('tok-other', %L)$$, :UN), 'different email');
SELECT t_fails('an expired link is refused', format($$SELECT accept_invitation('tok-late', %L)$$, :UW), 'expired');
SELECT t_fails('an unknown token is refused', format($$SELECT accept_invitation('nope', %L)$$, :UN), 'not valid');

SELECT accept_invitation('tok-good', :UN);
SELECT t_eq('accepting creates the profile in the inviting tenant', (SELECT COUNT(*) FROM user_profiles WHERE id = :UN AND tenant_id = :T AND full_name = 'New Person'), 1);
SELECT t_eq('...with exactly the invited role', (SELECT COUNT(*) FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = :UN AND r.name = 'ACCOUNTANT' AND ur.organisation_id = :O), 1);
SELECT t_eq('...and the invitation is ACCEPTED by that user', (SELECT COUNT(*) FROM user_invitations WHERE invite_token = 'tok-good' AND status = 'ACCEPTED' AND accepted_by = :UN), 1);
SELECT t_fails('the link works only once', format($$SELECT accept_invitation('tok-good', %L)$$, :UN), 'already been accepted');

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :UN, false);
SELECT t_eq('the new user can now see the company data', (SELECT COUNT(*) FROM parties), 1);

-- 3. normal users cannot call the server-only functions --------------------------------------------------
SELECT t_fails('a signed-in user cannot call accept_invitation', format($$SELECT accept_invitation('tok-other', %L)$$, :UN), 'permission denied');
SELECT t_fails('a signed-in user cannot read invitation previews', $$SELECT * FROM invitation_preview('tok-other')$$, 'permission denied');
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', false);

-- an account that belongs to ANOTHER company cannot be pulled into this one by a link
INSERT INTO auth.users(id, email, raw_app_meta_data) VALUES (:UI, 'other.company@inv.test', jsonb_build_object('tenant_id', '00000000-0000-0000-0000-00000000f202'));
INSERT INTO user_invitations(tenant_id, organisation_id, email, role_name, invite_token, invited_by) VALUES (:T, :O, 'other.company@inv.test', 'VIEWER', 'tok-cross', :UA);
SELECT t_fails('a user of another company cannot be moved by an invitation', format($$SELECT accept_invitation('tok-cross', %L)$$, :UI), 'another company');

DROP FUNCTION public.t_eq(text,numeric,numeric), public.t_fails(text,text,text);
\echo E2E PASSED
