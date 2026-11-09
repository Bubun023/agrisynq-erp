-- ============================================================
-- Migration 047: Memo purchases, supplier-invoice matching, stock journal
-- FertiLedger ERP
-- ============================================================
-- Business case: a co-distributor physically supplies product A but bills product B later
-- (or bills late at all). Until the invoice arrives the goods are received on a MEMO.
--
--  post_memo_purchase        stock in at cost = rate less discount (percent, then flat), NO GST;
--                            journal DR Stock (1020) / CR Goods Received - Invoice Pending (2005, per supplier).
--  settle_memo_with_invoice  the supplier's invoice (posted normally, as billed) is matched to memo lines:
--                            clears 2005 at memo cost, takes the memo stock back out of the ledger for the
--                            part still on hand, and for the part already SOLD books the invoice-vs-memo
--                            cost difference to cost of goods and takes the invoice's stock out instead.
--  post_stock_journal        value-preserving stock out / stock in (e.g. out B as billed, in A as received).
--                            No GL entry: stock value moves between batches, the Stock account does not change.
--  close_memo_units          goods that will never be billed: RETURN to the supplier, or WAIVED (supplier
--                            waives the bill: liability released to Other Income).
-- Posting / settling / journalling is restricted to admin & accountant roles (memo receipt also stock manager).
-- All writes go through these SECURITY DEFINER functions; users have read-only table access.

-- ─── role helper ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.has_any_role(p_roles text[])
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                  WHERE ur.user_id = auth.uid() AND r.name = ANY (p_roles))
$$;
GRANT EXECUTE ON FUNCTION public.has_any_role(text[]) TO authenticated;

-- ─── liability account: Goods Received - Invoice Pending ──────
INSERT INTO chart_of_accounts (tenant_id, organisation_id, account_code, account_name, account_type, account_group,
                               is_control_account, opening_balance, opening_balance_type, is_system)
SELECT d.tenant_id, d.organisation_id, '2005', 'Goods Received - Invoice Pending', 'LIABILITY', 'Current Liabilities', false, 0, 'CR', true
  FROM chart_of_accounts d
 WHERE d.account_code = '1010'
   AND NOT EXISTS (SELECT 1 FROM chart_of_accounts x WHERE x.tenant_id = d.tenant_id AND x.account_code = '2005');

-- ─── tables ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS memo_purchases (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id),
  organisation_id       uuid NOT NULL REFERENCES organisations(id),
  branch_id             uuid REFERENCES branches(id),
  memo_no               text NOT NULL,
  memo_date             date NOT NULL DEFAULT CURRENT_DATE,
  supplier_id           uuid NOT NULL REFERENCES parties(id),
  received_at_location  uuid NOT NULL REFERENCES locations(id),
  supplier_ref          text NOT NULL CHECK (btrim(supplier_ref) <> ''),     -- supplier's challan / delivery note no
  narration             text,
  status                text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'POSTED', 'CANCELLED')),
  total_value           numeric(15,2) NOT NULL DEFAULT 0,
  journal_voucher_id    uuid REFERENCES journal_vouchers(id),
  posted_at             timestamptz,
  posted_by             uuid REFERENCES auth.users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid REFERENCES auth.users(id),
  UNIQUE (tenant_id, organisation_id, memo_no)
);

CREATE TABLE IF NOT EXISTS memo_purchase_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  memo_id           uuid NOT NULL REFERENCES memo_purchases(id) ON DELETE CASCADE,
  line_no           int NOT NULL,
  product_id        uuid NOT NULL REFERENCES products(id),
  batch_number      text,
  manufacture_date  date,
  expiry_date       date,
  qty               numeric(15,3) NOT NULL CHECK (qty > 0),
  free_qty          numeric(15,3) NOT NULL DEFAULT 0 CHECK (free_qty >= 0),
  unit_of_measure   text NOT NULL,
  rate              numeric(15,4) NOT NULL CHECK (rate >= 0),
  discount_percent  numeric(7,4) NOT NULL DEFAULT 0 CHECK (discount_percent BETWEEN 0 AND 100),
  discount_amount   numeric(15,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),   -- flat, applied after the percentage
  net_amount        numeric(15,2),                 -- set at posting: qty x rate less discounts (no GST)
  unit_cost         numeric(15,4),                 -- net_amount / (qty + free_qty)
  batch_id          uuid REFERENCES batch_register(id),
  total_units       numeric(15,3) GENERATED ALWAYS AS (qty + free_qty) STORED,
  settled_units     numeric(15,3) NOT NULL DEFAULT 0,
  returned_units    numeric(15,3) NOT NULL DEFAULT 0,
  waived_units      numeric(15,3) NOT NULL DEFAULT 0,
  pending_units     numeric(15,3) GENERATED ALWAYS AS (qty + free_qty - settled_units - returned_units - waived_units) STORED,
  CHECK (settled_units >= 0 AND returned_units >= 0 AND waived_units >= 0),
  CHECK (qty + free_qty - settled_units - returned_units - waived_units >= 0),
  UNIQUE (memo_id, line_no)
);

