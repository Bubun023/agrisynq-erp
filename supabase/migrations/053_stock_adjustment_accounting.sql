-- 053: stock adjustments now post to the books.
-- Until now post_stock_adjustment moved stock (damage, expiry, recount) but never touched the ledger, so account 1020
-- Stock in Hand drifted away from the stock sub-ledger (found by the stock-valuation report tying out to the books).
--   decrease (damage / expiry / shortage / recount down):  DR 4050 Transit Loss / Stock Shortage   CR 1020 Stock in Hand
--   increase (recount up / found stock):                   DR 1020 Stock in Hand                   CR 3020 Other Income
-- valued at the batch's landed cost (product purchase price when the adjustment has no batch). Now SECURITY DEFINER
-- like the other posting functions, with the permission check re-applied (049 patches it into the function top).

ALTER TABLE stock_adjustments ADD COLUMN IF NOT EXISTS journal_voucher_id uuid REFERENCES journal_vouchers(id);
ALTER TABLE stock_adjustments ADD COLUMN IF NOT EXISTS unit_cost numeric(15,4);

CREATE OR REPLACE FUNCTION public.post_stock_adjustment(
  p_organisation_id uuid,
  p_branch_id       uuid,
  p_date            date,
  p_product_id      uuid,
  p_batch_id        uuid,
  p_location_id     uuid,
  p_reason          stock_adjustment_reason,
  p_qty_adjustment  numeric,
  p_notes           text DEFAULT NULL
)
RETURNS stock_adjustments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant   uuid := public.get_tenant_id();
  v_uom      text;
  v_before   numeric(15,3);
  v_after    numeric(15,3);
  v_seq      int;
  v_type     stock_movement_type;
  v_ledger   uuid;
  v_row      stock_adjustments;
  v_cost     numeric(15,4);
  v_value    numeric(15,2);
  v_no       text;
  v_jv       uuid;
