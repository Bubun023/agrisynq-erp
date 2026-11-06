-- ============================================================
-- Migration 036: Integrity hardening
-- FertiLedger ERP
-- ============================================================
-- 1. Fix assert_period_not_locked() (020 called is_period_locked() with the
--    wrong argument list / types, so it could never run).
-- 2. Enforce FINANCIAL period locks at the database level on every posting
--    table, so no code path (app, RPC, SQL editor via RLS) can write into a
--    locked month.
-- 3. Restrict user_roles writes to tenant admins (004 let any tenant user
--    insert/update/delete role assignments).
-- Depends on: 004, 010, 020, 022, 024, 029, 030, 035.

-- ─── 1. Period-lock guard ─────────────────────────────────────
DROP FUNCTION IF EXISTS public.assert_period_not_locked(UUID, UUID, DATE, TEXT);

CREATE OR REPLACE FUNCTION public.assert_period_not_locked(
  p_tenant_id       UUID,
  p_organisation_id UUID,
  p_date            DATE,
  p_lock_type       period_lock_type_enum DEFAULT 'FINANCIAL',
  p_branch_id       UUID DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public AS $$
BEGIN
  IF p_date IS NOT NULL AND public.is_period_locked(
       p_tenant_id, p_organisation_id, p_branch_id, p_lock_type, p_date) THEN
    RAISE EXCEPTION 'Accounting period is locked for date % (%). Unlock it in Admin > Period Locks first.',
      p_date, p_lock_type
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

-- ─── 2. Generic enforcement trigger ───────────────────────────
-- TG_ARGV[0] = name of the document-date column.
-- INSERT: always checked.
-- UPDATE: checked only when the document date or status changes, so
--         unrelated updates (e.g. payment_status roll-ups on an old invoice)
--         are not blocked.
CREATE OR REPLACE FUNCTION public.trg_enforce_period_lock()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_new jsonb := to_jsonb(NEW);
  v_old jsonb;
  v_date date;
BEGIN
  v_date := (v_new ->> TG_ARGV[0])::date;

  IF TG_OP = 'UPDATE' THEN
    v_old := to_jsonb(OLD);
    IF (v_old ->> TG_ARGV[0]) IS NOT DISTINCT FROM (v_new ->> TG_ARGV[0])
       AND (v_old ->> 'status') IS NOT DISTINCT FROM (v_new ->> 'status') THEN
      RETURN NEW;
    END IF;
    -- Moving a document OUT of a locked month is also a change to that month.
    PERFORM public.assert_period_not_locked(
      (v_old ->> 'tenant_id')::uuid, (v_old ->> 'organisation_id')::uuid,
      (v_old ->> TG_ARGV[0])::date);
  END IF;

  PERFORM public.assert_period_not_locked(
    (v_new ->> 'tenant_id')::uuid, (v_new ->> 'organisation_id')::uuid, v_date);
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('journal_vouchers', 'voucher_date'),
      ('sales_invoices',   'invoice_date'),
      ('purchase_invoices','invoice_date'),
      ('payment_receipts', 'receipt_date'),
      ('credit_notes',     'credit_note_date'),
      ('stock_ledger',     'movement_date')
    ) AS t(tbl, col)
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS enforce_period_lock ON %I', r.tbl);
    EXECUTE format(
      'CREATE TRIGGER enforce_period_lock BEFORE INSERT OR UPDATE ON %I '
      'FOR EACH ROW EXECUTE FUNCTION public.trg_enforce_period_lock(%L)',
      r.tbl, r.col);
  END LOOP;
END $$;

-- ─── 3. user_roles: admins only may write ─────────────────────
DROP POLICY IF EXISTS "user_roles_tenant_isolation" ON user_roles;

CREATE POLICY "user_roles_tenant_select" ON user_roles
  FOR SELECT USING (tenant_id = public.get_tenant_id());

CREATE POLICY "user_roles_admin_insert" ON user_roles
  FOR INSERT WITH CHECK (tenant_id = public.get_tenant_id() AND public.is_tenant_admin());

CREATE POLICY "user_roles_admin_update" ON user_roles
  FOR UPDATE USING (tenant_id = public.get_tenant_id() AND public.is_tenant_admin());

CREATE POLICY "user_roles_admin_delete" ON user_roles
  FOR DELETE USING (tenant_id = public.get_tenant_id() AND public.is_tenant_admin());
