-- ============================================================
-- Migration 044: C&F custody - transfer engine hardening, C&F stock, confirmations
-- FertiLedger ERP
-- ============================================================
-- 1. Stock-transfer engine (027/028) fixes:
--    * rpc_dispatch/receive trusted caller-supplied tenant/user ids (SECURITY DEFINER) -> now must match the session.
--    * Users could set transfer status (IN_TRANSIT/RECEIVED) directly with no stock movement -> RLS lock-down;
--      only the functions move a transfer past DRAFT/APPROVED.
--    * Availability was checked per line, so two lines of the same batch could oversell -> checked per product+batch.
--    * Receipt always took the full dispatched quantity -> receive_stock_transfer() records received / damaged /
--      shortage per line and writes off the loss at cost (Transit Loss 4050).
--    * Withdrawals from a C&F agent (CNF_*) now need an approval step with the company's approval reference.
-- 2. C&F stock is DERIVED from the stock ledger (vw_cf_stock) - never keyed in by hand.
-- 3. cf_stock_register becomes the record of the agent's latest CONFIRMED count; every confirmation is also
--    appended to cf_stock_confirmations (audit). Variances need a remark.

ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS approved_at timestamptz;
ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES auth.users(id);
ALTER TABLE stock_transfers ADD COLUMN IF NOT EXISTS receipt_remarks text;

-- Transit Loss / Shortage account for already-seeded tenants
INSERT INTO chart_of_accounts (tenant_id, organisation_id, account_code, account_name, account_type, account_group,
                               is_control_account, opening_balance, opening_balance_type, is_system)
SELECT d.tenant_id, d.organisation_id, '4050', 'Transit Loss / Stock Shortage', 'EXPENSE', 'Indirect Expenses', false, 0, 'DR', true
  FROM chart_of_accounts d
 WHERE d.account_code = '1010'
   AND NOT EXISTS (SELECT 1 FROM chart_of_accounts x WHERE x.tenant_id = d.tenant_id AND x.account_code = '4050');

-- ─── RLS lock-down: transfers ─────────────────────────────────
DROP POLICY IF EXISTS stock_transfers_tenant_insert ON stock_transfers;
DROP POLICY IF EXISTS stock_transfers_tenant_update ON stock_transfers;
CREATE POLICY stock_transfers_tenant_insert ON stock_transfers FOR INSERT
  WITH CHECK (tenant_id = public.get_tenant_id() AND status = 'DRAFT');
CREATE POLICY stock_transfers_tenant_update ON stock_transfers FOR UPDATE
  USING      (tenant_id = public.get_tenant_id() AND status IN ('DRAFT', 'APPROVED'))
  WITH CHECK (tenant_id = public.get_tenant_id() AND status IN ('DRAFT', 'CANCELLED'));
  -- APPROVED is set only by approve_stock_transfer()

DROP POLICY IF EXISTS transfer_items_tenant_insert ON stock_transfer_items;
DROP POLICY IF EXISTS transfer_items_tenant_update ON stock_transfer_items;
CREATE POLICY transfer_items_tenant_insert ON stock_transfer_items FOR INSERT
  WITH CHECK (tenant_id = public.get_tenant_id() AND dispatched_qty = 0 AND received_qty = 0
              AND shortage_qty = 0 AND damaged_qty = 0
              AND EXISTS (SELECT 1 FROM stock_transfers h WHERE h.id = transfer_id AND h.status = 'DRAFT'));
CREATE POLICY transfer_items_tenant_update ON stock_transfer_items FOR UPDATE
  USING      (tenant_id = public.get_tenant_id()
              AND EXISTS (SELECT 1 FROM stock_transfers h WHERE h.id = transfer_id AND h.status = 'DRAFT'))
  WITH CHECK (tenant_id = public.get_tenant_id() AND dispatched_qty = 0 AND received_qty = 0
              AND shortage_qty = 0 AND damaged_qty = 0);