CREATE TABLE IF NOT EXISTS memo_settlements (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id),
  organisation_id       uuid NOT NULL REFERENCES organisations(id),
  memo_id               uuid NOT NULL REFERENCES memo_purchases(id),
  purchase_invoice_id   uuid NOT NULL REFERENCES purchase_invoices(id),
  settled_on            date NOT NULL DEFAULT CURRENT_DATE,
  notes                 text,
  journal_voucher_id    uuid REFERENCES journal_vouchers(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid REFERENCES auth.users(id)
);

CREATE TABLE IF NOT EXISTS memo_settlement_lines (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  settlement_id       uuid NOT NULL REFERENCES memo_settlements(id) ON DELETE CASCADE,
  memo_line_id        uuid NOT NULL REFERENCES memo_purchase_lines(id),
  invoice_line_id     uuid NOT NULL REFERENCES purchase_invoice_lines(id),
  units               numeric(15,3) NOT NULL CHECK (units > 0),
  units_on_hand       numeric(15,3) NOT NULL,       -- memo stock taken back out of the ledger
  units_sold          numeric(15,3) NOT NULL,       -- already gone: cost difference to COGS
  memo_unit_cost      numeric(15,4) NOT NULL,
  invoice_unit_cost   numeric(15,4) NOT NULL
);

CREATE TABLE IF NOT EXISTS memo_closures (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  organisation_id     uuid NOT NULL REFERENCES organisations(id),
  memo_line_id        uuid NOT NULL REFERENCES memo_purchase_lines(id),
  mode                text NOT NULL CHECK (mode IN ('RETURN', 'WAIVED')),
  units               numeric(15,3) NOT NULL CHECK (units > 0),
  unit_cost           numeric(15,4) NOT NULL,
  reason              text NOT NULL CHECK (btrim(reason) <> ''),
  journal_voucher_id  uuid REFERENCES journal_vouchers(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid REFERENCES auth.users(id)
);

CREATE TABLE IF NOT EXISTS stock_journals (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id),
  organisation_id       uuid NOT NULL REFERENCES organisations(id),
  branch_id             uuid REFERENCES branches(id),
  journal_no            text NOT NULL,
  journal_date          date NOT NULL,
  location_id           uuid NOT NULL REFERENCES locations(id),
  reason                text NOT NULL CHECK (btrim(reason) <> ''),
  memo_settlement_id    uuid REFERENCES memo_settlements(id),
  purchase_invoice_id   uuid REFERENCES purchase_invoices(id),
  total_value           numeric(15,2) NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid REFERENCES auth.users(id),
  UNIQUE (tenant_id, organisation_id, journal_no)
);

CREATE TABLE IF NOT EXISTS stock_journal_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  journal_id    uuid NOT NULL REFERENCES stock_journals(id) ON DELETE CASCADE,
  direction     text NOT NULL CHECK (direction IN ('OUT', 'IN')),
  product_id    uuid NOT NULL REFERENCES products(id),
  batch_id      uuid NOT NULL REFERENCES batch_register(id),
  qty           numeric(15,3) NOT NULL CHECK (qty > 0),
  unit_cost     numeric(15,4) NOT NULL,
  value         numeric(15,2) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memo_lines_pending ON memo_purchase_lines(memo_id) WHERE pending_units > 0;
CREATE INDEX IF NOT EXISTS idx_memo_supplier ON memo_purchases(organisation_id, supplier_id, status);
CREATE INDEX IF NOT EXISTS idx_msl_invoice_line ON memo_settlement_lines(invoice_line_id);

-- ─── RLS: users read; create/edit DRAFT memos only; everything else via functions ──
ALTER TABLE memo_purchases        ENABLE ROW LEVEL SECURITY;
ALTER TABLE memo_purchase_lines   ENABLE ROW LEVEL SECURITY;
ALTER TABLE memo_settlements      ENABLE ROW LEVEL SECURITY;
ALTER TABLE memo_settlement_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE memo_closures         ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_journals        ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_journal_lines   ENABLE ROW LEVEL SECURITY;

CREATE POLICY mp_select  ON memo_purchases FOR SELECT USING (tenant_id = public.get_tenant_id());
CREATE POLICY mp_insert  ON memo_purchases FOR INSERT WITH CHECK (tenant_id = public.get_tenant_id() AND status = 'DRAFT');
CREATE POLICY mp_update  ON memo_purchases FOR UPDATE
  USING (tenant_id = public.get_tenant_id() AND status = 'DRAFT')
  WITH CHECK (tenant_id = public.get_tenant_id() AND status IN ('DRAFT', 'CANCELLED'));
CREATE POLICY mpl_select ON memo_purchase_lines FOR SELECT USING (tenant_id = public.get_tenant_id());
CREATE POLICY mpl_insert ON memo_purchase_lines FOR INSERT
  WITH CHECK (tenant_id = public.get_tenant_id() AND settled_units = 0 AND returned_units = 0 AND waived_units = 0
              AND batch_id IS NULL AND net_amount IS NULL AND unit_cost IS NULL
              AND EXISTS (SELECT 1 FROM memo_purchases h WHERE h.id = memo_id AND h.status = 'DRAFT'));
CREATE POLICY mpl_update ON memo_purchase_lines FOR UPDATE
  USING (tenant_id = public.get_tenant_id() AND EXISTS (SELECT 1 FROM memo_purchases h WHERE h.id = memo_id AND h.status = 'DRAFT'))
  WITH CHECK (tenant_id = public.get_tenant_id() AND settled_units = 0 AND returned_units = 0 AND waived_units = 0
              AND batch_id IS NULL AND net_amount IS NULL AND unit_cost IS NULL);