BEGIN
  PERFORM public.require_permission('inventory', 'post');
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_qty_adjustment IS NULL OR p_qty_adjustment = 0 THEN
    RAISE EXCEPTION 'Adjustment quantity must be non-zero';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('stock_adj:' || p_organisation_id::text, 0));

  SELECT unit_of_measure, COALESCE(purchase_price, 0) INTO v_uom, v_cost
    FROM products WHERE id = p_product_id AND tenant_id = v_tenant AND organisation_id = p_organisation_id;
  IF v_uom IS NULL THEN RAISE EXCEPTION 'Product not found'; END IF;

  PERFORM 1 FROM locations WHERE id = p_location_id AND tenant_id = v_tenant AND organisation_id = p_organisation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Location not found'; END IF;

  IF p_batch_id IS NOT NULL THEN
    SELECT COALESCE(landing_cost_per_unit, purchase_rate, v_cost) INTO v_cost
      FROM batch_register WHERE id = p_batch_id AND tenant_id = v_tenant AND product_id = p_product_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Batch does not belong to this product'; END IF;
  END IF;

  SELECT COALESCE(SUM(balance_qty), 0) INTO v_before
    FROM stock_balance
   WHERE tenant_id = v_tenant AND organisation_id = p_organisation_id
     AND product_id = p_product_id
     AND location_id = p_location_id
     AND batch_id IS NOT DISTINCT FROM p_batch_id;

  v_after := v_before + p_qty_adjustment;
  IF v_after < 0 THEN
    RAISE EXCEPTION 'Adjustment would make stock negative (%). Current stock: %', v_after, v_before;
  END IF;

  v_type := CASE
    WHEN p_qty_adjustment > 0 THEN 'ADJ_INCREASE'
    WHEN p_reason = 'EXPIRY'  THEN 'EXPIRY_WRITE_OFF'
    WHEN p_reason = 'DAMAGE'  THEN 'DAMAGE_WRITE_OFF'
    ELSE 'ADJ_DECREASE'
  END;

  SELECT COALESCE(MAX(NULLIF(regexp_replace(adjustment_no, '\D', '', 'g'), '')::int), 0) + 1
    INTO v_seq FROM stock_adjustments WHERE organisation_id = p_organisation_id;
  v_no := 'ADJ-' || lpad(v_seq::text, 5, '0');

  INSERT INTO stock_ledger (
    tenant_id, organisation_id, branch_id, movement_type, movement_date,
    product_id, batch_id, from_location_id, to_location_id,
    qty, unit_of_measure, rate_per_unit, source_document_type, source_document_no, narration, created_by
  ) VALUES (
    v_tenant, p_organisation_id, p_branch_id, v_type, p_date,
    p_product_id, p_batch_id,
    CASE WHEN p_qty_adjustment < 0 THEN p_location_id END,
    CASE WHEN p_qty_adjustment > 0 THEN p_location_id END,
    abs(p_qty_adjustment), v_uom, v_cost, 'STOCK_ADJUSTMENT', v_no,
    COALESCE(p_notes, p_reason::text), auth.uid()
  ) RETURNING id INTO v_ledger;

  v_value := round(abs(p_qty_adjustment) * v_cost, 2);
  IF v_value > 0 THEN
    v_jv := public._create_posted_jv(v_tenant, p_organisation_id, p_branch_id, p_date, 'JOURNAL', 'STOCK_ADJUSTMENT', v_ledger,
              'Stock adjustment ' || v_no || ' (' || p_reason::text || ')',
              CASE WHEN p_qty_adjustment < 0
                   THEN jsonb_build_array(jsonb_build_object('code', '4050', 'debit', v_value), jsonb_build_object('code', '1020', 'credit', v_value))
                   ELSE jsonb_build_array(jsonb_build_object('code', '1020', 'debit', v_value), jsonb_build_object('code', '3020', 'credit', v_value)) END);
  END IF;

  INSERT INTO stock_adjustments (
    tenant_id, organisation_id, branch_id, adjustment_no, adjustment_date,
    product_id, batch_id, location_id, reason,
    qty_before, qty_adjustment, qty_after, unit_of_measure, ledger_entry_id, notes, created_by, journal_voucher_id, unit_cost
  ) VALUES (
    v_tenant, p_organisation_id, p_branch_id, v_no, p_date,
    p_product_id, p_batch_id, p_location_id, p_reason,
    v_before, p_qty_adjustment, v_after, v_uom, v_ledger, p_notes, auth.uid(), v_jv, v_cost
  ) RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.post_stock_adjustment(uuid,uuid,date,uuid,uuid,uuid,stock_adjustment_reason,numeric,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_stock_adjustment(uuid,uuid,date,uuid,uuid,uuid,stock_adjustment_reason,numeric,text) TO authenticated;

-- Bring existing data in line: adjustments already posted before this migration get their missing journal.
-- (Stock itself is untouched - only the books catch up. A row whose period is locked or whose accounts are missing is
--  skipped with a notice so the migration can never fail on old data.)
DO $$
DECLARE r record; v_cost numeric(15,4); v_value numeric(15,2); v_jv uuid;
BEGIN
  FOR r IN SELECT sa.*, sl.rate_per_unit AS led_rate FROM stock_adjustments sa JOIN stock_ledger sl ON sl.id = sa.ledger_entry_id
            WHERE sa.journal_voucher_id IS NULL ORDER BY sa.created_at LOOP
    BEGIN
      SELECT COALESCE(b.landing_cost_per_unit, b.purchase_rate, p.purchase_price, 0) INTO v_cost
        FROM products p LEFT JOIN batch_register b ON b.id = r.batch_id WHERE p.id = r.product_id;
      v_value := round(abs(r.qty_adjustment) * COALESCE(v_cost, 0), 2);
      IF v_value > 0 THEN
        v_jv := public._create_posted_jv(r.tenant_id, r.organisation_id, r.branch_id, r.adjustment_date, 'JOURNAL', 'STOCK_ADJUSTMENT', r.ledger_entry_id,
                  'Stock adjustment ' || r.adjustment_no || ' (' || r.reason::text || ') - brought into the books',
                  CASE WHEN r.qty_adjustment < 0
                       THEN jsonb_build_array(jsonb_build_object('code', '4050', 'debit', v_value), jsonb_build_object('code', '1020', 'credit', v_value))
                       ELSE jsonb_build_array(jsonb_build_object('code', '1020', 'debit', v_value), jsonb_build_object('code', '3020', 'credit', v_value)) END);
        UPDATE stock_adjustments SET journal_voucher_id = v_jv, unit_cost = v_cost WHERE id = r.id;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Stock adjustment % not posted to the books: %', r.adjustment_no, SQLERRM;
    END;
  END LOOP;
END $$;
