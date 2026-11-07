-- ============================================================
-- Migration 040: FMS engine (farmer-sale posting, ledger view, reconciliation)
-- FertiLedger ERP
-- ============================================================
-- 1. post_farmer_sale(): atomic posting (stock out + cost of goods + sales/GST/
--    subsidy-receivable journal). The old TypeScript used the invalid movement
--    type "DELIVERY", a negative quantity and the farmer id as stock_ledger.party_id
--    (an FK to parties), so no farmer sale could ever be posted.
-- 2. RLS: users may only create/edit pre-posting farmer sales; only the posting
--    function can set POSTED.
-- 3. vw_fms_ledger: portal-ready view of FMS-relevant sales with a compliance flag.
-- 4. run_fms_reconciliation() / resolve_fms_reconciliation().
--
-- Journal for a farmer sale (gross = qty x selling price, payable = gross - subsidy):
--   DR Cash (cash_received)  DR Debtors (credit_amount)  DR Subsidy Receivable (subsidy)
--   CR Sales (gross)         CR CGST/SGST Payable (gst)
--   DR COGS / CR Stock at batch cost
-- (credit given to a farmer is booked on Debtors without a party: farmers are not
--  parties, the per-farmer credit stays on farmer_sales.credit_amount)

ALTER TABLE farmer_sales ADD COLUMN IF NOT EXISTS journal_voucher_id uuid REFERENCES journal_vouchers(id);

-- Subsidy Receivable account for tenants whose chart is already seeded
INSERT INTO chart_of_accounts (tenant_id, organisation_id, account_code, account_name, account_type, account_group,
                               is_control_account, opening_balance, opening_balance_type, is_system)
SELECT d.tenant_id, d.organisation_id, '1040', 'Subsidy Receivable (Govt)', 'ASSET', 'Current Assets', false, 0, 'DR', true
  FROM chart_of_accounts d
 WHERE d.account_code = '1010'
   AND NOT EXISTS (SELECT 1 FROM chart_of_accounts x WHERE x.tenant_id = d.tenant_id AND x.account_code = '1040');

-- Duplicate-subsidy protection: 026's pos_tx_unique was DEFERRABLE INITIALLY DEFERRED
-- (checked only at commit) and case/whitespace sensitive. Replace with an immediate,
-- normalised unique index so a PoS transaction id can never be reused.
ALTER TABLE farmer_sales DROP CONSTRAINT IF EXISTS pos_tx_unique;
CREATE UNIQUE INDEX IF NOT EXISTS uq_fs_pos_tx_norm
  ON farmer_sales (tenant_id, upper(btrim(pos_transaction_id)))
  WHERE pos_transaction_id IS NOT NULL AND btrim(pos_transaction_id) <> '';

-- Period lock on sale date
DROP TRIGGER IF EXISTS enforce_period_lock ON farmer_sales;
CREATE TRIGGER enforce_period_lock BEFORE INSERT OR UPDATE ON farmer_sales
  FOR EACH ROW EXECUTE FUNCTION public.trg_enforce_period_lock('sale_date');

-- ─── RLS: users cannot self-post ──────────────────────────────
DROP POLICY IF EXISTS fs_tenant_insert ON farmer_sales;
DROP POLICY IF EXISTS fs_draft_update  ON farmer_sales;
CREATE POLICY fs_tenant_insert ON farmer_sales FOR INSERT
  WITH CHECK (tenant_id = public.get_tenant_id() AND status IN ('DRAFT', 'POS_PENDING', 'POS_RECORDED'));
CREATE POLICY fs_draft_update ON farmer_sales FOR UPDATE
  USING      (tenant_id = public.get_tenant_id() AND status IN ('DRAFT', 'POS_PENDING', 'POS_RECORDED'))
  WITH CHECK (tenant_id = public.get_tenant_id() AND status IN ('DRAFT', 'POS_PENDING', 'POS_RECORDED', 'CANCELLED'));