CREATE POLICY mpl_delete ON memo_purchase_lines FOR DELETE
  USING (tenant_id = public.get_tenant_id() AND EXISTS (SELECT 1 FROM memo_purchases h WHERE h.id = memo_id AND h.status = 'DRAFT'));
CREATE POLICY ms_select  ON memo_settlements      FOR SELECT USING (tenant_id = public.get_tenant_id());
CREATE POLICY msl_select ON memo_settlement_lines FOR SELECT USING (tenant_id = public.get_tenant_id());
CREATE POLICY mc_select  ON memo_closures         FOR SELECT USING (tenant_id = public.get_tenant_id());
CREATE POLICY sj_select  ON stock_journals        FOR SELECT USING (tenant_id = public.get_tenant_id());
CREATE POLICY sjl_select ON stock_journal_lines   FOR SELECT USING (tenant_id = public.get_tenant_id());

REVOKE ALL ON memo_settlements, memo_settlement_lines, memo_closures, stock_journals, stock_journal_lines FROM anon, authenticated;
GRANT SELECT ON memo_settlements, memo_settlement_lines, memo_closures, stock_journals, stock_journal_lines TO authenticated;
REVOKE DELETE ON memo_purchases FROM authenticated;

-- ─── post_memo_purchase ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.post_memo_purchase(p_memo_id uuid)
RETURNS memo_purchases
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_tenant uuid := public.get_tenant_id();
  m        memo_purchases%ROWTYPE;
  l        record;
  v_net    numeric(15,2);
  v_total  numeric(15,2) := 0;
  v_cost   numeric(15,4);
  v_batch  uuid;
  v_bno    text;
  v_jv     uuid;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.has_any_role(ARRAY['SUPER_ADMIN', 'BRANCH_ADMIN', 'ACCOUNTANT', 'STOCK_MANAGER']) THEN
    RAISE EXCEPTION 'Only an admin, accountant or stock manager can post a memo purchase' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO m FROM memo_purchases WHERE id = p_memo_id AND tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Memo purchase not found'; END IF;
  IF m.status <> 'DRAFT' THEN RAISE EXCEPTION 'Only DRAFT memos can be posted (status: %)', m.status; END IF;
  IF NOT EXISTS (SELECT 1 FROM memo_purchase_lines WHERE memo_id = p_memo_id) THEN RAISE EXCEPTION 'Memo has no lines'; END IF;
  IF NOT EXISTS (SELECT 1 FROM parties WHERE id = m.supplier_id AND tenant_id = v_tenant) THEN RAISE EXCEPTION 'Supplier not found'; END IF;
  IF NOT EXISTS (SELECT 1 FROM locations WHERE id = m.received_at_location AND tenant_id = v_tenant AND organisation_id = m.organisation_id) THEN
    RAISE EXCEPTION 'Receiving location not found';
  END IF;
  IF EXISTS (SELECT 1 FROM memo_purchase_lines ml LEFT JOIN products p ON p.id = ml.product_id AND p.tenant_id = v_tenant AND p.organisation_id = m.organisation_id
              WHERE ml.memo_id = p_memo_id AND p.id IS NULL) THEN
    RAISE EXCEPTION 'A memo line references an unknown product';
  END IF;
  PERFORM public.assert_period_not_locked(v_tenant, m.organisation_id, m.memo_date);

  FOR l IN SELECT * FROM memo_purchase_lines WHERE memo_id = p_memo_id ORDER BY line_no LOOP
    -- cost = rate less percentage discount, then less flat discount; GST is never part of a memo
    v_net := round(l.qty * l.rate * (1 - l.discount_percent / 100) - l.discount_amount, 2);
    IF v_net < 0 THEN RAISE EXCEPTION 'Line %: the discount is larger than the value of the goods', l.line_no; END IF;
    v_cost := round(v_net / (l.qty + l.free_qty), 4);

    v_bno := COALESCE(NULLIF(btrim(l.batch_number), ''), m.memo_no || '-L' || l.line_no);
    IF EXISTS (SELECT 1 FROM batch_register WHERE tenant_id = v_tenant AND organisation_id = m.organisation_id
                AND product_id = l.product_id AND batch_number = v_bno) THEN
      RAISE EXCEPTION 'Line %: batch % already exists for this product - memo goods always start a new batch', l.line_no, v_bno;
    END IF;

    INSERT INTO batch_register (tenant_id, organisation_id, branch_id, batch_number, product_id, supplier_id, location_id,
                                opening_qty, current_qty, unit_of_measure, purchase_rate, purchase_rate_with_tax, landing_cost_per_unit,
                                manufacture_date, expiry_date, status, created_by)
    VALUES (v_tenant, m.organisation_id, m.branch_id, v_bno, l.product_id, m.supplier_id, m.received_at_location,
            l.qty + l.free_qty, 0, l.unit_of_measure, l.rate, v_cost, v_cost, l.manufacture_date, l.expiry_date, 'OPEN', auth.uid())
    RETURNING id INTO v_batch;

    INSERT INTO stock_ledger (tenant_id, organisation_id, branch_id, movement_type, movement_date, product_id, batch_id, to_location_id,
                              party_id, qty, unit_of_measure, rate_per_unit, source_document_type, source_document_id, source_document_no,
                              narration, created_by)
    VALUES (v_tenant, m.organisation_id, m.branch_id, 'GRN', m.memo_date, l.product_id, v_batch, m.received_at_location,
            m.supplier_id, l.qty + l.free_qty, l.unit_of_measure, v_cost, 'MEMO_PURCHASE', m.id, m.memo_no,
            'Memo receipt - ' || m.memo_no || ' (supplier ref ' || m.supplier_ref || ')', auth.uid());

    UPDATE memo_purchase_lines SET net_amount = v_net, unit_cost = v_cost, batch_id = v_batch WHERE id = l.id;
    v_total := v_total + v_net;
  END LOOP;

  IF v_total > 0 THEN
    v_jv := public._create_posted_jv(v_tenant, m.organisation_id, m.branch_id, m.memo_date, 'PURCHASE', 'MEMO_PURCHASE', m.id,
              'Memo purchase ' || m.memo_no || ' - invoice pending',
              jsonb_build_array(jsonb_build_object('code', '1020', 'debit', v_total),
                                jsonb_build_object('code', '2005', 'credit', v_total, 'party', m.supplier_id)));
  END IF;

  UPDATE memo_purchases SET status = 'POSTED', total_value = v_total, journal_voucher_id = v_jv, posted_at = now(), posted_by = auth.uid()
   WHERE id = p_memo_id RETURNING * INTO m;
  RETURN m;
