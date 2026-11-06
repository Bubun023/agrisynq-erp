-- ============================================================
-- Migration 038: Atomic posting engine
-- FertiLedger ERP
-- ============================================================
-- Replaces the multi-call TypeScript posting code (which was non-atomic, wrote
-- invalid movement types / negative quantities, and created no accounting
-- entries) with single-transaction database functions:
--
--   post_sales_invoice(id)     stock out (SALE) + COGS + sales/GST journal
--   post_purchase_invoice(id)  batches + stock in (GRN) + purchase/ITC journal
--   post_credit_note(id)       optional stock return + reversal journal
--
-- Accounting model: perpetual inventory at batch cost.
--   Purchase : DR Stock-in-Hand (1020) + GST Input (4040-42)   CR Sundry Creditors (2001)
--   Sale     : DR Debtors (1010) / Cash (1001)  CR Sales (3001-3003) + GST Payable (2010-12)
--              DR Cost of goods (4001-4003)     CR Stock-in-Hand (1020)   [at batch cost]
-- Round-off / other charges on sales post to Other Income (3020).
-- The system chart of accounts must be seeded (Accounting > Chart of Accounts).
--
-- The post_* functions are SECURITY DEFINER so that users never need (or get)
-- permission to set a document's status to POSTED themselves (see 039): the
-- ONLY way a document becomes POSTED is through these functions. The tenant
-- always comes from the session (get_tenant_id()), never from a parameter, every
-- row touched is filtered by it, and every referenced master record (location,
-- party, product, batch) is verified to belong to that tenant. Period-lock
-- triggers (036) and table constraints still apply.

-- ─── Columns linking documents to their journal ───────────────
ALTER TABLE sales_invoices    ADD COLUMN IF NOT EXISTS journal_voucher_id uuid REFERENCES journal_vouchers(id);
ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS journal_voucher_id uuid REFERENCES journal_vouchers(id);
ALTER TABLE credit_notes      ADD COLUMN IF NOT EXISTS journal_voucher_id uuid REFERENCES journal_vouchers(id);

-- ─── Batch quantity is derived from the ledger ────────────────
-- Signed effect of a movement on a batch's TOTAL quantity. Transfers move stock
-- between locations (total unchanged) and manage their own destination batch in
-- 028, so they are excluded here.
CREATE OR REPLACE FUNCTION public.stock_batch_delta(p_type stock_movement_type, p_qty numeric)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_type IN ('GRN','OPENING','RETURN_FROM_SALE','ADJ_INCREASE','FMS_RETURN')                           THEN  p_qty
    WHEN p_type IN ('SALE','RETURN_TO_SUPPLIER','ADJ_DECREASE','EXPIRY_WRITE_OFF','DAMAGE_WRITE_OFF','FMS_SUBSIDY_OUT') THEN -p_qty
    ELSE 0 END
$$;

CREATE OR REPLACE FUNCTION public.trg_stock_ledger_batch_qty()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_delta numeric := public.stock_batch_delta(NEW.movement_type, NEW.qty);
BEGIN
  IF NEW.batch_id IS NULL OR NEW.is_reversal OR v_delta = 0 THEN
    RETURN NEW;
  END IF;
  UPDATE batch_register b SET
    current_qty = b.current_qty + v_delta,
    opening_qty = GREATEST(b.opening_qty, b.current_qty + v_delta),   -- keeps batch_qty_consistent
    status      = CASE WHEN b.status = 'CLOSED' AND b.current_qty + v_delta > 0 THEN 'OPEN'::batch_status_enum
                       ELSE b.status END
  WHERE b.id = NEW.batch_id AND b.tenant_id = NEW.tenant_id;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS stock_ledger_batch_qty ON stock_ledger;
CREATE TRIGGER stock_ledger_batch_qty
  AFTER INSERT ON stock_ledger
  FOR EACH ROW EXECUTE FUNCTION public.trg_stock_ledger_batch_qty();

-- ─── Helpers ──────────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS auto_jv_seq START 1;
GRANT USAGE ON SEQUENCE auto_jv_seq TO authenticated;