-- ─── post_farmer_sale ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.post_farmer_sale(p_sale_id uuid)
RETURNS farmer_sales
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_tenant uuid := public.get_tenant_id();
  s        farmer_sales%ROWTYPE;
  p        products%ROWTYPE;
  b        batch_register%ROWTYPE;
  v_have   numeric;
  v_cost   numeric(18,2);
  v_cgst   numeric(18,2);
  v_sgst   numeric(18,2);
  v_lines  jsonb := '[]'::jsonb;
  v_jv     uuid;
  v_codes  record;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT * INTO s FROM farmer_sales WHERE id = p_sale_id AND tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Farmer sale not found'; END IF;
  IF s.status NOT IN ('POS_PENDING', 'POS_RECORDED') THEN
    RAISE EXCEPTION 'Only POS_PENDING or POS_RECORDED sales can be posted (status: %)', s.status;
  END IF;

  -- Compliance: a subsidised sale without a PoS transaction is non-compliant
  IF s.subsidy_type <> 'NONE' AND COALESCE(trim(s.pos_transaction_id), '') = '' THEN
    RAISE EXCEPTION 'A subsidised sale needs a PoS transaction ID before it can be posted';
  END IF;
  IF s.subsidy_type = 'NONE' AND s.total_subsidy_amount > 0 THEN
    RAISE EXCEPTION 'Subsidy amount given but subsidy type is NONE';
  END IF;

  -- Ownership of referenced records
  IF NOT EXISTS (SELECT 1 FROM farmers WHERE id = s.farmer_id AND tenant_id = v_tenant) THEN
    RAISE EXCEPTION 'Farmer not found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM locations WHERE id = s.sale_at_location AND tenant_id = v_tenant
                  AND organisation_id = s.organisation_id) THEN
    RAISE EXCEPTION 'Sale location not found';
  END IF;
  SELECT * INTO p FROM products WHERE id = s.product_id AND tenant_id = v_tenant AND organisation_id = s.organisation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;

  IF p.batch_required AND s.batch_id IS NULL THEN
    RAISE EXCEPTION 'Batch is required for product "%"', p.name;
  END IF;
  IF s.batch_id IS NOT NULL THEN
    SELECT * INTO b FROM batch_register WHERE id = s.batch_id AND tenant_id = v_tenant AND product_id = s.product_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Batch not found for product "%"', p.name; END IF;
    IF b.status IN ('QUARANTINE', 'EXPIRED', 'RECALLED') THEN
      RAISE EXCEPTION 'Batch % is % and cannot be sold', b.batch_number, b.status;
    END IF;
    IF b.expiry_date IS NOT NULL AND b.expiry_date < s.sale_date THEN
      RAISE EXCEPTION 'Batch % expired on %', b.batch_number, b.expiry_date;
    END IF;
  END IF;

  -- Stock (serialised per product so concurrent sales cannot oversell)
  PERFORM pg_advisory_xact_lock(hashtextextended('stock:' || v_tenant::text || ':' || s.product_id::text, 0));
  SELECT COALESCE(SUM(balance_qty), 0) INTO v_have FROM stock_balance
   WHERE tenant_id = v_tenant AND organisation_id = s.organisation_id AND product_id = s.product_id
     AND location_id = s.sale_at_location AND batch_id IS NOT DISTINCT FROM s.batch_id;
  IF v_have < s.qty_sold THEN
    RAISE EXCEPTION 'Insufficient stock for "%": need %, available % at the sale location', p.name, s.qty_sold, v_have;
  END IF;

  -- Amounts must be internally consistent (guards against client-side tampering)
  IF abs(s.gross_amount - round(s.qty_sold * s.selling_price_per_unit, 2)) > 0.02
     OR abs(s.total_subsidy_amount - round(s.qty_sold * s.subsidy_per_unit, 2)) > 0.02
     OR abs(s.net_amount - (s.farmer_payable_amount + s.gst_amount)) > 0.02 THEN
    RAISE EXCEPTION 'Sale amounts are inconsistent with quantity and price';
  END IF;
  IF s.cash_received + s.credit_amount <> s.net_amount THEN
    RAISE EXCEPTION 'Cash received + credit (% + %) must equal the amount payable (%)', s.cash_received, s.credit_amount, s.net_amount;
  END IF;

  INSERT INTO stock_ledger (
    tenant_id, organisation_id, branch_id, movement_type, movement_date, product_id, batch_id,
    from_location_id, qty, unit_of_measure, rate_per_unit, gst_rate, gst_amount,
    source_document_type, source_document_id, source_document_no, fms_transaction_id, subsidy_amount, narration, created_by)
  VALUES (v_tenant, s.organisation_id, s.branch_id,
    CASE WHEN s.subsidy_type <> 'NONE' THEN 'FMS_SUBSIDY_OUT' ELSE 'SALE' END::stock_movement_type,
    s.sale_date, s.product_id, s.batch_id, s.sale_at_location, s.qty_sold, s.unit_of_measure,
    s.selling_price_per_unit, s.gst_rate, s.gst_amount,
    'FARMER_SALE', p_sale_id, s.sale_number, s.pos_transaction_id, s.total_subsidy_amount,
    'Farmer sale - ' || s.sale_number, auth.uid());

  -- Journal
  v_cgst := round(s.gst_amount / 2, 2);
  v_sgst := s.gst_amount - v_cgst;
  SELECT * INTO v_codes FROM _category_accounts(p.category);
  v_cost := round(s.qty_sold * COALESCE(b.landing_cost_per_unit, b.purchase_rate, p.purchase_price, 0), 2);

  v_lines := v_lines
    || jsonb_build_object('code', '1001', 'debit', s.cash_received)
    || jsonb_build_object('code', '1010', 'debit', s.credit_amount)
    || jsonb_build_object('code', '1040', 'debit', s.total_subsidy_amount)
    || jsonb_build_object('code', v_codes.sales_code, 'credit', s.gross_amount)
    || jsonb_build_object('code', '2010', 'credit', v_cgst)
    || jsonb_build_object('code', '2011', 'credit', v_sgst);
  IF v_cost > 0 THEN
    v_lines := v_lines || jsonb_build_object('code', v_codes.cogs_code, 'debit', v_cost)
                       || jsonb_build_object('code', '1020', 'credit', v_cost);
  END IF;

  v_jv := public._create_posted_jv(v_tenant, s.organisation_id, s.branch_id, s.sale_date, 'SALES',
            'FARMER_SALE', p_sale_id, 'Farmer sale ' || s.sale_number, v_lines);

  UPDATE farmer_sales SET status = 'POSTED', posted_at = now(), posted_by = auth.uid(),
         journal_voucher_id = v_jv, updated_by = auth.uid()
   WHERE id = p_sale_id RETURNING * INTO s;
  RETURN s;