END $$;

-- ─── settle_memo_with_invoice ─────────────────────────────────
-- p_lines: [{"memo_line_id":"..","invoice_line_id":"..","units":n}]
CREATE OR REPLACE FUNCTION public.settle_memo_with_invoice(p_memo_id uuid, p_invoice_id uuid, p_lines jsonb, p_notes text DEFAULT NULL)
RETURNS memo_settlements
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_tenant uuid := public.get_tenant_id();
  m        memo_purchases%ROWTYPE;
  inv      purchase_invoices%ROWTYPE;
  s        memo_settlements%ROWTYPE;
  e        jsonb;
  ml       memo_purchase_lines%ROWTYPE;
  il       purchase_invoice_lines%ROWTYPE;
  p        products%ROWTYPE;
  v_units  numeric;
  v_used   numeric;
  v_bal_loc numeric;
  v_bal_tot numeric;
  v_hand   numeric;
  v_sold   numeric;
  v_inv_bal numeric;
  v_cm     numeric;
  v_ci     numeric;
  v_d2005  numeric(15,2);
  v_cr1020 numeric(15,2);
  v_cogs   numeric(15,2);
  v_codes  record;
  v_lines  jsonb := '[]'::jsonb;
  v_jv     uuid;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.has_any_role(ARRAY['SUPER_ADMIN', 'BRANCH_ADMIN', 'ACCOUNTANT']) THEN
    RAISE EXCEPTION 'Only an admin or accountant can match a memo to an invoice' USING ERRCODE = '42501';
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'Choose at least one memo line to match';
  END IF;

  SELECT * INTO m FROM memo_purchases WHERE id = p_memo_id AND tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Memo purchase not found'; END IF;
  IF m.status <> 'POSTED' THEN RAISE EXCEPTION 'Only a posted memo can be matched (status: %)', m.status; END IF;
  SELECT * INTO inv FROM purchase_invoices WHERE id = p_invoice_id AND tenant_id = v_tenant AND organisation_id = m.organisation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Purchase invoice not found'; END IF;
  IF inv.status <> 'POSTED' THEN RAISE EXCEPTION 'The supplier invoice must be posted first (status: %)', inv.status; END IF;
  IF inv.supplier_id IS DISTINCT FROM m.supplier_id THEN RAISE EXCEPTION 'The invoice is from a different supplier than the memo'; END IF;
  PERFORM public.assert_period_not_locked(v_tenant, m.organisation_id, CURRENT_DATE);

  INSERT INTO memo_settlements (tenant_id, organisation_id, memo_id, purchase_invoice_id, notes, created_by)
  VALUES (v_tenant, m.organisation_id, p_memo_id, p_invoice_id, NULLIF(btrim(p_notes), ''), auth.uid())
  RETURNING * INTO s;

  FOR e IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    SELECT * INTO ml FROM memo_purchase_lines WHERE id = (e->>'memo_line_id')::uuid AND memo_id = p_memo_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'A selected line does not belong to this memo'; END IF;
    SELECT * INTO il FROM purchase_invoice_lines WHERE id = (e->>'invoice_line_id')::uuid AND invoice_id = p_invoice_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'A selected line does not belong to this invoice'; END IF;
    v_units := (e->>'units')::numeric;
    IF v_units IS NULL OR v_units <= 0 THEN RAISE EXCEPTION 'Units to match must be positive'; END IF;
    IF v_units > ml.pending_units THEN
      RAISE EXCEPTION 'Memo line % has only % unit(s) still pending (tried to match %)', ml.line_no, ml.pending_units, v_units;
    END IF;
    SELECT COALESCE(SUM(units), 0) INTO v_used FROM memo_settlement_lines WHERE invoice_line_id = il.id;
    IF v_used + v_units > il.received_qty + COALESCE(il.free_qty, 0) THEN
      RAISE EXCEPTION 'Invoice line % has only % unit(s) not yet matched to a memo', il.line_no, il.received_qty + COALESCE(il.free_qty, 0) - v_used;
    END IF;
    v_cm := ml.unit_cost;
    v_ci := il.landing_cost_per_unit;
    IF v_ci IS NULL THEN RAISE EXCEPTION 'Invoice line % has no cost - was the invoice posted?', il.line_no; END IF;
    SELECT * INTO p FROM products WHERE id = ml.product_id;
    SELECT * INTO v_codes FROM _category_accounts(p.category);

    PERFORM pg_advisory_xact_lock(hashtextextended('stock:' || v_tenant::text || ':' || ml.product_id::text, 0));
    SELECT COALESCE(SUM(balance_qty), 0) INTO v_bal_loc FROM stock_balance
     WHERE tenant_id = v_tenant AND batch_id = ml.batch_id AND location_id = m.received_at_location;
    SELECT COALESCE(SUM(balance_qty), 0) INTO v_bal_tot FROM stock_balance WHERE tenant_id = v_tenant AND batch_id = ml.batch_id;
    v_hand := LEAST(v_units, GREATEST(v_bal_loc, 0));
    v_sold := v_units - v_hand;
    IF v_sold > 0 AND v_bal_tot > v_bal_loc THEN
      RAISE EXCEPTION 'Part of memo batch % is at another location - transfer it back to the receiving location before matching', ml.batch_id;
    END IF;

    -- memo stock still on hand goes back out of the ledger at memo cost
    IF v_hand > 0 THEN
      INSERT INTO stock_ledger (tenant_id, organisation_id, branch_id, movement_type, movement_date, product_id, batch_id, from_location_id,
                                qty, unit_of_measure, rate_per_unit, source_document_type, source_document_id, source_document_no, narration, created_by)
      VALUES (v_tenant, m.organisation_id, m.branch_id, 'ADJ_DECREASE', CURRENT_DATE, ml.product_id, ml.batch_id, m.received_at_location,
              v_hand, ml.unit_of_measure, v_cm, 'MEMO_SETTLEMENT', s.id, m.memo_no,
              'Memo ' || m.memo_no || ' matched to invoice ' || inv.invoice_number, auth.uid());
    END IF;
    -- already sold: the invoice's own stock for those units must go out as well (it was billed for goods that left earlier)
    IF v_sold > 0 THEN
      IF il.batch_id IS NULL THEN RAISE EXCEPTION 'Invoice line % has no batch', il.line_no; END IF;
      SELECT COALESCE(SUM(balance_qty), 0) INTO v_inv_bal FROM stock_balance
       WHERE tenant_id = v_tenant AND batch_id = il.batch_id AND location_id = inv.received_at_location;
      IF v_inv_bal < v_sold THEN
        RAISE EXCEPTION 'Invoice stock for line % is no longer available to offset the % unit(s) already sold', il.line_no, v_sold;
      END IF;
      INSERT INTO stock_ledger (tenant_id, organisation_id, branch_id, movement_type, movement_date, product_id, batch_id, from_location_id,
                                qty, unit_of_measure, rate_per_unit, source_document_type, source_document_id, source_document_no, narration, created_by)
      VALUES (v_tenant, m.organisation_id, m.branch_id, 'ADJ_DECREASE', CURRENT_DATE, il.product_id, il.batch_id, inv.received_at_location,
              v_sold, il.unit_of_measure, v_ci, 'MEMO_SETTLEMENT', s.id, inv.invoice_number,
              'Units of memo ' || m.memo_no || ' already sold - invoice stock offset', auth.uid());
    END IF;

    v_d2005  := round(v_units * v_cm, 2);
    v_cr1020 := round(v_hand * v_cm, 2) + round(v_sold * v_ci, 2);
    v_cogs   := v_cr1020 - v_d2005;           -- debit (positive) when the invoice cost is higher than the memo cost on sold units
    v_lines := v_lines || jsonb_build_object('code', '2005', 'debit', v_d2005, 'party', m.supplier_id)
                       || jsonb_build_object('code', '1020', 'credit', v_cr1020);
    IF v_cogs > 0 THEN v_lines := v_lines || jsonb_build_object('code', v_codes.cogs_code, 'debit', v_cogs);
    ELSIF v_cogs < 0 THEN v_lines := v_lines || jsonb_build_object('code', v_codes.cogs_code, 'credit', -v_cogs);
    END IF;

    UPDATE memo_purchase_lines SET settled_units = settled_units + v_units WHERE id = ml.id;
    INSERT INTO memo_settlement_lines (tenant_id, settlement_id, memo_line_id, invoice_line_id, units, units_on_hand, units_sold,
                                       memo_unit_cost, invoice_unit_cost)
    VALUES (v_tenant, s.id, ml.id, il.id, v_units, v_hand, v_sold, v_cm, v_ci);
  END LOOP;

  v_jv := public._create_posted_jv(v_tenant, m.organisation_id, m.branch_id, CURRENT_DATE, 'JOURNAL', 'MEMO_SETTLEMENT', s.id,
            'Memo ' || m.memo_no || ' matched to invoice ' || inv.invoice_number, v_lines);
  UPDATE memo_settlements SET journal_voucher_id = v_jv WHERE id = s.id RETURNING * INTO s;
  RETURN s;
