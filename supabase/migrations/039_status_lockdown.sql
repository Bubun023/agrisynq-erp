-- ============================================================
-- Migration 039: Status lock-down (RLS)
-- FertiLedger ERP
-- ============================================================
-- Goal: a user can create and edit DRAFT documents, but can never set or
-- change a document to POSTED themselves - only the posting functions
-- (038 / 037, SECURITY DEFINER) can. Posted documents are immutable to users.
--
-- Fixes:
--  * pi_draft_update / si_draft_update / cn_draft_update had only a USING
--    clause, so Postgres also required the NEW row to be DRAFT (a draft could
--    never become POSTED with user privileges) - and nothing stopped inserting
--    a row already marked POSTED.
--  * journal_vouchers, journal_voucher_lines, payment_receipts,
--    receipt_allocations had one FOR ALL policy: any user could edit or DELETE
--    posted vouchers/receipts. They also resolved the tenant via
--    "first user_roles row" instead of get_tenant_id().
--  * Line tables could be modified after the parent document was posted.

-- ─── Document headers ─────────────────────────────────────────
DROP POLICY IF EXISTS si_tenant_insert ON sales_invoices;
DROP POLICY IF EXISTS si_draft_update  ON sales_invoices;
CREATE POLICY si_tenant_insert ON sales_invoices FOR INSERT
  WITH CHECK (tenant_id = public.get_tenant_id() AND status = 'DRAFT');
CREATE POLICY si_draft_update ON sales_invoices FOR UPDATE
  USING      (tenant_id = public.get_tenant_id() AND status = 'DRAFT')
  WITH CHECK (tenant_id = public.get_tenant_id() AND status IN ('DRAFT', 'CANCELLED'));

DROP POLICY IF EXISTS pi_tenant_insert ON purchase_invoices;
DROP POLICY IF EXISTS pi_draft_update  ON purchase_invoices;
CREATE POLICY pi_tenant_insert ON purchase_invoices FOR INSERT
  WITH CHECK (tenant_id = public.get_tenant_id() AND status = 'DRAFT');
CREATE POLICY pi_draft_update ON purchase_invoices FOR UPDATE
  USING      (tenant_id = public.get_tenant_id() AND status = 'DRAFT')
  WITH CHECK (tenant_id = public.get_tenant_id() AND status IN ('DRAFT', 'CANCELLED'));

DROP POLICY IF EXISTS cn_tenant_insert ON credit_notes;
DROP POLICY IF EXISTS cn_draft_update  ON credit_notes;
CREATE POLICY cn_tenant_insert ON credit_notes FOR INSERT
  WITH CHECK (tenant_id = public.get_tenant_id() AND status = 'DRAFT');
CREATE POLICY cn_draft_update ON credit_notes FOR UPDATE
  USING      (tenant_id = public.get_tenant_id() AND status = 'DRAFT')
  WITH CHECK (tenant_id = public.get_tenant_id() AND status IN ('DRAFT', 'CANCELLED'));

-- ─── Journal vouchers (manual entries are drafts until rpc_post_journal_voucher) ──
DROP POLICY IF EXISTS tenant_jv  ON journal_vouchers;
DROP POLICY IF EXISTS tenant_jvl ON journal_voucher_lines;
CREATE POLICY jv_select ON journal_vouchers FOR SELECT USING (tenant_id = public.get_tenant_id());
CREATE POLICY jv_insert ON journal_vouchers FOR INSERT
  WITH CHECK (tenant_id = public.get_tenant_id() AND status = 'DRAFT');
CREATE POLICY jv_update ON journal_vouchers FOR UPDATE
  USING      (tenant_id = public.get_tenant_id() AND status = 'DRAFT')
  WITH CHECK (tenant_id = public.get_tenant_id() AND status IN ('DRAFT', 'CANCELLED'));
CREATE POLICY jv_delete ON journal_vouchers FOR DELETE
  USING (tenant_id = public.get_tenant_id() AND status = 'DRAFT');