-- ─── approve_stock_transfer ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.approve_stock_transfer(p_transfer_id uuid, p_approval_ref text DEFAULT NULL)
RETURNS stock_transfers
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_tenant uuid := public.get_tenant_id();
  t        stock_transfers%ROWTYPE;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT * INTO t FROM stock_transfers WHERE id = p_transfer_id AND tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Stock transfer not found'; END IF;
  IF t.status <> 'DRAFT' THEN RAISE EXCEPTION 'Only DRAFT transfers can be approved (status: %)', t.status; END IF;
  IF NOT EXISTS (SELECT 1 FROM stock_transfer_items WHERE transfer_id = p_transfer_id) THEN
    RAISE EXCEPTION 'Transfer has no items';
  END IF;

  IF t.transfer_type IN ('CNF_TO_OWN_WAREHOUSE', 'CNF_DIRECT_TO_CUSTOMER') THEN
    IF COALESCE(btrim(p_approval_ref), btrim(t.cnf_company_approval_ref), '') = '' THEN
      RAISE EXCEPTION 'A company approval reference is required to withdraw stock from a C&F agent';
    END IF;
    IF COALESCE(btrim(t.cnf_withdrawal_req_no), '') = '' THEN
      RAISE EXCEPTION 'The C&F withdrawal request number is required';
    END IF;
  END IF;

  UPDATE stock_transfers SET status = 'APPROVED', approved_at = now(), approved_by = auth.uid(), updated_by = auth.uid(),
         cnf_company_approval_ref = COALESCE(NULLIF(btrim(p_approval_ref), ''), cnf_company_approval_ref)
   WHERE id = p_transfer_id RETURNING * INTO t;
  RETURN t;
END $$;

-- ─── dispatch (same signature; now session-checked and race-safe) ──
CREATE OR REPLACE FUNCTION public.rpc_dispatch_stock_transfer(p_tenant_id uuid, p_transfer_id uuid, p_user_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  t        stock_transfers%ROWTYPE;
  r        record;
  i        record;
  b        batch_register%ROWTYPE;
  v_have   numeric;
BEGIN
  IF p_tenant_id IS DISTINCT FROM public.get_tenant_id() OR p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO t FROM stock_transfers WHERE id = p_transfer_id AND tenant_id = p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Stock transfer not found'; END IF;
  IF t.status NOT IN ('DRAFT', 'APPROVED') THEN
    RAISE EXCEPTION 'Only DRAFT or APPROVED transfers can be dispatched (current: %)', t.status;
  END IF;
  IF t.transfer_type IN ('CNF_TO_OWN_WAREHOUSE', 'CNF_DIRECT_TO_CUSTOMER') AND t.status <> 'APPROVED' THEN
    RAISE EXCEPTION 'A C&F withdrawal must be approved (with the company approval reference) before dispatch';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM stock_transfer_items WHERE transfer_id = p_transfer_id) THEN
    RAISE EXCEPTION 'Transfer has no items';
  END IF;

  IF (SELECT COUNT(*) FROM locations WHERE id IN (t.source_location_id, t.destination_location_id)
        AND tenant_id = p_tenant_id AND organisation_id = t.organisation_id) <> 2 THEN
    RAISE EXCEPTION 'Source or destination location not found';
  END IF;
  PERFORM public.assert_period_not_locked(p_tenant_id, t.organisation_id, t.transfer_date);

  -- batch ownership
  IF EXISTS (SELECT 1 FROM stock_transfer_items it
              LEFT JOIN batch_register bb ON bb.id = it.source_batch_id AND bb.tenant_id = p_tenant_id AND bb.product_id = it.product_id
             WHERE it.transfer_id = p_transfer_id AND bb.id IS NULL) THEN
    RAISE EXCEPTION 'A transfer line references an unknown batch';
  END IF;

  -- availability per product+batch (summed across lines), serialised per product
  FOR r IN
    SELECT product_id, source_batch_id, SUM(requested_qty) AS need
      FROM stock_transfer_items WHERE transfer_id = p_transfer_id
     GROUP BY product_id, source_batch_id ORDER BY product_id, source_batch_id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('stock:' || p_tenant_id::text || ':' || r.product_id::text, 0));
    SELECT COALESCE(SUM(balance_qty), 0) INTO v_have FROM stock_balance
     WHERE tenant_id = p_tenant_id AND organisation_id = t.organisation_id AND product_id = r.product_id
       AND batch_id = r.source_batch_id AND location_id = t.source_location_id;
    IF v_have < r.need THEN
      SELECT * INTO b FROM batch_register WHERE id = r.source_batch_id;
      RAISE EXCEPTION 'Insufficient stock in batch % at the source location (available %, requested %)', b.batch_number, v_have, r.need;
    END IF;
  END LOOP;

  FOR i IN SELECT * FROM stock_transfer_items WHERE transfer_id = p_transfer_id LOOP
    SELECT * INTO b FROM batch_register WHERE id = i.source_batch_id;
    UPDATE stock_transfer_items
       SET dispatched_qty = requested_qty,
           unit_cost = CASE WHEN unit_cost > 0 THEN unit_cost
                            ELSE COALESCE(b.landing_cost_per_unit, b.purchase_rate, 0) END
     WHERE id = i.id;
    UPDATE batch_register SET current_qty = current_qty - i.requested_qty, updated_by = p_user_id WHERE id = i.source_batch_id;

    INSERT INTO stock_ledger (
      tenant_id, organisation_id, branch_id, movement_type, movement_date, product_id, batch_id,
      from_location_id, to_location_id, qty, unit_of_measure, rate_per_unit,
      source_document_type, source_document_id, source_document_no, narration, created_by)
    VALUES (p_tenant_id, t.organisation_id, t.branch_id, 'TRANSFER_OUT', t.transfer_date, i.product_id, i.source_batch_id,
      t.source_location_id, t.destination_location_id, i.requested_qty, i.unit_of_measure,
      CASE WHEN i.unit_cost > 0 THEN i.unit_cost ELSE COALESCE(b.landing_cost_per_unit, b.purchase_rate, 0) END,
      'TRANSFER', t.id, t.transfer_no, 'Stock transfer out: ' || t.transfer_no, p_user_id);
  END LOOP;

  UPDATE stock_transfers SET status = 'IN_TRANSIT', dispatched_at = now(), dispatched_by = p_user_id, updated_by = p_user_id
   WHERE id = p_transfer_id;