END $$;

-- ─── close_memo_units (return / waived) ───────────────────────
CREATE OR REPLACE FUNCTION public.close_memo_units(p_memo_line_id uuid, p_units numeric, p_mode text, p_reason text)
RETURNS memo_closures
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_tenant uuid := public.get_tenant_id();
  ml       memo_purchase_lines%ROWTYPE;
  m        memo_purchases%ROWTYPE;
  v_bal    numeric;
  v_val    numeric(15,2);
  v_jv     uuid;
  c        memo_closures%ROWTYPE;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.has_any_role(ARRAY['SUPER_ADMIN', 'BRANCH_ADMIN', 'ACCOUNTANT']) THEN
    RAISE EXCEPTION 'Only an admin or accountant can close memo units' USING ERRCODE = '42501';
  END IF;
  IF p_mode NOT IN ('RETURN', 'WAIVED') THEN RAISE EXCEPTION 'Mode must be RETURN or WAIVED'; END IF;
  IF COALESCE(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'A reason is required'; END IF;
  IF p_units IS NULL OR p_units <= 0 THEN RAISE EXCEPTION 'Units must be positive'; END IF;

  SELECT l.* INTO ml FROM memo_purchase_lines l JOIN memo_purchases h ON h.id = l.memo_id
   WHERE l.id = p_memo_line_id AND l.tenant_id = v_tenant AND h.status = 'POSTED' FOR UPDATE OF l;
  IF NOT FOUND THEN RAISE EXCEPTION 'Memo line not found'; END IF;
  SELECT * INTO m FROM memo_purchases WHERE id = ml.memo_id;
  IF p_units > ml.pending_units THEN RAISE EXCEPTION 'Only % unit(s) are still pending on this line', ml.pending_units; END IF;
  PERFORM public.assert_period_not_locked(v_tenant, m.organisation_id, CURRENT_DATE);

  v_val := round(p_units * ml.unit_cost, 2);

  IF p_mode = 'RETURN' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('stock:' || v_tenant::text || ':' || ml.product_id::text, 0));
    SELECT COALESCE(SUM(balance_qty), 0) INTO v_bal FROM stock_balance
     WHERE tenant_id = v_tenant AND batch_id = ml.batch_id AND location_id = m.received_at_location;
    IF v_bal < p_units THEN
      RAISE EXCEPTION 'Only % unit(s) of this memo batch are on hand at the receiving location - goods already sold cannot be returned', v_bal;
    END IF;
    INSERT INTO stock_ledger (tenant_id, organisation_id, branch_id, movement_type, movement_date, product_id, batch_id, from_location_id,
                              party_id, qty, unit_of_measure, rate_per_unit, source_document_type, source_document_id, source_document_no,
                              narration, created_by)
    VALUES (v_tenant, m.organisation_id, m.branch_id, 'RETURN_TO_SUPPLIER', CURRENT_DATE, ml.product_id, ml.batch_id, m.received_at_location,
            m.supplier_id, p_units, ml.unit_of_measure, ml.unit_cost, 'MEMO_RETURN', ml.id, m.memo_no,
            'Memo goods returned to supplier: ' || btrim(p_reason), auth.uid());
    IF v_val > 0 THEN
      v_jv := public._create_posted_jv(v_tenant, m.organisation_id, m.branch_id, CURRENT_DATE, 'JOURNAL', 'MEMO_RETURN', ml.id,
                'Memo ' || m.memo_no || ' goods returned: ' || btrim(p_reason),
                jsonb_build_array(jsonb_build_object('code', '2005', 'debit', v_val, 'party', m.supplier_id),
                                  jsonb_build_object('code', '1020', 'credit', v_val)));
    END IF;
    UPDATE memo_purchase_lines SET returned_units = returned_units + p_units WHERE id = ml.id;
  ELSE
    IF v_val > 0 THEN
      v_jv := public._create_posted_jv(v_tenant, m.organisation_id, m.branch_id, CURRENT_DATE, 'JOURNAL', 'MEMO_WAIVED', ml.id,
                'Memo ' || m.memo_no || ' invoice waived by supplier: ' || btrim(p_reason),
                jsonb_build_array(jsonb_build_object('code', '2005', 'debit', v_val, 'party', m.supplier_id),
                                  jsonb_build_object('code', '3020', 'credit', v_val)));
    END IF;
    UPDATE memo_purchase_lines SET waived_units = waived_units + p_units WHERE id = ml.id;
  END IF;

  INSERT INTO memo_closures (tenant_id, organisation_id, memo_line_id, mode, units, unit_cost, reason, journal_voucher_id, created_by)
  VALUES (v_tenant, m.organisation_id, ml.id, p_mode, p_units, ml.unit_cost, btrim(p_reason), v_jv, auth.uid())
  RETURNING * INTO c;
  RETURN c;
