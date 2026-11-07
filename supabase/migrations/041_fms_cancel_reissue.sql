-- ============================================================
-- Migration 041: FMS cancel & reissue
-- FertiLedger ERP
-- ============================================================
-- cancel_farmer_sale():  cancels a farmer sale.
--   * pre-posting (POS_PENDING / POS_RECORDED): just marks it CANCELLED.
--   * POSTED: reverses the stock (FMS_RETURN / RETURN_FROM_SALE back to the original
--     location+batch) and posts a mirror-image journal, both dated TODAY so closed
--     periods are never rewritten. Sales whose subsidy is already claimed/received
--     cannot be cancelled here.
--   The cancelled row keeps its PoS transaction id, which the unique index (040)
--   therefore blocks from ever being reused.
-- reissue_farmer_sale(): cancels, then creates a replacement sale (status
--   POS_RECORDED, dated today) with a NEW PoS id and optional corrected qty/price/
--   subsidy; amounts are recomputed server-side. The replacement still has to be
--   posted through post_farmer_sale(), which re-checks stock and compliance.

ALTER TABLE farmer_sales
  ADD COLUMN IF NOT EXISTS cancelled_at         timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by         uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS cancellation_reason  text,
  ADD COLUMN IF NOT EXISTS reversal_journal_id  uuid REFERENCES journal_vouchers(id),
  ADD COLUMN IF NOT EXISTS reissued_from_id     uuid REFERENCES farmer_sales(id),
  ADD COLUMN IF NOT EXISTS reissued_as_id       uuid REFERENCES farmer_sales(id);