CREATE POLICY jvl_select ON journal_voucher_lines FOR SELECT USING (tenant_id = public.get_tenant_id());
CREATE POLICY jvl_write ON journal_voucher_lines FOR ALL
  USING (tenant_id = public.get_tenant_id()
         AND EXISTS (SELECT 1 FROM journal_vouchers v WHERE v.id = voucher_id AND v.status = 'DRAFT'))
  WITH CHECK (tenant_id = public.get_tenant_id()
         AND EXISTS (SELECT 1 FROM journal_vouchers v WHERE v.id = voucher_id AND v.status = 'DRAFT'));

-- ─── Payment receipts ─────────────────────────────────────────
DROP POLICY IF EXISTS tenant_receipts    ON payment_receipts;
DROP POLICY IF EXISTS tenant_allocations ON receipt_allocations;
CREATE POLICY pr_select ON payment_receipts FOR SELECT USING (tenant_id = public.get_tenant_id());
CREATE POLICY pr_insert ON payment_receipts FOR INSERT
  WITH CHECK (tenant_id = public.get_tenant_id() AND status = 'DRAFT');
CREATE POLICY pr_update ON payment_receipts FOR UPDATE
  USING      (tenant_id = public.get_tenant_id() AND status = 'DRAFT')
  WITH CHECK (tenant_id = public.get_tenant_id() AND status IN ('DRAFT', 'CANCELLED'));
CREATE POLICY pr_delete ON payment_receipts FOR DELETE
  USING (tenant_id = public.get_tenant_id() AND status = 'DRAFT');

CREATE POLICY ra_select ON receipt_allocations FOR SELECT USING (tenant_id = public.get_tenant_id());
CREATE POLICY ra_write ON receipt_allocations FOR ALL
  USING (tenant_id = public.get_tenant_id()
         AND EXISTS (SELECT 1 FROM payment_receipts r WHERE r.id = receipt_id AND r.status = 'DRAFT'))
  WITH CHECK (tenant_id = public.get_tenant_id()
         AND EXISTS (SELECT 1 FROM payment_receipts r WHERE r.id = receipt_id AND r.status = 'DRAFT'));

-- ─── Line tables: only while the parent document is DRAFT ─────
DROP POLICY IF EXISTS sil_tenant_insert ON sales_invoice_lines;
CREATE POLICY sil_tenant_insert ON sales_invoice_lines FOR INSERT
  WITH CHECK (tenant_id = public.get_tenant_id()
              AND EXISTS (SELECT 1 FROM sales_invoices h WHERE h.id = invoice_id AND h.status = 'DRAFT'));

DROP POLICY IF EXISTS pil_tenant_insert ON purchase_invoice_lines;
DROP POLICY IF EXISTS pil_tenant_update ON purchase_invoice_lines;
CREATE POLICY pil_tenant_insert ON purchase_invoice_lines FOR INSERT
  WITH CHECK (tenant_id = public.get_tenant_id()
              AND EXISTS (SELECT 1 FROM purchase_invoices h WHERE h.id = invoice_id AND h.status = 'DRAFT'));
CREATE POLICY pil_tenant_update ON purchase_invoice_lines FOR UPDATE
  USING      (tenant_id = public.get_tenant_id()
              AND EXISTS (SELECT 1 FROM purchase_invoices h WHERE h.id = invoice_id AND h.status = 'DRAFT'))
  WITH CHECK (tenant_id = public.get_tenant_id());

DROP POLICY IF EXISTS cnl_tenant_insert ON credit_note_lines;
CREATE POLICY cnl_tenant_insert ON credit_note_lines FOR INSERT
  WITH CHECK (tenant_id = public.get_tenant_id()
              AND EXISTS (SELECT 1 FROM credit_notes h WHERE h.id = credit_note_id AND h.status = 'DRAFT'));