CREATE OR REPLACE FUNCTION public._sys_account(p_tenant uuid, p_code text)
RETURNS uuid LANGUAGE plpgsql STABLE AS $$
DECLARE v uuid;
BEGIN
  SELECT id INTO v FROM chart_of_accounts
   WHERE tenant_id = p_tenant AND account_code = p_code AND is_active;
  IF v IS NULL THEN
    RAISE EXCEPTION 'Chart of accounts is missing system account %. Seed the chart of accounts first (Accounting > Chart of Accounts).', p_code;
  END IF;
  RETURN v;
END $$;

-- product category -> (sales account, cost-of-goods account)
CREATE OR REPLACE FUNCTION public._category_accounts(p_cat product_category_enum)
RETURNS TABLE(sales_code text, cogs_code text) LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_cat = 'SEED' THEN '3002'
              WHEN p_cat IN ('PESTICIDE','WEEDICIDE','FUNGICIDE','INSECTICIDE','RODENTICIDE') THEN '3003'
              ELSE '3001' END,
         CASE WHEN p_cat = 'SEED' THEN '4002'
              WHEN p_cat IN ('PESTICIDE','WEEDICIDE','FUNGICIDE','INSECTICIDE','RODENTICIDE') THEN '4003'
              ELSE '4001' END
$$;

