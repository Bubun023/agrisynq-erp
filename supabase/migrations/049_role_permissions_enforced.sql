-- ============================================================
-- Migration 049: enforce the role-permission matrix in the database
-- FertiLedger ERP
-- ============================================================
-- Found by running the real app: the posting functions never looked at the caller's role, so a VIEWER
-- ("read-only access") could create and POST invoices. 005 defined permissions + role_permissions but nothing used them.
--
--  1. has_permission(module, action) / require_permission(): read role_permissions for the signed-in user.
--  2. can_write(): true when the user holds at least one permission other than read/export.
--  3. A BEFORE INSERT/UPDATE/DELETE guard on EVERY tenant table: read-only users cannot change anything, by any route
--     (direct table write or a SECURITY DEFINER posting function - the guard fires either way). attach_readonly_guard()
--     is idempotent; e2e_permissions.sql fails if a table with tenant_id is ever added without it.
--  4. require_permission() is inserted at the top of every posting / approval function (listed below), by patching the
--     existing definitions in place so their bodies are not duplicated here.
--  5. The default matrix had gaps, filled for existing tenants and (via onboard_tenant) all future ones:
--       BRANCH_ADMIN had NO permissions -> gets everything SUPER_ADMIN has except user admin, period locks, audit log,
--                                           unmasked farmer KYC and hard-deleting master data;
--       ACCOUNTANT could not book supplier invoices -> gets purchases.create + purchases.post.
--     Adjust role_permissions per tenant if your organisation works differently.
-- Calls with no signed-in user (auth.uid() IS NULL: migrations, the SQL editor, the service key) are never blocked.

-- ─── 1. permission helpers ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.has_permission(p_module text, p_action text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_roles ur
      JOIN role_permissions rp ON rp.role_id = ur.role_id
      JOIN permissions p ON p.id = rp.permission_id
     WHERE ur.user_id = auth.uid() AND p.module = p_module AND p.action = p_action)
$$;

CREATE OR REPLACE FUNCTION public.require_permission(p_module text, p_action text)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.has_permission(p_module, p_action) THEN
    RAISE EXCEPTION 'You do not have permission to % (%.%)',
      CASE p_action WHEN 'post' THEN 'post ' || replace(p_module, '_', ' ') WHEN 'approve' THEN 'approve ' || replace(p_module, '_', ' ')
                    WHEN 'create' THEN 'create ' || replace(p_module, '_', ' ') WHEN 'import' THEN 'import ' || replace(p_module, '_', ' ')
                    ELSE p_action || ' ' || replace(p_module, '_', ' ') END, p_module, p_action
      USING ERRCODE = '42501';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.can_write()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_roles ur
      JOIN role_permissions rp ON rp.role_id = ur.role_id
      JOIN permissions p ON p.id = rp.permission_id
     WHERE ur.user_id = auth.uid() AND p.action NOT IN ('read', 'export'))
$$;

GRANT EXECUTE ON FUNCTION public.has_permission(text,text), public.require_permission(text,text), public.can_write() TO authenticated;

-- ─── 2. read-only guard on every tenant table ─────────────────
CREATE OR REPLACE FUNCTION public.trg_readonly_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.can_write() THEN
    RAISE EXCEPTION 'Your role is read-only - you cannot change %', replace(TG_TABLE_NAME, '_', ' ') USING ERRCODE = '42501';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

-- Exempt: the audit trail itself and a user's own profile row.
CREATE OR REPLACE FUNCTION public.attach_readonly_guard()
RETURNS int LANGUAGE plpgsql AS $$
DECLARE r record; n int := 0;
BEGIN
  FOR r IN
    SELECT c.table_name FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
     WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id'
       AND c.table_name NOT IN ('audit_logs', 'user_profiles')
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS a_readonly_guard ON public.%I', r.table_name);
    EXECUTE format('CREATE TRIGGER a_readonly_guard BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.trg_readonly_guard()', r.table_name);
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

SELECT public.attach_readonly_guard();