-- ─── cancel_farmer_sale ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cancel_farmer_sale(p_sale_id uuid, p_reason text)
RETURNS farmer_sales
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_tenant uuid := public.get_tenant_id();
  s        farmer_sales%ROWTYPE;
  v_jv     uuid;
  v_no     text;
  v_dr     numeric(18,2);
  v_cr     numeric(18,2);
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF COALESCE(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'A cancellation reason is required'; END IF;

  SELECT * INTO s FROM farmer_sales WHERE id = p_sale_id AND tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Farmer sale not found'; END IF;

  IF s.status IN ('CANCELLED') THEN RAISE EXCEPTION 'This sale is already cancelled'; END IF;
  IF s.status IN ('SUBSIDY_CLAIMED', 'SUBSIDY_RECEIVED') THEN
    RAISE EXCEPTION 'Subsidy for this sale is already % - it cannot be cancelled here', replace(lower(s.status::text), '_', ' ');
  END IF;
  IF s.status = 'DRAFT' OR s.status IN ('POS_PENDING', 'POS_RECORDED') THEN
    UPDATE farmer_sales SET status = 'CANCELLED', cancelled_at = now(), cancelled_by = auth.uid(),
           cancellation_reason = p_reason, updated_by = auth.uid()
     WHERE id = p_sale_id RETURNING * INTO s;
    RETURN s;
  END IF;

  -- POSTED: reverse stock
  PERFORM pg_advisory_xact_lock(hashtextextended('stock:' || v_tenant::text || ':' || s.product_id::text, 0));
  INSERT INTO stock_ledger (
    tenant_id, organisation_id, branch_id, movement_type, movement_date, product_id, batch_id,
    to_location_id, qty, unit_of_measure, rate_per_unit, gst_rate, gst_amount,
    source_document_type, source_document_id, source_document_no, narration, created_by)
  SELECT v_tenant, sl.organisation_id, sl.branch_id,
         CASE WHEN sl.movement_type = 'FMS_SUBSIDY_OUT' THEN 'FMS_RETURN' ELSE 'RETURN_FROM_SALE' END::stock_movement_type,
         CURRENT_DATE, sl.product_id, sl.batch_id, sl.from_location_id, sl.qty, sl.unit_of_measure,
         sl.rate_per_unit, sl.gst_rate, sl.gst_amount,
         'FARMER_SALE_CANCEL', p_sale_id, s.sale_number, 'Cancelled - ' || s.sale_number, auth.uid()
    FROM stock_ledger sl
   WHERE sl.tenant_id = v_tenant AND sl.source_document_type = 'FARMER_SALE'
     AND sl.source_document_id = p_sale_id AND NOT sl.is_reversal;
  IF NOT FOUND THEN RAISE EXCEPTION 'No stock movement found to reverse for %', s.sale_number; END IF;

  -- reverse journal (mirror image, dated today)
  IF s.journal_voucher_id IS NULL THEN RAISE EXCEPTION 'Sale % has no journal to reverse', s.sale_number; END IF;
  SELECT COALESCE(SUM(credit_amount), 0), COALESCE(SUM(debit_amount), 0) INTO v_dr, v_cr
    FROM journal_voucher_lines WHERE voucher_id = s.journal_voucher_id;
  v_no := 'RJ-' || to_char(CURRENT_DATE, 'YYYY') || '-' || lpad(nextval('auto_jv_seq')::text, 6, '0');
  INSERT INTO journal_vouchers (
    tenant_id, organisation_id, branch_id, voucher_no, voucher_date, voucher_type,
    reference_type, reference_id, narration, status, total_debit, total_credit,
    posted_at, posted_by, created_by, updated_by)
  VALUES (v_tenant, s.organisation_id, s.branch_id, v_no, CURRENT_DATE, 'SALES',
    'FARMER_SALE_CANCEL', p_sale_id, 'Reversal of farmer sale ' || s.sale_number || ': ' || p_reason,
    'POSTED', v_dr, v_cr, now(), auth.uid(), auth.uid(), auth.uid())
  RETURNING id INTO v_jv;
  INSERT INTO journal_voucher_lines (tenant_id, voucher_id, line_no, account_id, party_id, debit_amount, credit_amount, narration)
  SELECT v_tenant, v_jv, line_no, account_id, party_id, credit_amount, debit_amount, 'Reversal: ' || p_reason
    FROM journal_voucher_lines WHERE voucher_id = s.journal_voucher_id;

  UPDATE farmer_sales SET status = 'CANCELLED', cancelled_at = now(), cancelled_by = auth.uid(),
         cancellation_reason = p_reason, reversal_journal_id = v_jv, updated_by = auth.uid()
   WHERE id = p_sale_id RETURNING * INTO s;
  RETURN s;
END $$;

-- ─── reissue_farmer_sale ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reissue_farmer_sale(
  p_sale_id        uuid,
  p_reason         text,
  p_new_pos_id     text,
  p_qty            numeric DEFAULT NULL,
  p_selling_price  numeric DEFAULT NULL,
  p_subsidy_per_unit numeric DEFAULT NULL
) RETURNS farmer_sales
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_tenant uuid := public.get_tenant_id();
  o        farmer_sales%ROWTYPE;
  n        farmer_sales%ROWTYPE;
  v_qty    numeric(15,3);
  v_price  numeric(15,4);
  v_sub    numeric(15,4);
  v_gross  numeric(15,2);
  v_subtot numeric(15,2);
  v_pay    numeric(15,2);
  v_gst    numeric(15,2);
  v_net    numeric(15,2);
  v_cash   numeric(15,2);
  v_num    text;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF COALESCE(btrim(p_new_pos_id), '') = '' THEN RAISE EXCEPTION 'A new PoS transaction ID is required to reissue'; END IF;

  SELECT * INTO o FROM farmer_sales WHERE id = p_sale_id AND tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Farmer sale not found'; END IF;
  IF upper(btrim(p_new_pos_id)) = upper(btrim(COALESCE(o.pos_transaction_id, ''))) THEN
    RAISE EXCEPTION 'The new PoS transaction ID must differ from the cancelled one (old IDs can never be reused)';
  END IF;

  v_qty   := COALESCE(p_qty, o.qty_sold);
  v_price := COALESCE(p_selling_price, o.selling_price_per_unit);
  v_sub   := COALESCE(p_subsidy_per_unit, o.subsidy_per_unit);
  IF v_qty <= 0 THEN RAISE EXCEPTION 'Quantity must be positive'; END IF;
  IF v_price < 0 OR v_sub < 0 OR v_sub > v_price THEN
    RAISE EXCEPTION 'Selling price must be >= 0 and subsidy per unit must be between 0 and the selling price';
  END IF;

  o := public.cancel_farmer_sale(p_sale_id, p_reason);   -- reverses stock + journal when posted

  v_gross  := round(v_qty * v_price, 2);
  v_subtot := round(v_qty * v_sub, 2);
  v_pay    := v_gross - v_subtot;
  v_gst    := round(v_pay * o.gst_rate / 100, 2);
  v_net    := v_pay + v_gst;
  v_cash   := LEAST(o.cash_received, v_net);
  v_num    := public.generate_fs_number(v_tenant, o.organisation_id);

  INSERT INTO farmer_sales (
    tenant_id, organisation_id, branch_id, sale_number, sale_date, season, financial_year,
    farmer_id, farmer_aadhaar_last4, farmer_name, farmer_phone, sale_at_location, farmer_village, farmer_district,
    product_id, hsn_code, batch_id, batch_number, qty_sold, unit_of_measure, pack_size,
    mrp_per_unit, selling_price_per_unit, subsidy_per_unit,
    gross_amount, total_subsidy_amount, farmer_payable_amount, gst_rate, gst_amount, net_amount,
    cash_received, credit_amount, subsidy_type, subsidy_scheme, subsidy_rate_per_unit,
    fms_dealer_id, fms_product_code, pos_transaction_id, pos_recorded_at, pos_device_id,
    status, narration, reissued_from_id, created_by)
  VALUES (
    v_tenant, o.organisation_id, o.branch_id, v_num, CURRENT_DATE, o.season, o.financial_year,
    o.farmer_id, o.farmer_aadhaar_last4, o.farmer_name, o.farmer_phone, o.sale_at_location, o.farmer_village, o.farmer_district,
    o.product_id, o.hsn_code, o.batch_id, o.batch_number, v_qty, o.unit_of_measure, o.pack_size,
    o.mrp_per_unit, v_price, v_sub,
    v_gross, v_subtot, v_pay, o.gst_rate, v_gst, v_net,
    v_cash, v_net - v_cash, o.subsidy_type, o.subsidy_scheme, v_sub,
    o.fms_dealer_id, o.fms_product_code, btrim(p_new_pos_id), now(), o.pos_device_id,
    'POS_RECORDED', 'Reissue of ' || o.sale_number || ': ' || p_reason, p_sale_id, auth.uid())
  RETURNING * INTO n;

  UPDATE farmer_sales SET reissued_as_id = n.id WHERE id = p_sale_id;
  RETURN n;
END $$;

REVOKE ALL ON FUNCTION public.cancel_farmer_sale(uuid,text), public.reissue_farmer_sale(uuid,text,text,numeric,numeric,numeric)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_farmer_sale(uuid,text), public.reissue_farmer_sale(uuid,text,text,numeric,numeric,numeric)
  TO authenticated;

-- ─── Ledger view: cancelled rows get their own flag + reissue links ──
-- (new columns are appended: CREATE OR REPLACE VIEW cannot reorder existing ones)
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
    WHEN fs.status = 'CANCELLED'                                                         THEN 'CANCELLED'
    WHEN fs.subsidy_type <> 'NONE' AND COALESCE(trim(fs.pos_transaction_id), '') = '' THEN 'MISSING_POS'
    WHEN fs.status = 'POS_PENDING'                                                       THEN 'POS_PENDING'
    WHEN fs.fms_dealer_id IS NULL                                                         THEN 'NO_DEALER_ID'
    ELSE 'OK'
  END                    AS compliance_flag,
  fs.cancelled_at, fs.cancellation_reason, fs.reissued_from_id, fs.reissued_as_id,
  (SELECT r.sale_number FROM farmer_sales r WHERE r.id = fs.reissued_as_id)  AS reissued_as_number,
  (SELECT r.sale_number FROM farmer_sales r WHERE r.id = fs.reissued_from_id) AS reissued_from_number
FROM farmer_sales fs
JOIN products p ON p.id = fs.product_id
WHERE fs.status <> 'DRAFT' AND fs.is_active;
GRANT SELECT ON vw_fms_ledger TO authenticated;