-- Creates a POSTED, balanced journal voucher. p_lines: [{"code":"1010","debit":n,"credit":n,"party":uuid|null}]
-- Zero lines are skipped; the voucher must have >= 2 lines and balance exactly.
CREATE OR REPLACE FUNCTION public._create_posted_jv(
  p_tenant uuid, p_org uuid, p_branch uuid, p_date date, p_type voucher_type_enum,
  p_ref_type text, p_ref_id uuid, p_narration text, p_lines jsonb
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  l          jsonb;
  v_dr       numeric(18,2) := 0;
  v_cr       numeric(18,2) := 0;
  v_n        int := 0;
  v_jv       uuid;
  v_no       text;
  v_prefix   text := CASE p_type WHEN 'SALES' THEN 'SJ' WHEN 'PURCHASE' THEN 'PJ'
                                 WHEN 'CREDIT_NOTE' THEN 'CJ' ELSE 'AJ' END;
BEGIN
  FOR l IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_dr := v_dr + round(COALESCE((l->>'debit')::numeric, 0), 2);
    v_cr := v_cr + round(COALESCE((l->>'credit')::numeric, 0), 2);
  END LOOP;
  IF v_dr <> v_cr THEN
    RAISE EXCEPTION 'Journal does not balance (debit %, credit %) for % %', v_dr, v_cr, p_ref_type, p_ref_id;
  END IF;

  v_no := v_prefix || '-' || to_char(p_date, 'YYYY') || '-' || lpad(nextval('auto_jv_seq')::text, 6, '0');
  INSERT INTO journal_vouchers (
    tenant_id, organisation_id, branch_id, voucher_no, voucher_date, voucher_type,
    reference_type, reference_id, narration, status, total_debit, total_credit,
    posted_at, posted_by, created_by, updated_by
  ) VALUES (
    p_tenant, p_org, p_branch, v_no, p_date, p_type,
    p_ref_type, p_ref_id, p_narration, 'POSTED', v_dr, v_cr,
    now(), auth.uid(), auth.uid(), auth.uid()
  ) RETURNING id INTO v_jv;

  FOR l IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    IF round(COALESCE((l->>'debit')::numeric, 0), 2) = 0
       AND round(COALESCE((l->>'credit')::numeric, 0), 2) = 0 THEN
      CONTINUE;
    END IF;
    v_n := v_n + 1;
    INSERT INTO journal_voucher_lines
      (tenant_id, voucher_id, line_no, account_id, party_id, debit_amount, credit_amount, narration)
    VALUES (p_tenant, v_jv, v_n, public._sys_account(p_tenant, l->>'code'),
            NULLIF(l->>'party', '')::uuid,
            round(COALESCE((l->>'debit')::numeric, 0), 2),
            round(COALESCE((l->>'credit')::numeric, 0), 2),
            p_narration);
  END LOOP;
  IF v_n < 2 THEN RAISE EXCEPTION 'A journal needs at least two non-zero lines'; END IF;
  RETURN v_jv;
END $$;

-- ─── post_sales_invoice ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.post_sales_invoice(p_invoice_id uuid)
RETURNS sales_invoices
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_tenant  uuid := public.get_tenant_id();
  v_inv     sales_invoices%ROWTYPE;
  r         record;
  b         batch_register%ROWTYPE;
  v_have    numeric;
  v_chk     numeric;
  v_jv      uuid;
  v_lines   jsonb := '[]'::jsonb;
  v_gst     numeric(18,2);
  v_diff    numeric(18,2);
  v_debit_code text;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT * INTO v_inv FROM sales_invoices WHERE id = p_invoice_id AND tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found'; END IF;
  IF v_inv.status <> 'DRAFT' THEN RAISE EXCEPTION 'Only DRAFT invoices can be posted (status: %)', v_inv.status; END IF;
  IF v_inv.from_location IS NULL THEN RAISE EXCEPTION 'Dispatch location is required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM sales_invoice_lines WHERE invoice_id = p_invoice_id) THEN
    RAISE EXCEPTION 'Invoice has no line items';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM locations WHERE id = v_inv.from_location AND tenant_id = v_tenant
                  AND organisation_id = v_inv.organisation_id) THEN
    RAISE EXCEPTION 'Dispatch location not found';
  END IF;
  IF v_inv.customer_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM parties WHERE id = v_inv.customer_id AND tenant_id = v_tenant) THEN
    RAISE EXCEPTION 'Customer not found';
  END IF;
  IF EXISTS (SELECT 1 FROM sales_invoice_lines l
               LEFT JOIN products p ON p.id = l.product_id AND p.tenant_id = v_tenant AND p.organisation_id = v_inv.organisation_id
              WHERE l.invoice_id = p_invoice_id AND p.id IS NULL) THEN
    RAISE EXCEPTION 'An invoice line references an unknown product';
  END IF;

  -- header totals must equal the lines (guards against drift)
  SELECT round(SUM(taxable_amount),2), round(SUM(COALESCE(cgst_amount,0)+COALESCE(sgst_amount,0)+COALESCE(igst_amount,0)),2)
    INTO v_chk, v_gst FROM sales_invoice_lines WHERE invoice_id = p_invoice_id;
  IF abs(v_chk - v_inv.taxable_amount) > 0.01
     OR abs(v_gst - (v_inv.cgst_amount + v_inv.sgst_amount + v_inv.igst_amount)) > 0.01 THEN
    RAISE EXCEPTION 'Invoice totals do not match its lines (taxable % vs %, GST % vs %)',
      v_inv.taxable_amount, v_chk, (v_inv.cgst_amount + v_inv.sgst_amount + v_inv.igst_amount), v_gst;
  END IF;

  -- Validate batches and stock, serialising per product so concurrent posts cannot oversell
  FOR r IN
    SELECT l.product_id, l.batch_id, SUM(l.qty + COALESCE(l.free_qty,0)) AS need,
           p.batch_required, p.name AS product_name
      FROM sales_invoice_lines l JOIN products p ON p.id = l.product_id
     WHERE l.invoice_id = p_invoice_id
     GROUP BY l.product_id, l.batch_id, p.batch_required, p.name
     ORDER BY l.product_id, l.batch_id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('stock:' || v_tenant::text || ':' || r.product_id::text, 0));
    IF r.batch_required AND r.batch_id IS NULL THEN
      RAISE EXCEPTION 'Batch is required for product "%"', r.product_name;
    END IF;
    IF r.batch_id IS NOT NULL THEN
      SELECT * INTO b FROM batch_register WHERE id = r.batch_id AND tenant_id = v_tenant AND product_id = r.product_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'Batch not found for product "%"', r.product_name; END IF;
      IF b.status IN ('QUARANTINE','EXPIRED','RECALLED') THEN
        RAISE EXCEPTION 'Batch % of "%" is % and cannot be sold', b.batch_number, r.product_name, b.status;
      END IF;
      IF b.expiry_date IS NOT NULL AND b.expiry_date < v_inv.invoice_date THEN
        RAISE EXCEPTION 'Batch % of "%" expired on %', b.batch_number, r.product_name, b.expiry_date;
      END IF;
    END IF;
    SELECT COALESCE(SUM(balance_qty), 0) INTO v_have FROM stock_balance
     WHERE tenant_id = v_tenant AND organisation_id = v_inv.organisation_id
       AND product_id = r.product_id AND location_id = v_inv.from_location
       AND batch_id IS NOT DISTINCT FROM r.batch_id;
    IF v_have < r.need THEN
      RAISE EXCEPTION 'Insufficient stock for "%": need %, available % at the dispatch location',
        r.product_name, r.need, v_have;
    END IF;
  END LOOP;

  -- Stock out
  INSERT INTO stock_ledger (
    tenant_id, organisation_id, branch_id, movement_type, movement_date, product_id, batch_id,
    from_location_id, party_id, qty, unit_of_measure, rate_per_unit, gst_rate, gst_amount,
    source_document_type, source_document_id, source_document_no, narration, created_by)
  SELECT v_tenant, v_inv.organisation_id, v_inv.branch_id, 'SALE', v_inv.invoice_date, l.product_id, l.batch_id,
         v_inv.from_location, v_inv.customer_id, l.qty + COALESCE(l.free_qty,0), l.unit_of_measure, l.unit_price,
         l.gst_rate, COALESCE(l.cgst_amount,0)+COALESCE(l.sgst_amount,0)+COALESCE(l.igst_amount,0),
         'SALES_INVOICE', p_invoice_id, v_inv.invoice_number, 'Sale - ' || v_inv.invoice_number, auth.uid()
    FROM sales_invoice_lines l WHERE l.invoice_id = p_invoice_id ORDER BY l.line_no;

  -- Journal: receivable/cash
  v_debit_code := CASE WHEN v_inv.sale_type = 'CASH' THEN '1001' ELSE '1010' END;
  v_lines := v_lines || jsonb_build_object('code', v_debit_code, 'debit', v_inv.net_receivable, 'party', v_inv.customer_id);

  -- Revenue by category
  FOR r IN
    SELECT (SELECT sales_code FROM _category_accounts(p.category)) AS code, SUM(l.taxable_amount) AS amt
      FROM sales_invoice_lines l JOIN products p ON p.id = l.product_id
     WHERE l.invoice_id = p_invoice_id GROUP BY 1
  LOOP
    v_lines := v_lines || jsonb_build_object('code', r.code, 'credit', r.amt);
  END LOOP;

  -- GST payable
  v_lines := v_lines
    || jsonb_build_object('code', '2010', 'credit', v_inv.cgst_amount)
    || jsonb_build_object('code', '2011', 'credit', v_inv.sgst_amount)
    || jsonb_build_object('code', '2012', 'credit', v_inv.igst_amount);

  -- Other charges / round-off to other income
  v_diff := v_inv.net_receivable - v_inv.taxable_amount - (v_inv.cgst_amount + v_inv.sgst_amount + v_inv.igst_amount);
  IF v_diff > 0 THEN v_lines := v_lines || jsonb_build_object('code', '3020', 'credit', v_diff);
  ELSIF v_diff < 0 THEN v_lines := v_lines || jsonb_build_object('code', '3020', 'debit', -v_diff);
  END IF;

  -- Cost of goods sold at batch cost: DR COGS, CR Stock
  FOR r IN
    SELECT (SELECT cogs_code FROM _category_accounts(p.category)) AS code,
           SUM((l.qty + COALESCE(l.free_qty,0)) *
               COALESCE(b2.landing_cost_per_unit, b2.purchase_rate, p.purchase_price, 0)) AS cost
      FROM sales_invoice_lines l
      JOIN products p ON p.id = l.product_id
      LEFT JOIN batch_register b2 ON b2.id = l.batch_id
     WHERE l.invoice_id = p_invoice_id GROUP BY 1
  LOOP
    IF round(r.cost, 2) > 0 THEN
      v_lines := v_lines || jsonb_build_object('code', r.code, 'debit', round(r.cost, 2))
                         || jsonb_build_object('code', '1020', 'credit', round(r.cost, 2));
    END IF;
  END LOOP;

  v_jv := public._create_posted_jv(v_tenant, v_inv.organisation_id, v_inv.branch_id, v_inv.invoice_date,
            'SALES', 'SALES_INVOICE', p_invoice_id, 'Sales invoice ' || v_inv.invoice_number, v_lines);

  UPDATE sales_invoices SET
    status = 'POSTED', posted_at = now(), posted_by = auth.uid(), journal_voucher_id = v_jv,
    amount_received = CASE WHEN v_inv.sale_type = 'CASH' THEN net_receivable ELSE amount_received END
  WHERE id = p_invoice_id
  RETURNING * INTO v_inv;
  RETURN v_inv;