END $$;

-- ─── receive_stock_transfer: per-line received / damaged, shortage derived ──
-- p_items: [{"item_id":"..","received":n,"damaged":n}]; NULL = everything arrived intact.
CREATE OR REPLACE FUNCTION public.receive_stock_transfer(p_transfer_id uuid, p_items jsonb DEFAULT NULL, p_remarks text DEFAULT NULL)
RETURNS stock_transfers
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_tenant uuid := public.get_tenant_id();
  t        stock_transfers%ROWTYPE;
  i        record;
  b        batch_register%ROWTYPE;
  e        jsonb;
  v_recv   numeric;
  v_dmg    numeric;
  v_short  numeric;
  v_lost   numeric;
  v_cost   numeric;
  v_loss   numeric(18,2) := 0;
  v_lines  jsonb := '[]'::jsonb;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT * INTO t FROM stock_transfers WHERE id = p_transfer_id AND tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Stock transfer not found'; END IF;
  IF t.status <> 'IN_TRANSIT' THEN RAISE EXCEPTION 'Only IN_TRANSIT transfers can be received (current: %)', t.status; END IF;
  PERFORM public.assert_period_not_locked(v_tenant, t.organisation_id, CURRENT_DATE);

  FOR i IN SELECT * FROM stock_transfer_items WHERE transfer_id = p_transfer_id ORDER BY created_at, id LOOP
    v_recv := i.dispatched_qty; v_dmg := 0;
    IF p_items IS NOT NULL THEN
      SELECT x INTO e FROM jsonb_array_elements(p_items) x WHERE (x->>'item_id')::uuid = i.id LIMIT 1;
      IF e IS NULL THEN RAISE EXCEPTION 'Receipt details are missing for one of the transfer lines'; END IF;
      v_recv := COALESCE((e->>'received')::numeric, 0);
      v_dmg  := COALESCE((e->>'damaged')::numeric, 0);
    END IF;
    IF v_recv < 0 OR v_dmg < 0 THEN RAISE EXCEPTION 'Received and damaged quantities cannot be negative'; END IF;
    IF v_recv + v_dmg > i.dispatched_qty THEN
      RAISE EXCEPTION 'Received (%) + damaged (%) exceeds the dispatched quantity (%)', v_recv, v_dmg, i.dispatched_qty;
    END IF;
    v_short := i.dispatched_qty - v_recv - v_dmg;
    v_lost  := v_dmg + v_short;

    SELECT * INTO b FROM batch_register WHERE id = i.source_batch_id;
    v_cost := CASE WHEN i.unit_cost > 0 THEN i.unit_cost ELSE COALESCE(b.landing_cost_per_unit, b.purchase_rate, 0) END;

    UPDATE stock_transfer_items SET received_qty = v_recv, damaged_qty = v_dmg, shortage_qty = v_short,
           dest_batch_id = i.source_batch_id WHERE id = i.id;

    -- full dispatched quantity arrives, then whatever did not arrive intact is written off at the destination
    INSERT INTO stock_ledger (
      tenant_id, organisation_id, branch_id, movement_type, movement_date, product_id, batch_id,
      from_location_id, to_location_id, qty, unit_of_measure, rate_per_unit,
      source_document_type, source_document_id, source_document_no, narration, created_by)
    VALUES (v_tenant, t.organisation_id, t.branch_id, 'TRANSFER_IN', CURRENT_DATE, i.product_id, i.source_batch_id,
      t.source_location_id, t.destination_location_id, i.dispatched_qty, i.unit_of_measure, v_cost,
      'TRANSFER', t.id, t.transfer_no, 'Stock transfer in: ' || t.transfer_no, auth.uid());

    UPDATE batch_register SET current_qty = current_qty + i.dispatched_qty, updated_by = auth.uid(),
           status = CASE WHEN status = 'CLOSED' THEN 'OPEN'::batch_status_enum ELSE status END
     WHERE id = i.source_batch_id;

    IF v_lost > 0 THEN
      INSERT INTO stock_ledger (
        tenant_id, organisation_id, branch_id, movement_type, movement_date, product_id, batch_id,
        from_location_id, qty, unit_of_measure, rate_per_unit,
        source_document_type, source_document_id, source_document_no, narration, created_by)
      VALUES (v_tenant, t.organisation_id, t.branch_id,
        CASE WHEN v_dmg >= v_short AND v_dmg > 0 THEN 'DAMAGE_WRITE_OFF' ELSE 'ADJ_DECREASE' END::stock_movement_type,
        CURRENT_DATE, i.product_id, i.source_batch_id, t.destination_location_id, v_lost, i.unit_of_measure, v_cost,
        'TRANSFER', t.id, t.transfer_no,
        'Transit loss on ' || t.transfer_no || ' (damaged ' || v_dmg || ', short ' || v_short || ')', auth.uid());
      v_loss := v_loss + round(v_lost * v_cost, 2);
    END IF;
  END LOOP;

  IF v_loss > 0 THEN
    v_lines := jsonb_build_array(jsonb_build_object('code', '4050', 'debit', v_loss),
                                 jsonb_build_object('code', '1020', 'credit', v_loss));
    PERFORM public._create_posted_jv(v_tenant, t.organisation_id, t.branch_id, CURRENT_DATE, 'JOURNAL',
              'STOCK_TRANSFER', p_transfer_id, 'Transit loss - transfer ' || t.transfer_no, v_lines);
  END IF;

  UPDATE stock_transfers SET status = 'RECEIVED', received_at = now(), received_by = auth.uid(), updated_by = auth.uid(),
         receipt_remarks = NULLIF(btrim(p_remarks), '')
   WHERE id = p_transfer_id RETURNING * INTO t;
  RETURN t;