-- ─── 3. permission checks inside the posting / approval functions ──
DO $$
DECLARE
  r      record;
  def    text;
  newdef text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.post_sales_invoice(uuid)',                                                     'sales',      'post'),
    ('public.post_credit_note(uuid)',                                                       'sales',      'post'),
    ('public.post_farmer_sale(uuid)',                                                       'sales',      'post'),
    ('public.post_purchase_invoice(uuid)',                                                  'purchases',  'post'),
    ('public.rpc_post_payment_receipt(uuid,uuid,uuid,uuid,uuid)',                           'accounting', 'post'),
    ('public.rpc_post_journal_voucher(uuid,uuid,uuid)',                                     'accounting', 'post'),
    ('public.record_subsidy_receipt(uuid,numeric,date,uuid,text)',                          'accounting', 'post'),
    ('public.post_stock_adjustment(uuid,uuid,date,uuid,uuid,uuid,stock_adjustment_reason,numeric,text)', 'inventory', 'post'),
    ('public.approve_stock_transfer(uuid,text)',                                            'inventory',  'approve'),
    ('public.rpc_dispatch_stock_transfer(uuid,uuid,uuid)',                                  'inventory',  'post'),
    ('public.receive_stock_transfer(uuid,jsonb,text)',                                      'inventory',  'post'),
    ('public.record_cf_confirmation(uuid,uuid,uuid,numeric,text,text,date)',                'inventory',  'post'),
    ('public.issue_gate_pass(text,uuid,gate_pass_type_enum,text,text,text,integer,text,text)', 'inventory', 'create'),
    ('public.void_gate_pass(uuid,text)',                                                    'inventory',  'create'),
    ('public.cancel_farmer_sale(uuid,text)',                                                'fms',        'approve'),
    ('public.reissue_farmer_sale(uuid,text,text,numeric,numeric,numeric)',                  'fms',        'approve'),
    ('public.resolve_fms_reconciliation(uuid,text)',                                        'fms',        'approve'),
    ('public.run_fms_reconciliation(uuid,date,date,text,text,numeric,integer,numeric,text)', 'fms',       'import'),
    ('public.import_fms_data(uuid,text,text,date,date,jsonb)',                              'fms',        'import'),
    ('public.create_subsidy_claim(uuid,date,date,text,text)',                               'fms',        'approve'),
    ('public.submit_subsidy_claim(uuid,date,text)',                                         'fms',        'approve'),
    ('public.reject_subsidy_claim(uuid,text)',                                              'fms',        'approve'),
    ('public.cancel_subsidy_claim(uuid)',                                                   'fms',        'approve')
  ) AS t(sig, module, action)
  LOOP
    def := pg_get_functiondef(r.sig::regprocedure);
    IF def LIKE '%require_permission%' THEN CONTINUE; END IF;                    -- already patched (re-run)
    -- definitions may use CRLF or LF line endings (files edited on Windows): keep whichever the function uses
    newdef := regexp_replace(def, '(\r?\n)BEGIN(\r?\n)',
                             '\1BEGIN\2  PERFORM public.require_permission(''' || r.module || ''', ''' || r.action || ''');\2');
    IF newdef = def THEN RAISE EXCEPTION 'Could not insert the permission check into %', r.sig; END IF;
    EXECUTE newdef;
  END LOOP;
END $$;

-- ─── 4. complete the default matrix (existing tenants + onboard_tenant) ──
CREATE OR REPLACE FUNCTION public.apply_default_permission_extras(p_tenant_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- BRANCH_ADMIN: everything SUPER_ADMIN can do, except tenant-level administration and destructive/sensitive items
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT rb.id, rp.permission_id
    FROM roles rb
    JOIN roles rs ON rs.tenant_id = rb.tenant_id AND rs.name = 'SUPER_ADMIN'
    JOIN role_permissions rp ON rp.role_id = rs.id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE rb.tenant_id = p_tenant_id AND rb.name = 'BRANCH_ADMIN'
     AND p.module NOT IN ('admin_users', 'admin_periods', 'audit_log', 'farmer_kyc_sensitive')
     AND NOT (p.module = 'master_data' AND p.action = 'delete')
  ON CONFLICT DO NOTHING;

  -- ACCOUNTANT books supplier invoices
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT ra.id, p.id FROM roles ra, permissions p
   WHERE ra.tenant_id = p_tenant_id AND ra.name = 'ACCOUNTANT' AND p.module = 'purchases' AND p.action IN ('create', 'post')
  ON CONFLICT DO NOTHING;
END $$;

SELECT public.apply_default_permission_extras(id) FROM tenants;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'onboard_tenant_base') THEN
    ALTER FUNCTION public.onboard_tenant(uuid, text) RENAME TO onboard_tenant_base;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.onboard_tenant(p_tenant_id uuid, p_tenant_name text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.onboard_tenant_base(p_tenant_id, p_tenant_name);
  PERFORM public.apply_default_permission_extras(p_tenant_id);
END $$;