END $$;

-- ─── post_purchase_invoice ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.post_purchase_invoice(p_invoice_id uuid)
RETURNS purchase_invoices
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_tenant   uuid := public.get_tenant_id();
  v_inv      purchase_invoices%ROWTYPE;
  l          record;
  v_batch    uuid;
  v_bno      text;
  v_total    numeric;
  v_alloc    numeric;
  v_cost     numeric;
  v_chk      numeric;
  v_gst      numeric(18,2);
  v_gsttot   numeric(18,2);
  v_jv       uuid;
  v_lines    jsonb := '[]'::jsonb;
  v_diff     numeric(18,2);
  v_cred     numeric(18,2);
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT * INTO v_inv FROM purchase_invoices WHERE id = p_invoice_id AND tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found'; END IF;
  IF v_inv.status <> 'DRAFT' THEN RAISE EXCEPTION 'Only DRAFT invoices can be posted (status: %)', v_inv.status; END IF;
  IF v_inv.received_at_location IS NULL THEN RAISE EXCEPTION 'Receiving location is required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM purchase_invoice_lines WHERE invoice_id = p_invoice_id) THEN
    RAISE EXCEPTION 'Invoice has no line items';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM locations WHERE id = v_inv.received_at_location AND tenant_id = v_tenant
                  AND organisation_id = v_inv.organisation_id) THEN
    RAISE EXCEPTION 'Receiving location not found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM parties WHERE id = v_inv.supplier_id AND tenant_id = v_tenant) THEN
    RAISE EXCEPTION 'Supplier not found';
  END IF;
  IF EXISTS (SELECT 1 FROM purchase_invoice_lines pl0
               LEFT JOIN products p ON p.id = pl0.product_id AND p.tenant_id = v_tenant AND p.organisation_id = v_inv.organisation_id
              WHERE pl0.invoice_id = p_invoice_id AND p.id IS NULL) THEN
    RAISE EXCEPTION 'An invoice line references an unknown product';
  END IF;

  SELECT round(SUM(taxable_amount),2), round(SUM(COALESCE(cgst_amount,0)+COALESCE(sgst_amount,0)+COALESCE(igst_amount,0)),2)
    INTO v_chk, v_gst FROM purchase_invoice_lines WHERE invoice_id = p_invoice_id;
  v_gsttot := v_inv.cgst_amount + v_inv.sgst_amount + v_inv.igst_amount;
  IF abs(v_chk - v_inv.taxable_amount) > 0.01 OR abs(v_gst - v_gsttot) > 0.01 THEN
    RAISE EXCEPTION 'Invoice totals do not match its lines (taxable % vs %, GST % vs %)',
      v_inv.taxable_amount, v_chk, v_gsttot, v_gst;
  END IF;

  FOR l IN
    SELECT pl.*, p.name AS product_name
      FROM purchase_invoice_lines pl JOIN products p ON p.id = pl.product_id
     WHERE pl.invoice_id = p_invoice_id ORDER BY pl.line_no
  LOOP
    v_total := l.received_qty + COALESCE(l.free_qty, 0);
    IF v_total <= 0 THEN RAISE EXCEPTION 'Line % has no quantity', l.line_no; END IF;
    -- landed cost per unit = (line taxable + pro-rated other charges) / (paid + free qty)
    v_alloc := CASE WHEN v_inv.taxable_amount > 0 THEN v_inv.other_charges * l.taxable_amount / v_inv.taxable_amount ELSE 0 END;
    v_cost  := round((l.taxable_amount + v_alloc) / v_total, 4);

    v_bno := COALESCE(NULLIF(trim(l.batch_number), ''), v_inv.invoice_number || '-L' || l.line_no);
    SELECT id INTO v_batch FROM batch_register
     WHERE tenant_id = v_tenant AND organisation_id = v_inv.organisation_id
       AND product_id = l.product_id AND batch_number = v_bno;

    IF v_batch IS NULL THEN
      INSERT INTO batch_register (
        tenant_id, organisation_id, branch_id, batch_number, product_id, supplier_id, purchase_invoice_id,
        location_id, opening_qty, current_qty, unit_of_measure, purchase_rate, purchase_rate_with_tax,
        landing_cost_per_unit, manufacture_date, expiry_date, status, created_by)
      VALUES (v_tenant, v_inv.organisation_id, v_inv.branch_id, v_bno, l.product_id, v_inv.supplier_id, p_invoice_id,
        v_inv.received_at_location, v_total, 0, l.unit_of_measure, l.unit_price,
        round((l.taxable_amount + COALESCE(l.cgst_amount,0)+COALESCE(l.sgst_amount,0)+COALESCE(l.igst_amount,0)) / v_total, 4),
        v_cost, l.manufacture_date, l.expiry_date, 'OPEN', auth.uid())
      RETURNING id INTO v_batch;
    ELSE
      IF (SELECT status FROM batch_register WHERE id = v_batch) = 'RECALLED' THEN
        RAISE EXCEPTION 'Batch % of "%" is RECALLED', v_bno, l.product_name;
      END IF;
    END IF;

    INSERT INTO stock_ledger (
      tenant_id, organisation_id, branch_id, movement_type, movement_date, product_id, batch_id,
      to_location_id, party_id, qty, unit_of_measure, rate_per_unit, gst_rate, gst_amount,
      source_document_type, source_document_id, source_document_no, narration, created_by)
    VALUES (v_tenant, v_inv.organisation_id, v_inv.branch_id, 'GRN', v_inv.invoice_date, l.product_id, v_batch,
      v_inv.received_at_location, v_inv.supplier_id, v_total, l.unit_of_measure, l.unit_price, l.gst_rate,
      COALESCE(l.cgst_amount,0)+COALESCE(l.sgst_amount,0)+COALESCE(l.igst_amount,0),
      'PURCHASE_INVOICE', p_invoice_id, v_inv.invoice_number, 'GRN - ' || v_inv.invoice_number, auth.uid());

    UPDATE purchase_invoice_lines SET batch_id = v_batch, landing_cost_per_unit = v_cost WHERE id = l.id;
  END LOOP;

  -- Journal. Under reverse charge the GST is owed by us (not payable to the supplier).
  v_cred := CASE WHEN v_inv.is_reverse_charge THEN v_inv.net_payable - v_gsttot ELSE v_inv.net_payable END;
  v_lines := v_lines
    || jsonb_build_object('code', '1020', 'debit', v_inv.taxable_amount + v_inv.other_charges)
    || jsonb_build_object('code', '4040', 'debit', v_inv.cgst_amount)
    || jsonb_build_object('code', '4041', 'debit', v_inv.sgst_amount)
    || jsonb_build_object('code', '4042', 'debit', v_inv.igst_amount)
    || jsonb_build_object('code', '2001', 'credit', v_cred, 'party', v_inv.supplier_id);
  IF v_inv.is_reverse_charge THEN
    v_lines := v_lines
      || jsonb_build_object('code', '2010', 'credit', v_inv.cgst_amount)
      || jsonb_build_object('code', '2011', 'credit', v_inv.sgst_amount)
      || jsonb_build_object('code', '2012', 'credit', v_inv.igst_amount);
  END IF;
  v_diff := (v_cred + CASE WHEN v_inv.is_reverse_charge THEN v_gsttot ELSE 0 END)
            - (v_inv.taxable_amount + v_inv.other_charges + v_gsttot);
  IF v_diff > 0 THEN v_lines := v_lines || jsonb_build_object('code', '3020', 'debit', v_diff);
  ELSIF v_diff < 0 THEN v_lines := v_lines || jsonb_build_object('code', '3020', 'credit', -v_diff);
  END IF;

  v_jv := public._create_posted_jv(v_tenant, v_inv.organisation_id, v_inv.branch_id, v_inv.invoice_date,
            'PURCHASE', 'PURCHASE_INVOICE', p_invoice_id, 'Purchase invoice ' || v_inv.invoice_number, v_lines);

  UPDATE purchase_invoices SET
    status = 'POSTED', posted_at = now(), posted_by = auth.uid(), updated_by = auth.uid(), journal_voucher_id = v_jv
  WHERE id = p_invoice_id RETURNING * INTO v_inv;
  RETURN v_inv;