END $$;

-- legacy entry point: full, intact receipt
CREATE OR REPLACE FUNCTION public.rpc_receive_stock_transfer(p_tenant_id uuid, p_transfer_id uuid, p_user_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
BEGIN
  IF p_tenant_id IS DISTINCT FROM public.get_tenant_id() OR p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;
  PERFORM public.receive_stock_transfer(p_transfer_id, NULL, NULL);
END $$;

REVOKE ALL ON FUNCTION public.approve_stock_transfer(uuid,text), public.receive_stock_transfer(uuid,jsonb,text),
  public.rpc_dispatch_stock_transfer(uuid,uuid,uuid), public.rpc_receive_stock_transfer(uuid,uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_stock_transfer(uuid,text), public.receive_stock_transfer(uuid,jsonb,text),
  public.rpc_dispatch_stock_transfer(uuid,uuid,uuid), public.rpc_receive_stock_transfer(uuid,uuid,uuid) TO authenticated;

-- ─── C&F stock (derived from the ledger) ──────────────────────
-- Stock sitting at C&F depots / third-party locations. The custodian (agent) is the location's custodian_party_id.
CREATE OR REPLACE VIEW vw_cf_stock WITH (security_invoker = true) AS
SELECT
  sb.tenant_id, sb.organisation_id,
  sb.location_id, l.name AS location_name, l.location_type::text AS location_type,
  l.custodian_party_id AS cf_agent_id, a.name AS cf_agent_name,
  l.stock_confirmation_freq_days,
  sb.product_id, p.name AS product_name, p.product_code, p.unit_of_measure,
  sb.batch_id, bt.batch_number, bt.expiry_date,
  sb.balance_qty AS system_qty,
  sb.last_movement_date,
  r.qty_confirmed, r.qty_held AS qty_at_confirmation, r.last_confirmed_date, r.next_confirmation_due,
  r.confirmation_ref, r.discrepancy_noted, r.discrepancy_remarks,
  (sb.balance_qty - COALESCE(r.qty_confirmed, sb.balance_qty)) AS unconfirmed_difference,
  CASE
    WHEN r.id IS NULL                                                    THEN 'NEVER_CONFIRMED'
    WHEN r.next_confirmation_due IS NOT NULL AND r.next_confirmation_due < CURRENT_DATE THEN 'CONFIRMATION_OVERDUE'
    WHEN sb.balance_qty <> r.qty_held                                    THEN 'CHANGED_SINCE_CONFIRMED'
    WHEN r.discrepancy_noted                                             THEN 'DISCREPANCY'
    ELSE 'CONFIRMED'
  END AS confirmation_status
FROM stock_balance sb
JOIN locations l  ON l.id = sb.location_id AND l.location_type IN ('CF_DEPOT', 'THIRD_PARTY')
JOIN products p   ON p.id = sb.product_id
LEFT JOIN batch_register bt ON bt.id = sb.batch_id
LEFT JOIN parties a ON a.id = l.custodian_party_id
LEFT JOIN cf_stock_register r
       ON r.tenant_id = sb.tenant_id AND r.location_id = sb.location_id AND r.product_id = sb.product_id
      AND r.batch_id IS NOT DISTINCT FROM sb.batch_id
WHERE sb.balance_qty <> 0 OR r.id IS NOT NULL;
GRANT SELECT ON vw_cf_stock TO authenticated;

-- ─── Confirmations ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cf_stock_confirmations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  organisation_id  uuid NOT NULL REFERENCES organisations(id),
  cf_agent_id      uuid NOT NULL REFERENCES parties(id),
  location_id      uuid NOT NULL REFERENCES locations(id),
  product_id       uuid NOT NULL REFERENCES products(id),
  batch_id         uuid REFERENCES batch_register(id),
  confirmed_on     date NOT NULL DEFAULT CURRENT_DATE,
  system_qty       numeric(15,3) NOT NULL,
  confirmed_qty    numeric(15,3) NOT NULL CHECK (confirmed_qty >= 0),
  variance_qty     numeric(15,3) GENERATED ALWAYS AS (system_qty - confirmed_qty) STORED,
  confirmation_ref text,
  remarks          text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES auth.users(id)
);
CREATE INDEX IF NOT EXISTS idx_cf_conf_key ON cf_stock_confirmations(location_id, product_id, confirmed_on DESC);
ALTER TABLE cf_stock_confirmations ENABLE ROW LEVEL SECURITY;
CREATE POLICY cfc_select ON cf_stock_confirmations FOR SELECT USING (tenant_id = public.get_tenant_id());

-- the register becomes read-only for users; record_cf_confirmation() maintains it
DROP POLICY IF EXISTS cf_stock_tenant_insert ON cf_stock_register;
DROP POLICY IF EXISTS cf_stock_tenant_update ON cf_stock_register;
REVOKE ALL ON cf_stock_register, cf_stock_confirmations FROM anon, authenticated;
GRANT SELECT ON cf_stock_register, cf_stock_confirmations TO authenticated;

CREATE OR REPLACE FUNCTION public.record_cf_confirmation(
  p_location_id     uuid,
  p_product_id      uuid,
  p_batch_id        uuid,
  p_confirmed_qty   numeric,
  p_confirmation_ref text DEFAULT NULL,
  p_remarks         text DEFAULT NULL,
  p_confirmed_on    date DEFAULT CURRENT_DATE
) RETURNS cf_stock_confirmations
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_tenant uuid := public.get_tenant_id();
  l        locations%ROWTYPE;
  p        products%ROWTYPE;
  v_sys    numeric;
  v_reg    uuid;
  c        cf_stock_confirmations%ROWTYPE;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_confirmed_qty IS NULL OR p_confirmed_qty < 0 THEN RAISE EXCEPTION 'Confirmed quantity cannot be negative'; END IF;
  IF p_confirmed_on IS NULL OR p_confirmed_on > CURRENT_DATE THEN RAISE EXCEPTION 'Confirmation date cannot be in the future'; END IF;

  SELECT * INTO l FROM locations WHERE id = p_location_id AND tenant_id = v_tenant;
  IF NOT FOUND THEN RAISE EXCEPTION 'Location not found'; END IF;
  IF l.location_type NOT IN ('CF_DEPOT', 'THIRD_PARTY') THEN RAISE EXCEPTION 'This is not a C&F / third-party location'; END IF;
  IF l.custodian_party_id IS NULL THEN
    RAISE EXCEPTION 'Set the custodian (C&F agent) on location "%" before recording confirmations', l.name;
  END IF;
  SELECT * INTO p FROM products WHERE id = p_product_id AND tenant_id = v_tenant;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;
  IF p_batch_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM batch_register WHERE id = p_batch_id AND tenant_id = v_tenant AND product_id = p_product_id) THEN
    RAISE EXCEPTION 'Batch not found for this product';
  END IF;

  SELECT COALESCE(SUM(balance_qty), 0) INTO v_sys FROM stock_balance
   WHERE tenant_id = v_tenant AND location_id = p_location_id AND product_id = p_product_id
     AND batch_id IS NOT DISTINCT FROM p_batch_id;

  IF v_sys <> p_confirmed_qty AND COALESCE(btrim(p_remarks), '') = '' THEN
    RAISE EXCEPTION 'The agent''s count (%) differs from the system (%) - enter a remark explaining the difference', p_confirmed_qty, v_sys;
  END IF;

  INSERT INTO cf_stock_confirmations (tenant_id, organisation_id, cf_agent_id, location_id, product_id, batch_id,
                                      confirmed_on, system_qty, confirmed_qty, confirmation_ref, remarks, created_by)
  VALUES (v_tenant, l.organisation_id, l.custodian_party_id, p_location_id, p_product_id, p_batch_id,
          p_confirmed_on, v_sys, p_confirmed_qty, NULLIF(btrim(p_confirmation_ref), ''), NULLIF(btrim(p_remarks), ''), auth.uid())
  RETURNING * INTO c;

  SELECT id INTO v_reg FROM cf_stock_register
   WHERE tenant_id = v_tenant AND location_id = p_location_id AND product_id = p_product_id
     AND batch_id IS NOT DISTINCT FROM p_batch_id FOR UPDATE;
  IF v_reg IS NULL THEN
    INSERT INTO cf_stock_register (tenant_id, organisation_id, cf_agent_id, location_id, product_id, batch_id, qty_held, qty_confirmed,
                                   unit_of_measure, last_confirmed_date, next_confirmation_due, confirmation_ref,
                                   is_reconciled, discrepancy_noted, discrepancy_remarks, created_by, updated_by)
    VALUES (v_tenant, l.organisation_id, l.custodian_party_id, p_location_id, p_product_id, p_batch_id, GREATEST(v_sys, 0), p_confirmed_qty,
            p.unit_of_measure, p_confirmed_on, p_confirmed_on + COALESCE(l.stock_confirmation_freq_days, 30), NULLIF(btrim(p_confirmation_ref), ''),
            v_sys = p_confirmed_qty, v_sys <> p_confirmed_qty, NULLIF(btrim(p_remarks), ''), auth.uid(), auth.uid());
  ELSE
    UPDATE cf_stock_register SET cf_agent_id = l.custodian_party_id, qty_held = GREATEST(v_sys, 0), qty_confirmed = p_confirmed_qty,
           last_confirmed_date = p_confirmed_on, next_confirmation_due = p_confirmed_on + COALESCE(l.stock_confirmation_freq_days, 30),
           confirmation_ref = NULLIF(btrim(p_confirmation_ref), ''), is_reconciled = (v_sys = p_confirmed_qty),
           discrepancy_noted = (v_sys <> p_confirmed_qty), discrepancy_remarks = NULLIF(btrim(p_remarks), ''), updated_by = auth.uid()
     WHERE id = v_reg;
  END IF;
  RETURN c;
END $$;
REVOKE ALL ON FUNCTION public.record_cf_confirmation(uuid,uuid,uuid,numeric,text,text,date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_cf_confirmation(uuid,uuid,uuid,numeric,text,text,date) TO authenticated;