END $$;

-- ─── post_stock_journal ───────────────────────────────────────
-- p_out: [{"batch_id":"..","qty":n}]   p_in: [{"product_id":"..","qty":n,"batch_number":"..","manufacture_date":"..","expiry_date":".."}]
-- The total VALUE going out is carried onto the incoming batches (same cost per unit), so stock value is preserved.
CREATE OR REPLACE FUNCTION public.post_stock_journal(
  p_organisation_id uuid, p_date date, p_location_id uuid, p_reason text,
  p_out jsonb, p_in jsonb,
  p_memo_settlement_id uuid DEFAULT NULL, p_purchase_invoice_id uuid DEFAULT NULL
) RETURNS stock_journals
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_tenant uuid := public.get_tenant_id();
  j        stock_journals%ROWTYPE;
  e        jsonb;
  b        batch_register%ROWTYPE;
  p        products%ROWTYPE;
  v_qty    numeric;
  v_cost   numeric;
  v_bal    numeric;
  v_out_val numeric(15,2) := 0;
  v_in_qty numeric := 0;
  v_unit   numeric(15,4);
  v_n      int;
  v_bno    text;
  v_newb   uuid;
  v_seq    int := 0;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.has_any_role(ARRAY['SUPER_ADMIN', 'BRANCH_ADMIN', 'ACCOUNTANT']) THEN
    RAISE EXCEPTION 'Only an admin or accountant can post a stock journal' USING ERRCODE = '42501';
  END IF;
  IF COALESCE(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'A reason is required for a stock journal'; END IF;
  IF p_date IS NULL OR p_date > CURRENT_DATE THEN RAISE EXCEPTION 'Journal date cannot be in the future'; END IF;
  IF p_out IS NULL OR jsonb_typeof(p_out) <> 'array' OR jsonb_array_length(p_out) = 0 THEN RAISE EXCEPTION 'Add at least one product going out'; END IF;
  IF p_in  IS NULL OR jsonb_typeof(p_in)  <> 'array' OR jsonb_array_length(p_in)  = 0 THEN RAISE EXCEPTION 'Add at least one product coming in'; END IF;
  IF NOT EXISTS (SELECT 1 FROM organisations WHERE id = p_organisation_id AND tenant_id = v_tenant) THEN RAISE EXCEPTION 'Organisation not found'; END IF;
  IF NOT EXISTS (SELECT 1 FROM locations WHERE id = p_location_id AND tenant_id = v_tenant AND organisation_id = p_organisation_id) THEN
    RAISE EXCEPTION 'Location not found';
  END IF;
  PERFORM public.assert_period_not_locked(v_tenant, p_organisation_id, p_date);

  -- validate everything and total the outgoing value BEFORE writing anything
  FOR e IN SELECT * FROM jsonb_array_elements(p_out) LOOP
    SELECT * INTO b FROM batch_register WHERE id = (e->>'batch_id')::uuid AND tenant_id = v_tenant AND organisation_id = p_organisation_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'An outgoing batch was not found'; END IF;
    v_qty := (e->>'qty')::numeric;
    IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Outgoing quantities must be positive'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('stock:' || v_tenant::text || ':' || b.product_id::text, 0));
    SELECT COALESCE(SUM(balance_qty), 0) INTO v_bal FROM stock_balance
     WHERE tenant_id = v_tenant AND batch_id = b.id AND location_id = p_location_id;
    IF v_bal < v_qty THEN RAISE EXCEPTION 'Batch % has only % available at this location (need %)', b.batch_number, v_bal, v_qty; END IF;
    v_out_val := v_out_val + round(v_qty * COALESCE(b.landing_cost_per_unit, b.purchase_rate, 0), 2);
  END LOOP;
  FOR e IN SELECT * FROM jsonb_array_elements(p_in) LOOP
    IF NOT EXISTS (SELECT 1 FROM products WHERE id = (e->>'product_id')::uuid AND tenant_id = v_tenant AND organisation_id = p_organisation_id) THEN
      RAISE EXCEPTION 'An incoming product was not found';
    END IF;
    v_qty := (e->>'qty')::numeric;
    IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Incoming quantities must be positive'; END IF;
    v_in_qty := v_in_qty + v_qty;
  END LOOP;
  v_unit := round(v_out_val / v_in_qty, 4);

  PERFORM pg_advisory_xact_lock(hashtextextended('stock_journal:' || p_organisation_id::text, 0));
  SELECT COALESCE(MAX(NULLIF(regexp_replace(journal_no, '^SJ-\d{4}-', ''), '')::int), 0) + 1 INTO v_n
    FROM stock_journals WHERE tenant_id = v_tenant AND organisation_id = p_organisation_id
     AND journal_no LIKE 'SJ-' || to_char(p_date, 'YYYY') || '-%';

  INSERT INTO stock_journals (tenant_id, organisation_id, journal_no, journal_date, location_id, reason, memo_settlement_id,
                              purchase_invoice_id, total_value, created_by)
  VALUES (v_tenant, p_organisation_id, 'SJ-' || to_char(p_date, 'YYYY') || '-' || lpad(v_n::text, 5, '0'), p_date, p_location_id,
          btrim(p_reason), p_memo_settlement_id, p_purchase_invoice_id, v_out_val, auth.uid())
  RETURNING * INTO j;

  FOR e IN SELECT * FROM jsonb_array_elements(p_out) LOOP
    SELECT * INTO b FROM batch_register WHERE id = (e->>'batch_id')::uuid;
    v_qty  := (e->>'qty')::numeric;
    v_cost := COALESCE(b.landing_cost_per_unit, b.purchase_rate, 0);
    INSERT INTO stock_ledger (tenant_id, organisation_id, movement_type, movement_date, product_id, batch_id, from_location_id, qty, unit_of_measure,
                              rate_per_unit, source_document_type, source_document_id, source_document_no, narration, created_by)
    VALUES (v_tenant, p_organisation_id, 'ADJ_DECREASE', p_date, b.product_id, b.id, p_location_id, v_qty, b.unit_of_measure, v_cost,
            'STOCK_JOURNAL', j.id, j.journal_no, 'Stock journal out: ' || btrim(p_reason), auth.uid());
    INSERT INTO stock_journal_lines (tenant_id, journal_id, direction, product_id, batch_id, qty, unit_cost, value)
    VALUES (v_tenant, j.id, 'OUT', b.product_id, b.id, v_qty, v_cost, round(v_qty * v_cost, 2));
  END LOOP;

  FOR e IN SELECT * FROM jsonb_array_elements(p_in) LOOP
    v_seq := v_seq + 1;
    SELECT * INTO p FROM products WHERE id = (e->>'product_id')::uuid;
    v_qty := (e->>'qty')::numeric;
    v_bno := COALESCE(NULLIF(btrim(e->>'batch_number'), ''), j.journal_no || '-L' || v_seq);
    IF EXISTS (SELECT 1 FROM batch_register WHERE tenant_id = v_tenant AND organisation_id = p_organisation_id AND product_id = p.id AND batch_number = v_bno) THEN
      RAISE EXCEPTION 'Batch % already exists for %. Stock coming in through a journal always starts a new batch', v_bno, p.name;
    END IF;
    INSERT INTO batch_register (tenant_id, organisation_id, batch_number, product_id, location_id, opening_qty, current_qty, unit_of_measure,
                                purchase_rate, purchase_rate_with_tax, landing_cost_per_unit, manufacture_date, expiry_date, status, created_by)
    VALUES (v_tenant, p_organisation_id, v_bno, p.id, p_location_id, v_qty, 0, p.unit_of_measure, v_unit, v_unit, v_unit,
            NULLIF(e->>'manufacture_date', '')::date, NULLIF(e->>'expiry_date', '')::date, 'OPEN', auth.uid())
    RETURNING id INTO v_newb;
    INSERT INTO stock_ledger (tenant_id, organisation_id, movement_type, movement_date, product_id, batch_id, to_location_id, qty, unit_of_measure,
                              rate_per_unit, source_document_type, source_document_id, source_document_no, narration, created_by)
    VALUES (v_tenant, p_organisation_id, 'ADJ_INCREASE', p_date, p.id, v_newb, p_location_id, v_qty, p.unit_of_measure, v_unit,
            'STOCK_JOURNAL', j.id, j.journal_no, 'Stock journal in: ' || btrim(p_reason), auth.uid());
    INSERT INTO stock_journal_lines (tenant_id, journal_id, direction, product_id, batch_id, qty, unit_cost, value)
    VALUES (v_tenant, j.id, 'IN', p.id, v_newb, v_qty, v_unit, round(v_qty * v_unit, 2));
  END LOOP;
  RETURN j;
END $$;

REVOKE ALL ON FUNCTION public.post_memo_purchase(uuid), public.settle_memo_with_invoice(uuid,uuid,jsonb,text),
  public.close_memo_units(uuid,numeric,text,text),
  public.post_stock_journal(uuid,date,uuid,text,jsonb,jsonb,uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_memo_purchase(uuid), public.settle_memo_with_invoice(uuid,uuid,jsonb,text),
  public.close_memo_units(uuid,numeric,text,text),
  public.post_stock_journal(uuid,date,uuid,text,jsonb,jsonb,uuid,uuid) TO authenticated;

-- ─── Views ────────────────────────────────────────────────────
-- Invoices still to come, line by line
CREATE OR REPLACE VIEW vw_memo_pending WITH (security_invoker = true) AS
SELECT m.tenant_id, m.organisation_id, m.id AS memo_id, m.memo_no, m.memo_date, m.supplier_id, s.name AS supplier_name,
       m.supplier_ref, m.received_at_location, loc.name AS location_name,
       l.id AS memo_line_id, l.line_no, l.product_id, p.name AS product_name, p.product_code, l.batch_id, l.unit_of_measure,
       l.total_units, l.settled_units, l.returned_units, l.waived_units, l.pending_units, l.unit_cost,
       round(l.pending_units * l.unit_cost, 2) AS pending_value,
       (CURRENT_DATE - m.memo_date) AS age_days
  FROM memo_purchase_lines l
  JOIN memo_purchases m ON m.id = l.memo_id
  JOIN parties s ON s.id = m.supplier_id
  JOIN products p ON p.id = l.product_id
  JOIN locations loc ON loc.id = m.received_at_location
 WHERE m.status = 'POSTED' AND l.pending_units > 0;
GRANT SELECT ON vw_memo_pending TO authenticated;

-- Per supplier: what invoice value is still owed to us as paperwork
CREATE OR REPLACE VIEW vw_memo_pending_by_supplier WITH (security_invoker = true) AS
SELECT tenant_id, organisation_id, supplier_id, supplier_name,
       COUNT(DISTINCT memo_id) AS open_memos, SUM(pending_units) AS pending_units,
       SUM(pending_value) AS pending_value, MIN(memo_date) AS oldest_memo_date, MAX(age_days) AS oldest_age_days
  FROM vw_memo_pending GROUP BY tenant_id, organisation_id, supplier_id, supplier_name;
GRANT SELECT ON vw_memo_pending_by_supplier TO authenticated;