END $$;

-- ─── post_credit_note ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.post_credit_note(p_cn_id uuid)
RETURNS credit_notes
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_tenant  uuid := public.get_tenant_id();
  cn        credit_notes%ROWTYPE;
  inv       sales_invoices%ROWTYPE;
  r         record;
  v_prior   numeric;
  v_orig    numeric;
  v_ret     numeric;
  v_gst     numeric(18,2);
  v_lines   jsonb := '[]'::jsonb;
  v_jv      uuid;
  v_apply   numeric(18,2);
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT * INTO cn FROM credit_notes WHERE id = p_cn_id AND tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Credit note not found'; END IF;
  IF cn.status <> 'DRAFT' THEN RAISE EXCEPTION 'Only DRAFT credit notes can be posted'; END IF;

  SELECT * INTO inv FROM sales_invoices WHERE id = cn.original_invoice_id AND tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND OR inv.status <> 'POSTED' THEN RAISE EXCEPTION 'Original invoice must be POSTED'; END IF;
  IF NOT EXISTS (SELECT 1 FROM credit_note_lines WHERE credit_note_id = p_cn_id) THEN
    RAISE EXCEPTION 'Credit note has no lines';
  END IF;

  IF EXISTS (SELECT 1 FROM credit_note_lines l
               LEFT JOIN products p ON p.id = l.product_id AND p.tenant_id = v_tenant AND p.organisation_id = cn.organisation_id
              WHERE l.credit_note_id = p_cn_id AND p.id IS NULL) THEN
    RAISE EXCEPTION 'A credit note line references an unknown product';
  END IF;
  IF cn.goods_returned AND cn.return_to_location IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM locations WHERE id = cn.return_to_location AND tenant_id = v_tenant AND organisation_id = cn.organisation_id) THEN
    RAISE EXCEPTION 'Return location not found';
  END IF;
  IF EXISTS (SELECT 1 FROM credit_note_lines l WHERE l.credit_note_id = p_cn_id AND l.batch_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM batch_register b WHERE b.id = l.batch_id AND b.tenant_id = v_tenant AND b.product_id = l.product_id)) THEN
    RAISE EXCEPTION 'A credit note line references an unknown batch';
  END IF;

  v_gst := cn.cgst_amount + cn.sgst_amount + cn.igst_amount;

  -- cumulative cap: total credited <= invoice value
  SELECT COALESCE(SUM(total_amount), 0) INTO v_prior FROM credit_notes
   WHERE original_invoice_id = inv.id AND status = 'POSTED' AND tenant_id = v_tenant;
  IF v_prior + cn.total_amount > inv.net_receivable + 0.01 THEN
    RAISE EXCEPTION 'Credit notes (% already + % this) would exceed invoice value %', v_prior, cn.total_amount, inv.net_receivable;
  END IF;

  -- per-line cap: cumulative returned qty <= originally sold qty
  FOR r IN SELECT * FROM credit_note_lines WHERE credit_note_id = p_cn_id AND original_line_id IS NOT NULL LOOP
    SELECT qty INTO v_orig FROM sales_invoice_lines WHERE id = r.original_line_id AND invoice_id = inv.id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Credit note line does not belong to the original invoice'; END IF;
    SELECT COALESCE(SUM(l2.return_qty), 0) INTO v_ret
      FROM credit_note_lines l2 JOIN credit_notes c2 ON c2.id = l2.credit_note_id
     WHERE l2.original_line_id = r.original_line_id AND c2.status = 'POSTED' AND c2.tenant_id = v_tenant;
    IF v_ret + r.return_qty > v_orig THEN
      RAISE EXCEPTION 'Returned quantity (% + %) exceeds sold quantity %', v_ret, r.return_qty, v_orig;
    END IF;
  END LOOP;

  -- Stock back in (and COGS reversal) when goods were physically returned
  IF cn.goods_returned THEN
    IF cn.return_to_location IS NULL THEN RAISE EXCEPTION 'Return location is required when goods are returned'; END IF;
    INSERT INTO stock_ledger (
      tenant_id, organisation_id, branch_id, movement_type, movement_date, product_id, batch_id,
      to_location_id, party_id, qty, unit_of_measure, rate_per_unit, gst_rate, gst_amount,
      source_document_type, source_document_id, source_document_no, narration, created_by)
    SELECT v_tenant, cn.organisation_id, cn.branch_id, 'RETURN_FROM_SALE', cn.credit_note_date, l.product_id, l.batch_id,
           cn.return_to_location, cn.customer_id, l.return_qty, l.unit_of_measure, l.unit_price, l.gst_rate,
           COALESCE(l.cgst_amount,0)+COALESCE(l.sgst_amount,0)+COALESCE(l.igst_amount,0),
           'CREDIT_NOTE', p_cn_id, cn.credit_note_number, 'Sales return - ' || cn.credit_note_number, auth.uid()
      FROM credit_note_lines l WHERE l.credit_note_id = p_cn_id;

    FOR r IN
      SELECT (SELECT cogs_code FROM _category_accounts(p.category)) AS code,
             SUM(l.return_qty * COALESCE(b.landing_cost_per_unit, b.purchase_rate, p.purchase_price, 0)) AS cost
        FROM credit_note_lines l JOIN products p ON p.id = l.product_id
        LEFT JOIN batch_register b ON b.id = l.batch_id
       WHERE l.credit_note_id = p_cn_id GROUP BY 1
    LOOP
      IF round(r.cost, 2) > 0 THEN
        v_lines := v_lines || jsonb_build_object('code', '1020', 'debit', round(r.cost, 2))
                           || jsonb_build_object('code', r.code, 'credit', round(r.cost, 2));
      END IF;
    END LOOP;
  END IF;

  -- Reverse revenue + GST, credit the customer
  FOR r IN
    SELECT (SELECT sales_code FROM _category_accounts(p.category)) AS code, SUM(l.taxable_amount) AS amt
      FROM credit_note_lines l JOIN products p ON p.id = l.product_id
     WHERE l.credit_note_id = p_cn_id GROUP BY 1
  LOOP
    v_lines := v_lines || jsonb_build_object('code', r.code, 'debit', r.amt);
  END LOOP;
  v_lines := v_lines
    || jsonb_build_object('code', '2010', 'debit', cn.cgst_amount)
    || jsonb_build_object('code', '2011', 'debit', cn.sgst_amount)
    || jsonb_build_object('code', '2012', 'debit', cn.igst_amount)
    || jsonb_build_object('code', '1010', 'credit', cn.total_amount, 'party', cn.customer_id);

  v_jv := public._create_posted_jv(v_tenant, cn.organisation_id, cn.branch_id, cn.credit_note_date,
            'CREDIT_NOTE', 'CREDIT_NOTE', p_cn_id, 'Credit note ' || cn.credit_note_number, v_lines);

  -- Settle the receivable with the credit (never beyond what is outstanding)
  v_apply := LEAST(cn.total_amount, inv.outstanding_amount);
  IF v_apply > 0 THEN
    UPDATE sales_invoices SET amount_received = amount_received + v_apply WHERE id = inv.id;
  END IF;

  UPDATE credit_notes SET status = 'POSTED', posted_at = now(), posted_by = auth.uid(), journal_voucher_id = v_jv
   WHERE id = p_cn_id RETURNING * INTO cn;
  RETURN cn;
END $$;

REVOKE ALL ON FUNCTION public.post_sales_invoice(uuid), public.post_purchase_invoice(uuid), public.post_credit_note(uuid),
                       public._create_posted_jv(uuid,uuid,uuid,date,voucher_type_enum,text,uuid,text,jsonb),
                       public._sys_account(uuid,text) FROM PUBLIC, anon, authenticated;
-- Only the three posting entry points are callable by users; the helpers are internal.
GRANT EXECUTE ON FUNCTION public.post_sales_invoice(uuid), public.post_purchase_invoice(uuid),
                          public.post_credit_note(uuid) TO authenticated;