END $$;

REVOKE ALL ON FUNCTION public.post_farmer_sale(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_farmer_sale(uuid) TO authenticated;

-- ─── FMS ledger view (portal-ready) ───────────────────────────
CREATE OR REPLACE VIEW vw_fms_ledger WITH (security_invoker = true) AS
SELECT
  fs.id, fs.tenant_id, fs.organisation_id,
  fs.sale_number, fs.sale_date, fs.season, fs.financial_year,
  fs.farmer_name, fs.farmer_aadhaar_last4, fs.farmer_phone, fs.farmer_village, fs.farmer_district,
  p.name                 AS product_name,
  p.product_code,
  fs.fms_product_code,
  fs.hsn_code, fs.batch_number,
  fs.qty_sold, fs.unit_of_measure,
  fs.selling_price_per_unit, fs.subsidy_per_unit, fs.total_subsidy_amount,
  fs.farmer_payable_amount, fs.gst_amount, fs.net_amount,
  fs.subsidy_type::text  AS subsidy_type,
  fs.pos_transaction_id, fs.pos_device_id, fs.fms_dealer_id, fs.fms_acknowledgement_no,
  fs.status::text        AS status,
  CASE
    WHEN fs.subsidy_type <> 'NONE' AND COALESCE(trim(fs.pos_transaction_id), '') = '' THEN 'MISSING_POS'
    WHEN fs.status = 'POS_PENDING'                                                       THEN 'POS_PENDING'
    WHEN fs.fms_dealer_id IS NULL                                                         THEN 'NO_DEALER_ID'
    ELSE 'OK'
  END                    AS compliance_flag
FROM farmer_sales fs
JOIN products p ON p.id = fs.product_id
WHERE fs.status <> 'DRAFT' AND fs.is_active;
GRANT SELECT ON vw_fms_ledger TO authenticated;

-- ─── Reconciliation ───────────────────────────────────────────
-- Compares the figures downloaded from the FMS/iFMS portal with the system's
-- finalised farmer sales for the same dealer / period (/ product).
CREATE OR REPLACE FUNCTION public.run_fms_reconciliation(
  p_organisation_id uuid,
  p_period_from     date,
  p_period_to       date,
  p_dealer_id       text,
  p_product_code    text,
  p_fms_qty         numeric,
  p_fms_txns        int,
  p_fms_subsidy     numeric,
  p_remarks         text DEFAULT NULL
) RETURNS fms_reconciliation
LANGUAGE plpgsql AS $$
DECLARE
  v_tenant uuid := public.get_tenant_id();
  v_qty    numeric;
  v_txns   int;
  v_sub    numeric;
  r        fms_reconciliation%ROWTYPE;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_period_to < p_period_from THEN RAISE EXCEPTION 'Period end is before period start'; END IF;
  IF COALESCE(trim(p_dealer_id), '') = '' THEN RAISE EXCEPTION 'FMS dealer ID is required'; END IF;

  SELECT COALESCE(SUM(qty_sold), 0), COUNT(*), COALESCE(SUM(total_subsidy_amount), 0)
    INTO v_qty, v_txns, v_sub
    FROM farmer_sales
   WHERE tenant_id = v_tenant AND organisation_id = p_organisation_id
     AND fms_dealer_id = p_dealer_id
     AND (p_product_code IS NULL OR p_product_code = '' OR fms_product_code = p_product_code)
     AND sale_date BETWEEN p_period_from AND p_period_to
     AND status IN ('POSTED', 'SUBSIDY_CLAIMED', 'SUBSIDY_RECEIVED');

  INSERT INTO fms_reconciliation (
    tenant_id, organisation_id, period_from, period_to, fms_dealer_id, fms_product_code,
    fms_total_qty, fms_total_transactions, fms_total_subsidy,
    system_total_qty, system_total_transactions, system_total_subsidy,
    reconciliation_status, remarks, created_by)
  VALUES (
    v_tenant, p_organisation_id, p_period_from, p_period_to, p_dealer_id, NULLIF(p_product_code, ''),
    p_fms_qty, p_fms_txns, p_fms_subsidy, v_qty, v_txns, v_sub,
    CASE WHEN p_fms_qty = v_qty AND p_fms_txns = v_txns AND p_fms_subsidy = v_sub THEN 'MATCHED' ELSE 'VARIANCE' END,
    p_remarks, auth.uid())
  RETURNING * INTO r;
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION public.resolve_fms_reconciliation(p_id uuid, p_remarks text)
RETURNS fms_reconciliation
LANGUAGE plpgsql AS $$
DECLARE r fms_reconciliation%ROWTYPE;
BEGIN
  IF COALESCE(trim(p_remarks), '') = '' THEN RAISE EXCEPTION 'Resolution remarks are required'; END IF;
  UPDATE fms_reconciliation SET reconciliation_status = 'RESOLVED', remarks = p_remarks,
         resolved_by = auth.uid(), resolved_at = now()
   WHERE id = p_id AND tenant_id = public.get_tenant_id() AND reconciliation_status IN ('VARIANCE', 'PENDING')
   RETURNING * INTO r;
  IF NOT FOUND THEN RAISE EXCEPTION 'Reconciliation not found or not awaiting resolution'; END IF;
  RETURN r;
END $$;

GRANT EXECUTE ON FUNCTION public.run_fms_reconciliation(uuid,date,date,text,text,numeric,int,numeric,text),
                          public.resolve_fms_reconciliation(uuid,text) TO authenticated;
